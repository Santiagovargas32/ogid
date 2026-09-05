import { setTimeout as sleep } from "node:timers/promises";
import { providerRuntime } from "../providers/providerRuntime.js";
import { errorFromResponse, ProviderErrorCode } from "../providers/providerErrors.js";
import {
  AiProviderError, UNBOUNDED_QUOTA, parseBaseUrl, parseStructuredContent,
  buildResponseMetadata, sanitizeProviderData
} from "./aiProviderUtils.js";

const JSON_MODES = new Set(["auto", "on", "off"]);
const RUNTIME_ERROR_CODES = new Set(Object.values(ProviderErrorCode));

function unsupportedResponseFormat(payload, status) {
  if (![400, 422].includes(status) || !payload?.error || typeof payload.error !== "object") return false;
  const { message = "", param = "", code = "" } = payload.error;
  const description = `${param} ${code} ${message}`;
  return /\bresponse[_ -]format\b/i.test(description)
    && /\b(?:unsupported|not supported|not implemented|unrecognized|unknown parameter|unknown field|unexpected keyword|unexpected argument)\b/i.test(description);
}

export class LlamaCppProvider {
  constructor({
    baseUrl, apiKey = "", summaryModel, reasoningModel,
    jsonMode = "auto", allowPrivateHttp = false,
    timeoutMs = 20_000, maxRetries = 1, maxOutputTokens = 1_200,
    concurrency = 1, runtime = providerRuntime, wait = sleep
  } = {}) {
    this.name = "llamacpp";
    this.enabled = true;
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = parseBaseUrl(baseUrl, {
      label: "llama.cpp", apiKey: this.apiKey,
      allowPrivateHttp: allowPrivateHttp === true, requireRemoteKey: true
    });
    this.summaryModel = String(summaryModel || "").trim();
    this.reasoningModel = String(reasoningModel || summaryModel || "").trim();
    if (!this.summaryModel || !this.reasoningModel) throw new AiProviderError("AI_MODEL_REQUIRED", "llama.cpp model configuration is required.");
    this.jsonMode = String(jsonMode).trim().toLowerCase();
    if (!JSON_MODES.has(this.jsonMode)) throw new AiProviderError("AI_JSON_MODE_INVALID", "llama.cpp JSON mode must be auto, on or off.");
    this.structuredOutputMode = this.jsonMode === "off" ? "off" : "json-schema";
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 20_000);
    this.maxRetries = Math.max(0, Math.min(1, Number(maxRetries) || 0));
    this.maxOutputTokens = Math.max(128, Number(maxOutputTokens) || 1_200);
    this.concurrency = Math.max(1, Math.min(2, Number(concurrency) || 1));
    this.runtime = runtime;
    this.wait = wait;
    this.metrics = { generations: 0, completed: 0, failed: 0, retries: 0, formatFallbacks: 0, lastDurationMs: 0, maxDurationMs: 0 };
  }

  modelForKind(kind) {
    return kind === "article_summary" ? this.summaryModel : this.reasoningModel;
  }

  getMetrics() {
    const transport = this.runtime.getMetrics?.(this.name) || {};
    return {
      ...transport,
      ...this.metrics,
      retries: Number(transport.retries || 0) + this.metrics.retries,
      jsonMode: this.jsonMode,
      structuredOutputMode: this.structuredOutputMode,
      circuit: this.runtime.getCircuitSnapshot?.(this.name) || null
    };
  }

  async generate(request) {
    const started = Date.now();
    this.metrics.generations += 1;
    try {
      const result = await this.generateCompletion(request);
      this.metrics.completed += 1;
      return result;
    } catch (error) {
      this.metrics.failed += 1;
      throw error;
    } finally {
      this.metrics.lastDurationMs = Math.max(0, Date.now() - started);
      this.metrics.maxDurationMs = Math.max(this.metrics.maxDurationMs, this.metrics.lastDurationMs);
    }
  }

  async generateCompletion({ kind, messages, schema, inputHash, budget }) {
    const model = this.modelForKind(kind);
    const endpoint = new URL(`${this.baseUrl.pathname}/chat/completions`.replace(/\/{2,}/g, "/"), this.baseUrl);
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let useStructuredOutput = this.jsonMode !== "off";

    // One allowance for all additional POSTs: a transient retry OR a format
    // fallback, never nested retry loops. Every POST reserves its own budget.
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const body = JSON.stringify({
        model, messages, temperature: 0.1,
        max_tokens: this.maxOutputTokens, stream: false,
        // Documented llama.cpp contract: schema is an object, not NIM's string.
        ...(useStructuredOutput ? { response_format: { type: "json_schema", schema } } : {})
      });
      const lease = budget?.reserveAttempt({ estimatedTokens: Math.ceil(body.length / 4) + this.maxOutputTokens });
      let settled = false;
      let responseMetadata = null;
      try {
        const response = await this.runtime.fetch(this.name, endpoint, {
          method: "POST", headers, body,
          timeoutMs: this.timeoutMs, retries: 0, idempotent: false,
          throwHttpErrors: true, bufferResponse: true, redirect: "error",
          providerConcurrency: this.concurrency, hostConcurrency: this.concurrency,
          quotaTracker: UNBOUNDED_QUOTA,
          dedupeKey: `${this.name}:${endpoint}:${model}:${kind}:${inputHash}:${useStructuredOutput}`
        });
        responseMetadata = sanitizeProviderData(buildResponseMetadata({ response, requestedModel: model, includeErrorMessage: false }), this.apiKey);
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          if (response.ok) {
            throw new AiProviderError("AI_INVALID_RESPONSE_JSON", "llama.cpp returned an invalid JSON envelope.");
          }
          // Preserve HTTP classification even for a non-JSON authentication or proxy error.
        }
        responseMetadata = sanitizeProviderData(buildResponseMetadata({
          payload, response, requestedModel: model, includeErrorMessage: false
        }), this.apiKey);
        if (!response.ok) {
          budget?.settleAttempt(lease?.leaseId, { actualTokens: 0 });
          settled = true;
          if (this.jsonMode === "auto" && useStructuredOutput && attempt < this.maxRetries
              && unsupportedResponseFormat(payload, response.status)) {
            useStructuredOutput = false;
            this.metrics.formatFallbacks += 1;
            continue;
          }
          if ([401, 403].includes(response.status)) {
            throw new AiProviderError("AI_AUTH_FAILED", "llama.cpp authentication failed.", { status: response.status });
          }
          throw errorFromResponse(this.name, response);
        }
        const usage = responseMetadata.usage;
        budget?.settleAttempt(lease?.leaseId, { actualTokens: usage.totalTokens || null, conservative: usage.totalTokens === 0 });
        settled = true;
        if (response.status === 202) throw new AiProviderError("AI_ASYNC_UNSUPPORTED", "llama.cpp returned an unsupported pending completion.");
        if (payload?.error) throw new AiProviderError("AI_UPSTREAM_RESPONSE_ERROR", "llama.cpp returned an error envelope.");
        if (!Array.isArray(payload?.choices) || !payload.choices[0]?.message) {
          throw new AiProviderError("AI_CHOICES_MISSING", "llama.cpp response has no completion choice.");
        }
        const output = parseStructuredContent(payload.choices[0].message.content, responseMetadata, "llama.cpp");
        if (!output || typeof output !== "object" || Array.isArray(output)) {
          throw new AiProviderError("AI_INVALID_JSON", "llama.cpp completion must contain one JSON object.");
        }
        return {
          output, provider: this.name,
          // Keep the configured alias as the cache/provenance identity. The
          // actual upstream name is retained separately in safe metadata.
          model, usage, requestId: responseMetadata.requestId, responseMetadata
        };
      } catch (error) {
        if (!settled) {
          const noCompletion = Number(error?.status) >= 400 || error?.code === ProviderErrorCode.CIRCUIT_OPEN;
          budget?.settleAttempt(lease?.leaseId, { actualTokens: noCompletion ? 0 : null, conservative: !noCompletion });
        }
        if (error?.retryable === true && attempt < this.maxRetries) {
          this.metrics.retries += 1;
          await this.wait(Math.max(50, Math.min(30_000, Number(error.retryAfterMs) || 250)));
          continue;
        }
        const code = error instanceof AiProviderError || RUNTIME_ERROR_CODES.has(error?.code) ? error.code : "AI_PROVIDER_FAILED";
        throw new AiProviderError(code, error instanceof AiProviderError ? error.message : `llama.cpp request failed (${code}).`, {
          status: error?.status, retryable: error?.retryable, retryAfterMs: error?.retryAfterMs,
          responseMetadata: sanitizeProviderData(responseMetadata || buildResponseMetadata({
            response: { status: error?.status }, requestedModel: model, includeErrorMessage: false
          }), this.apiKey)
        });
      }
    }
    throw new AiProviderError("AI_PROVIDER_FAILED", "llama.cpp request failed.");
  }
}
