import { setTimeout as sleep } from "node:timers/promises";
import { providerRuntime } from "../providers/providerRuntime.js";
import { sanitizeSensitiveData } from "../../utils/sanitize.js";
import { LlamaCppProvider } from "./llamaCppProvider.js";
export { LlamaCppProvider } from "./llamaCppProvider.js";

import { AiProviderError, UNBOUNDED_QUOTA, isLoopbackHost, parseBaseUrl, parseStructuredContent, resolveRequestId, buildResponseMetadata } from "./aiProviderUtils.js";
export { AiProviderError } from "./aiProviderUtils.js";

const STRUCTURED_OUTPUT_MODES = new Set(["guided-json", "response-format"]);

export class NoopAiProvider {
  constructor() {
    this.name = "none";
    this.enabled = false;
  }

  modelForKind() { return null; }
  getMetrics() { return { calls: 0, attempts: 0, retries: 0, success: 0, errors: 0 }; }
  async generate() { throw new AiProviderError("AI_PROVIDER_DISABLED", "AI provider is disabled."); }
}

export class MockAiProvider {
  constructor({ handler, model = "mock-grounded-v1" } = {}) {
    this.name = "mock";
    this.enabled = true;
    this.handler = handler || (() => { throw new AiProviderError("MOCK_HANDLER_MISSING", "Mock AI handler is not configured."); });
    this.model = model;
    this.calls = [];
  }

  modelForKind() { return this.model; }
  getMetrics() { return { calls: this.calls.length, attempts: this.calls.length, retries: 0, success: this.calls.length, errors: 0 }; }
  async generate(request) {
    this.calls.push(structuredClone({ kind: request.kind, inputHash: request.inputHash, model: this.model }));
    const output = await this.handler(request);
    return { output, provider: this.name, model: this.model, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
}

function structuredOutputPayload(mode, schema) {
  if (mode === "guided-json") return { guided_json: schema };
  return {
    response_format: {
      type: "json_schema",
      schema: JSON.stringify(schema)
    }
  };
}

export class NvidiaNimProvider {
  constructor({
    baseUrl,
    apiKey = "",
    summaryModel,
    reasoningModel,
    timeoutMs = 20_000,
    maxRetries = 1,
    maxOutputTokens = 1_200,
    concurrency = 1,
    structuredOutputMode = "guided-json",
    pollIntervalMs = 250,
    runtime = providerRuntime,
    wait = sleep
  } = {}) {
    this.name = "nvidia";
    this.enabled = true;
    this.baseUrl = parseBaseUrl(baseUrl || "https://integrate.api.nvidia.com/v1");
    this.apiKey = String(apiKey || "").trim();
    this.summaryModel = String(summaryModel || "").trim();
    this.reasoningModel = String(reasoningModel || summaryModel || "").trim();
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 20_000);
    this.maxRetries = Math.max(0, Math.min(1, Number(maxRetries) || 0));
    this.maxOutputTokens = Math.max(128, Number(maxOutputTokens) || 1_200);
    this.concurrency = Math.max(1, Math.min(2, Number(concurrency) || 1));
    this.structuredOutputMode = String(structuredOutputMode || "guided-json").trim().toLowerCase();
    this.pollIntervalMs = Math.max(50, Math.min(2_000, Number(pollIntervalMs) || 250));
    this.runtime = runtime;
    this.wait = wait;
    if (!STRUCTURED_OUTPUT_MODES.has(this.structuredOutputMode)) {
      throw new AiProviderError("AI_STRUCTURED_OUTPUT_MODE_INVALID", "Unsupported NVIDIA structured output mode.");
    }
    if (!this.summaryModel || !this.reasoningModel) throw new AiProviderError("AI_MODEL_REQUIRED", "NVIDIA model configuration is required.");
    if (!isLoopbackHost(this.baseUrl.hostname) && !this.apiKey) throw new AiProviderError("NVIDIA_API_KEY_REQUIRED", "NVIDIA API key is required for a remote endpoint.");
  }

  modelForKind(kind) {
    return kind === "article_summary" ? this.summaryModel : this.reasoningModel;
  }

  getMetrics() {
    return {
      ...(this.runtime.getMetrics?.("nvidia") || {}),
      structuredOutputMode: this.structuredOutputMode,
      circuit: this.runtime.getCircuitSnapshot?.("nvidia") || null
    };
  }

  async resolveAsyncResponse(initialResponse, { headers, model, kind, inputHash, deadline }) {
    let response = initialResponse;
    let requestId = resolveRequestId(response);
    let pollCount = 0;
    const maxPolls = Math.max(1, Math.ceil(this.timeoutMs / this.pollIntervalMs));

    while (true) {
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new AiProviderError("AI_INVALID_RESPONSE_JSON", "NVIDIA returned an invalid response envelope.", {
          cause: error,
          responseMetadata: buildResponseMetadata({ response, requestedModel: model, fallbackRequestId: requestId, pollCount })
        });
      }
      const responseMetadata = buildResponseMetadata({ payload, response, requestedModel: model, fallbackRequestId: requestId, pollCount });
      requestId = responseMetadata.requestId;
      if (response.status !== 202) return { payload, responseMetadata };
      if (!requestId) {
        throw new AiProviderError("AI_ASYNC_REQUEST_ID_MISSING", "NVIDIA returned a pending response without a request ID.", { responseMetadata });
      }
      if (Date.now() >= deadline || pollCount >= maxPolls) {
        throw new AiProviderError("AI_ASYNC_TIMEOUT", "NVIDIA asynchronous completion did not finish before the timeout.", { responseMetadata });
      }

      const delay = Math.min(this.pollIntervalMs, Math.max(0, deadline - Date.now()));
      if (delay > 0) await this.wait(delay);
      const statusEndpoint = new URL(`${this.baseUrl.pathname}/status/${encodeURIComponent(requestId)}`.replace(/\/{2,}/g, "/"), this.baseUrl);
      response = await this.runtime.fetch("nvidia", statusEndpoint, {
        method: "GET",
        headers,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
        retries: 0,
        idempotent: true,
        throwHttpErrors: true,
        providerConcurrency: this.concurrency,
        hostConcurrency: this.concurrency,
        quotaTracker: UNBOUNDED_QUOTA,
        dedupeKey: `nvidia-status:${kind}:${inputHash}:${requestId}`
      });
      pollCount += 1;
    }
  }

  async generate({ kind, messages, schema, inputHash, budget }) {
    const model = this.modelForKind(kind);
    const body = JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      max_tokens: this.maxOutputTokens,
      stream: false,
      ...structuredOutputPayload(this.structuredOutputMode, schema)
    });
    const estimatedTokens = Math.ceil(body.length / 4) + this.maxOutputTokens;
    const endpoint = new URL(`${this.baseUrl.pathname}/chat/completions`.replace(/\/{2,}/g, "/"), this.baseUrl);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const lease = budget?.reserveAttempt({ estimatedTokens });
      let leaseSettled = false;
      try {
        const deadline = Date.now() + this.timeoutMs;
        const headers = { "Content-Type": "application/json", Accept: "application/json" };
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
        const response = await this.runtime.fetch("nvidia", endpoint, {
          method: "POST",
          headers,
          body,
          timeoutMs: Math.max(1_000, deadline - Date.now()),
          retries: 0,
          idempotent: false,
          throwHttpErrors: true,
          providerConcurrency: this.concurrency,
          hostConcurrency: this.concurrency,
          quotaTracker: UNBOUNDED_QUOTA,
          dedupeKey: `nvidia:${kind}:${inputHash}`
        });
        if (!response.ok) {
          throw new AiProviderError("AI_UPSTREAM_4XX", `NVIDIA request failed with status ${response.status}.`, { status: response.status });
        }
        const { payload, responseMetadata } = await this.resolveAsyncResponse(response, { headers, model, kind, inputHash, deadline });
        const usage = responseMetadata.usage;
        budget?.settleAttempt(lease?.leaseId, { actualTokens: usage.totalTokens || null, conservative: usage.totalTokens === 0 });
        leaseSettled = true;
        if (responseMetadata.upstreamError) {
          throw new AiProviderError("AI_UPSTREAM_RESPONSE_ERROR", "NVIDIA returned an error response.", { responseMetadata });
        }
        if (!responseMetadata.payloadModel) {
          throw new AiProviderError("AI_RESPONSE_MODEL_MISSING", "NVIDIA response did not identify the model used.", { responseMetadata });
        }
        if (responseMetadata.payloadModel !== model) {
          throw new AiProviderError("AI_RESPONSE_MODEL_MISMATCH", "NVIDIA response model did not match the requested model.", { responseMetadata });
        }
        return {
          output: parseStructuredContent(payload?.choices?.[0]?.message?.content, responseMetadata),
          provider: this.name,
          model: responseMetadata.payloadModel,
          usage,
          requestId: responseMetadata.requestId,
          responseMetadata
        };
      } catch (error) {
        const retryable = error?.retryable === true;
        const explicitHttpFailure = Number(error?.status) >= 400;
        if (!leaseSettled) {
          budget?.settleAttempt(lease?.leaseId, { actualTokens: explicitHttpFailure ? 0 : null, conservative: !explicitHttpFailure });
        }
        if (attempt < this.maxRetries && retryable) {
          const delay = Math.max(50, Math.min(30_000, Number(error.retryAfterMs) || 250 * (2 ** attempt)));
          await this.wait(delay);
          continue;
        }
        if (error instanceof AiProviderError) throw error;
        throw new AiProviderError(error?.code || "AI_PROVIDER_FAILED", sanitizeSensitiveData(String(error?.message || "NVIDIA request failed.")), {
          cause: error,
          status: error?.status,
          retryable
        });
      }
    }
    throw new AiProviderError("AI_PROVIDER_FAILED", "NVIDIA request failed.");
  }
}

export function createAiProvider(config = {}, injectedProvider = null) {
  if (injectedProvider) return injectedProvider;
  if (!["none", "nvidia", "llamacpp"].includes(config.provider)) throw new AiProviderError("AI_PROVIDER_INVALID", "Unsupported AI provider.");
  if (config.mode === "off" || config.provider === "none") return new NoopAiProvider();
  const Provider = config.provider === "llamacpp" ? LlamaCppProvider : NvidiaNimProvider;
  return new Provider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    summaryModel: config.summaryModel,
    reasoningModel: config.reasoningModel,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxOutputTokens: config.maxOutputTokens,
    concurrency: config.maxConcurrency,
    structuredOutputMode: config.structuredOutputMode,
    jsonMode: config.jsonMode,
    allowPrivateHttp: config.allowPrivateHttp
  });
}
