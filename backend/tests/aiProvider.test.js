import test from "node:test";
import assert from "node:assert/strict";
import { NvidiaNimProvider } from "../services/ai/aiProviders.js";
import { getAiOutputSchema } from "../services/ai/aiSchemas.js";

function budgetRecorder() {
  const events = [];
  return {
    events,
    reserveAttempt({ estimatedTokens }) {
      const lease = { leaseId: `lease-${events.length}`, estimatedTokens };
      events.push({ type: "reserve", ...lease });
      return lease;
    },
    settleAttempt(leaseId, value) { events.push({ type: "settle", leaseId, ...value }); }
  };
}

test("NVIDIA provider sends guided JSON server-side and reconciles returned usage", async () => {
  let captured = null;
  const runtime = {
    async fetch(provider, url, options) {
      captured = { provider, url: String(url), options };
      return new Response(JSON.stringify({
        model: "summary-model",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          summary: "Supported summary.",
          summaryEvidenceArticleIds: ["ca_test"],
          keyDevelopments: [],
          entities: [],
          uncertainty: { level: "low", notes: [] }
        }), reasoning_content: "internal reasoning must not be persisted" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-1" } });
    },
    getMetrics: () => ({ calls: 1 }),
    getCircuitSnapshot: () => ({ state: "closed", failures: 0, openedAt: null })
  };
  const provider = new NvidiaNimProvider({
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "test-key",
    summaryModel: "summary-model",
    reasoningModel: "reasoning-model",
    runtime
  });
  const budget = budgetRecorder();
  const result = await provider.generate({
    kind: "article_summary",
    messages: [{ role: "user", content: "{}" }],
    schema: getAiOutputSchema("article_summary"),
    inputHash: "hash",
    budget
  });
  const body = JSON.parse(captured.options.body);
  assert.equal(captured.provider, "nvidia");
  assert.equal(captured.url, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  assert.equal(body.guided_json.$id, "ogid-ai-article-summary-v1");
  assert.equal(body.nvext, undefined);
  assert.equal(body.response_format, undefined);
  assert.equal(body.stream, false);
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.model, "summary-model");
  assert.deepEqual(result.responseMetadata, {
    requestedModel: "summary-model",
    payloadModel: "summary-model",
    finishReason: "stop",
    requestId: "req-1",
    httpStatus: 200,
    pollCount: 0,
    upstreamError: null,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    contentType: "string",
    contentLength: JSON.stringify(result.output).length,
    hasReasoningContent: true
  });
  assert.doesNotMatch(JSON.stringify(result.responseMetadata), /internal reasoning|Supported summary/);
  assert.equal(budget.events.at(-1).actualTokens, 15);
  assert.equal(provider.getMetrics().circuit.state, "closed");
  assert.equal(provider.getMetrics().structuredOutputMode, "guided-json");
});

test("NVIDIA provider uses response_format only when configured explicitly", async () => {
  let requestBody = null;
  const runtime = {
    async fetch(_provider, _url, options) {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        model: "local-model",
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        usage: { total_tokens: 1 }
      }), { status: 200 });
    }
  };
  const provider = new NvidiaNimProvider({
    baseUrl: "http://localhost:9000/v1",
    summaryModel: "local-model",
    reasoningModel: "local-model",
    structuredOutputMode: "response-format",
    runtime
  });
  await provider.generate({ kind: "article_summary", messages: [], schema: { type: "object" }, inputHash: "x", budget: budgetRecorder() });
  assert.equal(requestBody.guided_json, undefined);
  assert.equal(requestBody.nvext, undefined);
  assert.equal(requestBody.response_format.type, "json_schema");
  assert.deepEqual(JSON.parse(requestBody.response_format.schema), { type: "object" });
});

test("NVIDIA provider fails explicitly when payload.model differs from the requested model", async () => {
  const runtime = {
    async fetch() {
      return new Response(JSON.stringify({
        model: "unexpected-model",
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      }), { status: 200, headers: { "x-request-id": "req-mismatch" } });
    }
  };
  const provider = new NvidiaNimProvider({
    baseUrl: "http://localhost:9000/v1",
    summaryModel: "requested-model",
    reasoningModel: "requested-model",
    runtime
  });
  await assert.rejects(
    provider.generate({ kind: "article_summary", messages: [], schema: {}, inputHash: "x", budget: budgetRecorder() }),
    (error) => {
      assert.equal(error.code, "AI_RESPONSE_MODEL_MISMATCH");
      assert.equal(error.responseMetadata.requestedModel, "requested-model");
      assert.equal(error.responseMetadata.payloadModel, "unexpected-model");
      assert.equal(error.responseMetadata.requestId, "req-mismatch");
      return true;
    }
  );
});

test("NVIDIA provider attaches safe response metadata to invalid structured JSON failures", async () => {
  const rawContent = "not-json";
  const runtime = {
    async fetch() {
      return new Response(JSON.stringify({
        model: "local-model",
        choices: [{
          finish_reason: "length",
          message: { content: rawContent, reasoning_content: "private chain of thought" }
        }],
        usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 }
      }), { status: 200, headers: { "nvcf-reqid": "req-invalid-json" } });
    }
  };
  const provider = new NvidiaNimProvider({
    baseUrl: "http://localhost:9000/v1",
    summaryModel: "local-model",
    reasoningModel: "local-model",
    runtime
  });
  await assert.rejects(
    provider.generate({ kind: "article_summary", messages: [], schema: {}, inputHash: "x", budget: budgetRecorder() }),
    (error) => {
      assert.equal(error.code, "AI_INVALID_JSON");
      assert.deepEqual(error.responseMetadata, {
        requestedModel: "local-model",
        payloadModel: "local-model",
        finishReason: "length",
        requestId: "req-invalid-json",
        httpStatus: 200,
        pollCount: 0,
        upstreamError: null,
        usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
        contentType: "string",
        contentLength: rawContent.length,
        hasReasoningContent: true
      });
      assert.doesNotMatch(JSON.stringify(error.responseMetadata), /private chain|not-json/);
      return true;
    }
  );
});

test("NVIDIA provider accepts a single fenced JSON object before normal validation", async () => {
  const runtime = {
    async fetch() {
      return new Response(JSON.stringify({
        model: "local-model",
        choices: [{ finish_reason: "stop", message: { content: "```json\n{}\n```" } }],
        usage: { total_tokens: 1 }
      }), { status: 200 });
    }
  };
  const provider = new NvidiaNimProvider({
    baseUrl: "http://localhost:9000/v1",
    summaryModel: "local-model",
    reasoningModel: "local-model",
    runtime
  });
  const result = await provider.generate({ kind: "article_summary", messages: [], schema: {}, inputHash: "x", budget: budgetRecorder() });
  assert.deepEqual(result.output, {});
});

test("NVIDIA provider surfaces a sanitized error envelope even when upstream responds with HTTP 200", async () => {
  const runtime = {
    async fetch() {
      return new Response(JSON.stringify({
        error: { code: "invalid_request", message: "response_format is not supported" }
      }), { status: 200, headers: { "x-request-id": "req-upstream-error" } });
    }
  };
  const provider = new NvidiaNimProvider({
    baseUrl: "http://localhost:9000/v1",
    summaryModel: "local-model",
    reasoningModel: "local-model",
    runtime
  });
  await assert.rejects(
    provider.generate({ kind: "article_summary", messages: [], schema: {}, inputHash: "x", budget: budgetRecorder() }),
    (error) => {
      assert.equal(error.code, "AI_UPSTREAM_RESPONSE_ERROR");
      assert.deepEqual(error.responseMetadata.upstreamError, {
        code: "invalid_request",
        message: "response_format is not supported"
      });
      return true;
    }
  );
});

test("NVIDIA provider polls a documented 202 completion without reserving a second model request", async () => {
  const calls = [];
  const runtime = {
    async fetch(_provider, url, options) {
      calls.push({ url: String(url), method: options.method });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ requestId: "req-async" }), {
          status: 202,
          headers: { "nvcf-reqid": "req-async" }
        });
      }
      return new Response(JSON.stringify({
        model: "local-model",
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }), { status: 200 });
    }
  };
  const provider = new NvidiaNimProvider({
    baseUrl: "http://localhost:9000/v1",
    summaryModel: "local-model",
    reasoningModel: "local-model",
    runtime,
    wait: async () => {}
  });
  const budget = budgetRecorder();
  const result = await provider.generate({ kind: "article_summary", messages: [], schema: {}, inputHash: "x", budget });
  assert.deepEqual(calls, [
    { url: "http://localhost:9000/v1/chat/completions", method: "POST" },
    { url: "http://localhost:9000/v1/status/req-async", method: "GET" }
  ]);
  assert.equal(result.responseMetadata.requestId, "req-async");
  assert.equal(result.responseMetadata.httpStatus, 200);
  assert.equal(result.responseMetadata.pollCount, 1);
  assert.equal(budget.events.filter((event) => event.type === "reserve").length, 1);
  assert.equal(budget.events.filter((event) => event.type === "settle").length, 1);
});

test("NVIDIA provider honors one bounded retry without leaking a remote call", async () => {
  let calls = 0;
  const runtime = {
    async fetch() {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("limited"), { code: "rate_limited", retryable: true, status: 429, retryAfterMs: 1 });
      return new Response(JSON.stringify({ model: "local-model", choices: [{ finish_reason: "stop", message: { content: "{}" } }], usage: { total_tokens: 1 } }), { status: 200 });
    },
    getMetrics: () => ({ calls })
  };
  const provider = new NvidiaNimProvider({
    baseUrl: "http://localhost:9000/v1",
    summaryModel: "local-model",
    reasoningModel: "local-model",
    maxRetries: 1,
    runtime,
    wait: async () => {}
  });
  const budget = budgetRecorder();
  await provider.generate({ kind: "article_summary", messages: [], schema: {}, inputHash: "x", budget });
  assert.equal(calls, 2);
  assert.equal(budget.events.filter((event) => event.type === "reserve").length, 2);
});

test("remote NVIDIA endpoint requires HTTPS and a key", () => {
  assert.throws(() => new NvidiaNimProvider({ baseUrl: "http://example.com/v1", summaryModel: "m" }), /HTTPS/);
  assert.throws(() => new NvidiaNimProvider({ baseUrl: "https://example.com/v1", summaryModel: "m" }), /API key/);
});

test("NVIDIA provider rejects unknown structured output modes", () => {
  assert.throws(
    () => new NvidiaNimProvider({ baseUrl: "http://localhost:9000/v1", summaryModel: "m", structuredOutputMode: "auto" }),
    (error) => error.code === "AI_STRUCTURED_OUTPUT_MODE_INVALID"
  );
});
