import test from "node:test";
import assert from "node:assert/strict";
import { AiProviderError, LlamaCppProvider, NvidiaNimProvider, NoopAiProvider, createAiProvider } from "../services/ai/aiProviders.js";
import { AiBudgetService } from "../services/ai/aiBudgetService.js";
import { getAiOutputSchema } from "../services/ai/aiSchemas.js";
import { ProviderError } from "../services/providers/providerErrors.js";

const schema = getAiOutputSchema("article_summary");
const request = { kind: "article_summary", messages: [{ role: "system", content: "Return exactly one JSON object." }, { role: "user", content: "Evidence" }], schema, inputHash: "same-input" };
const output = { summary: "Supported summary.", summaryEvidenceArticleIds: ["ca_test"], keyDevelopments: [], entities: [], uncertainty: { level: "high", notes: [] } };
const completion = (overrides = {}) => ({ model: "actual-model.gguf", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output), reasoning_content: "private reasoning" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ...overrides });
const jsonResponse = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), { status, headers });

function harness(options = {}, handler = () => jsonResponse(completion(), 200, { "x-request-id": "req-local" })) {
  const calls = [];
  const waits = [];
  const runtime = {
    async fetch(provider, url, options) {
      calls.push({ provider, url: String(url), options, body: JSON.parse(options.body) });
      return handler(calls.length, options);
    },
    getMetrics: (provider) => { assert.equal(provider, "llamacpp"); return { calls: calls.length, attempts: calls.length }; },
    getCircuitSnapshot: (provider) => { assert.equal(provider, "llamacpp"); return { state: "closed" }; }
  };
  const budget = new AiBudgetService();
  const provider = new LlamaCppProvider({ baseUrl: "http://127.0.0.1:8080/v1", summaryModel: "summary-alias", reasoningModel: "reasoning-alias", runtime, wait: async (ms) => { waits.push(ms); }, ...options });
  return { provider, budget, calls, waits, generate: (overrides = {}) => provider.generate({ ...request, budget, ...overrides }) };
}

for (const [kind, model] of [["article_summary", "summary-alias"], ["country_insight", "reasoning-alias"], ["market_explanation", "reasoning-alias"]]) {
  test(`llama.cpp selects ${model} for ${kind} and sends the OpenAI-compatible contract`, async () => {
    const h = harness({ apiKey: "test-local-key", maxOutputTokens: 1600, timeoutMs: 180_000 });
    const result = await h.generate({ kind });
    const call = h.calls[0];
    assert.equal(h.provider.name, "llamacpp");
    assert.equal(call.provider, "llamacpp");
    assert.equal(call.url, "http://127.0.0.1:8080/v1/chat/completions");
    assert.equal(call.options.method, "POST");
    assert.deepEqual(call.options.headers, { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer test-local-key" });
    assert.deepEqual(call.body, { model, messages: request.messages, temperature: 0.1, max_tokens: 1600, stream: false, response_format: { type: "json_schema", schema } });
    assert.equal(call.options.timeoutMs, 180_000);
    assert.equal(call.options.retries, 0);
    assert.equal(call.options.idempotent, false);
    assert.equal(call.options.bufferResponse, true);
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.providerConcurrency, 1);
    assert.equal(call.options.hostConcurrency, 1);
    assert.equal(result.model, model);
    assert.equal(result.responseMetadata.payloadModel, "actual-model.gguf");
    assert.equal(result.responseMetadata.requestedModel, model);
    assert.deepEqual(result.output, output);
    assert.equal(h.budget.snapshot().requestsUsed, 1);
    assert.equal(h.budget.snapshot().tokensUsed, 15);
    assert.equal(h.provider.getMetrics().generations, 1);
    assert.equal(h.provider.getMetrics().circuit.state, "closed");
  });
}

test("llama.cpp normalizes trailing slashes, strips query/fragment and never doubles /v1", async () => {
  const h = harness({ baseUrl: "http://localhost:8080/v1///?token=do-not-send#secret" });
  await h.generate();
  assert.equal(h.calls[0].url, "http://localhost:8080/v1/chat/completions");
  assert.equal(Object.hasOwn(h.calls[0].options.headers, "Authorization"), false);
});

for (const baseUrl of ["http://127.0.0.1:8080/v1", "http://localhost:8080/v1", "http://[::1]:8080/v1", "http://127.1.2.3/v1"]) {
  test(`llama.cpp permits loopback without a key: ${baseUrl}`, () => assert.equal(harness({ baseUrl }).provider.enabled, true));
}
for (const baseUrl of ["http://100.64.0.1:8080/v1", "http://100.127.255.254:8080/v1", "http://ai-server:8080/v1", "http://ai-server.example.ts.net:8080/v1", "http://10.0.0.1/v1", "http://[fd7a:115c:a1e0::1]:8080/v1"]) {
  test(`llama.cpp requires opt-in and key for private HTTP: ${baseUrl}`, () => {
    assert.throws(() => harness({ baseUrl }), { code: "AI_BASE_URL_INSECURE" });
    assert.throws(() => harness({ baseUrl, allowPrivateHttp: true }), { code: "AI_API_KEY_REQUIRED" });
    assert.equal(harness({ baseUrl, allowPrivateHttp: true, apiKey: "private-test-key" }).provider.enabled, true);
  });
}
for (const baseUrl of ["http://8.8.8.8/v1", "http://100.63.255.255/v1", "http://100.128.0.1/v1", "http://[2606:4700:4700::1111]/v1", "http://[::ffff:8.8.8.8]/v1", "http://0.0.0.0:8080/v1", "http://169.254.169.254/v1"]) {
  test(`llama.cpp rejects a non-private literal even with opt-in: ${baseUrl}`, () => {
    assert.throws(() => harness({ baseUrl, allowPrivateHttp: true, apiKey: "key" }), { code: "AI_PUBLIC_HTTP_FORBIDDEN" });
  });
}

test("llama.cpp permits authenticated remote HTTPS and validates configuration without network calls", () => {
  assert.equal(harness({ baseUrl: "https://ai.example/v1", apiKey: "key" }).calls.length, 0);
  assert.throws(() => harness({ baseUrl: "https://ai.example/v1" }), { code: "AI_API_KEY_REQUIRED" });
  for (const baseUrl of ["", "not a url", "file:///tmp/model", "ftp://ai.example/v1", "https://user:secret@ai.example/v1"]) {
    assert.throws(() => harness({ baseUrl, apiKey: "key" }), (error) => {
      assert.equal(error.code, "AI_BASE_URL_INVALID");
      assert.doesNotMatch(error.message, /NVIDIA|user:secret/);
      return true;
    });
  }
  assert.throws(() => harness({ summaryModel: "", reasoningModel: "" }), { code: "AI_MODEL_REQUIRED" });
  assert.throws(() => harness({ jsonMode: "guess" }), { code: "AI_JSON_MODE_INVALID" });
  assert.equal(harness({ reasoningModel: "" }).provider.modelForKind("country_insight"), "summary-alias");
});

for (const jsonMode of ["off", "on", "auto"]) {
  test(`llama.cpp JSON mode ${jsonMode}`, async () => {
    const h = harness({ jsonMode });
    await h.generate();
    assert.equal(Object.hasOwn(h.calls[0].body, "response_format"), jsonMode !== "off");
    assert.equal(h.calls.length, 1);
    assert.equal(h.provider.getMetrics().jsonMode, jsonMode);
  });
}

const unsupported = { error: { message: "response_format is not supported", type: "invalid_request_error" } };
test("auto falls back once within the retry allowance and accounts for two budgeted attempts", async () => {
  const h = harness({}, (call) => call === 1 ? jsonResponse(unsupported, 400) : jsonResponse(completion()));
  await h.generate();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].body.response_format.type, "json_schema");
  assert.equal(Object.hasOwn(h.calls[1].body, "response_format"), false);
  assert.equal(h.budget.snapshot().requestsUsed, 2);
  assert.equal(h.budget.snapshot().tokensUsed, 15);
  assert.equal(h.budget.snapshot().activeReservations, 0);
  assert.equal(h.provider.getMetrics().generations, 1);
  assert.equal(h.provider.getMetrics().formatFallbacks, 1);
  assert.deepEqual(h.waits, []);
});

for (const [options, payload] of [[{ jsonMode: "on" }, unsupported], [{ maxRetries: 0 }, unsupported], [{}, { error: { message: "response_format contains an invalid schema" } }]]) {
  test(`no format fallback for ${JSON.stringify(options)} / ${payload.error.message}`, async () => {
    const h = harness(options, () => jsonResponse(payload, 400));
    await assert.rejects(h.generate(), { code: "upstream_4xx", status: 400 });
    assert.equal(h.calls.length, 1);
    assert.equal(h.provider.getMetrics().formatFallbacks, 0);
  });
}

test("fallback never multiplies transient retries and a transient retry cannot add a third format attempt", async () => {
  for (const statuses of [[400, 503], [503, 400], [400, 400]]) {
    const h = harness({}, (call) => jsonResponse(unsupported, statuses[call - 1]));
    await assert.rejects(h.generate());
    assert.equal(h.calls.length, 2);
    assert.equal(h.budget.snapshot().requestsUsed, 2);
  }
});

for (const [status, code, calls] of [[400, "upstream_4xx", 1], [401, "AI_AUTH_FAILED", 1], [403, "AI_AUTH_FAILED", 1], [429, "rate_limited", 2], [503, "upstream_5xx", 2]]) {
  test(`HTTP ${status} remains classified with no format fallback`, async () => {
    const h = harness({}, () => jsonResponse(status === 400 ? { error: { message: "Bad input" } } : unsupported, status));
    await assert.rejects(h.generate(), { code, status });
    assert.equal(h.calls.length, calls);
    assert.equal(h.provider.getMetrics().formatFallbacks, 0);
    assert.ok(h.calls.every((call) => call.body.response_format));
    assert.equal(h.budget.snapshot().tokensUsed, 0);
  });
}

for (const code of ["timeout", "network", "circuit_open"]) {
  test(`${code} uses runtime classification and never triggers format fallback`, async () => {
    const h = harness({}, () => { throw new ProviderError(code, "raw Authorization: Bearer private-key prompt text", { retryable: code !== "circuit_open" }); });
    await assert.rejects(h.generate(), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.responseMetadata.httpStatus, null);
      assert.doesNotMatch(JSON.stringify(error), /private-key|prompt text/);
      assert.doesNotMatch(error.message, /Authorization|prompt text/);
      return true;
    });
    assert.equal(h.calls.length, code === "circuit_open" ? 1 : 2);
    assert.equal(h.provider.getMetrics().formatFallbacks, 0);
    assert.equal(h.budget.snapshot().activeReservations, 0);
    assert.equal(h.budget.snapshot().tokensUsed > 0, code !== "circuit_open");
  });
}

for (const content of [output, JSON.stringify(output), "```json\n" + JSON.stringify(output) + "\n``` "]) {
  test(`accepts one structured object (${typeof content})`, async () => {
    const h = harness({}, () => jsonResponse(completion({ choices: [{ message: { content } }] })));
    assert.deepEqual((await h.generate()).output, output);
  });
}
for (const [content, code] of [["", "AI_EMPTY_RESPONSE"], ["   ", "AI_EMPTY_RESPONSE"], [null, "AI_EMPTY_RESPONSE"], [undefined, "AI_EMPTY_RESPONSE"], ["{", "AI_INVALID_JSON"], ["before {}", "AI_INVALID_JSON"], ["{} after", "AI_INVALID_JSON"], ["{} {}", "AI_INVALID_JSON"], ["[]", "AI_INVALID_JSON"], ["null", "AI_INVALID_JSON"]]) {
  test(`rejects invalid completion content: ${String(content)}`, async () => {
    const h = harness({}, () => jsonResponse(completion({ choices: [{ finish_reason: "length", message: { content } }] })));
    await assert.rejects(h.generate(), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.responseMetadata.finishReason, "length");
      return true;
    });
    assert.equal(h.calls.length, 1);
    assert.equal(h.budget.snapshot().tokensUsed, 15);
  });
}

test("diagnostic metadata never contains completion, reasoning, prompt or API key", async () => {
  const h = harness({ apiKey: "sentinel-key" }, () => jsonResponse(completion(), 200, { "x-request-id": "sentinel-key" }));
  const { responseMetadata: metadata } = await h.generate();
  assert.deepEqual(metadata, {
    requestedModel: "summary-alias", payloadModel: "actual-model.gguf", finishReason: "stop",
    requestId: "***", httpStatus: 200, pollCount: 0, upstreamError: null,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    contentType: "string", contentLength: JSON.stringify(output).length, hasReasoningContent: true
  });
  assert.doesNotMatch(JSON.stringify(metadata), /sentinel-key|Supported summary|private reasoning|Evidence/);
});

for (const [payload, status, code] of [[{}, 200, "AI_CHOICES_MISSING"], [{ choices: [] }, 200, "AI_CHOICES_MISSING"], [null, 200, "AI_CHOICES_MISSING"], [unsupported, 200, "AI_UPSTREAM_RESPONSE_ERROR"], [{ requestId: "nim-request" }, 202, "AI_ASYNC_UNSUPPORTED"]]) {
  test(`rejects malformed or pending envelope with ${code}`, async () => {
    const h = harness({}, () => jsonResponse(payload, status));
    await assert.rejects(h.generate(), { code });
    assert.equal(h.calls.length, 1);
  });
}
test("invalid JSON envelope fails safely while non-JSON 401 retains authentication classification", async () => {
  for (const [status, code] of [[200, "AI_INVALID_RESPONSE_JSON"], [401, "AI_AUTH_FAILED"]]) {
    const h = harness({}, () => new Response("<html>private response</html>", { status }));
    await assert.rejects(h.generate(), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.responseMetadata.httpStatus, status);
      assert.doesNotMatch(JSON.stringify(error), /private response/);
      return true;
    });
  }
});

for (const usage of [undefined, null, {}, { total_tokens: 0 }, { prompt_tokens: -10, completion_tokens: "bad", total_tokens: -1 }]) {
  test(`unknown/zero usage settles conservatively: ${JSON.stringify(usage)}`, async () => {
    const h = harness({}, () => jsonResponse(completion({ usage })));
    await h.generate();
    const estimate = Math.ceil(h.calls[0].options.body.length / 4) + h.calls[0].body.max_tokens;
    assert.equal(h.budget.snapshot().tokensUsed, estimate);
    assert.equal(h.budget.snapshot().activeReservations, 0);
  });
}
test("usage normalizes numeric strings and missing totals", async () => {
  const h = harness({}, () => jsonResponse(completion({ usage: { prompt_tokens: "20", completion_tokens: "10" } })));
  assert.deepEqual((await h.generate()).usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
  assert.equal(h.budget.snapshot().tokensUsed, 30);
});

test("request/token budgets reject before transport and block an unaffordable fallback", async () => {
  const h = harness({}, () => jsonResponse(unsupported, 400));
  await assert.rejects(h.generate({ budget: new AiBudgetService({ dailyTokenBudget: 1 }) }), { code: "AI_TOKEN_BUDGET_EXHAUSTED" });
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.generate({ budget: new AiBudgetService({ dailyRequestBudget: 1 }) }), { code: "AI_REQUEST_BUDGET_EXHAUSTED" });
  assert.equal(h.calls.length, 1);
});

test("provider factory selects llama.cpp, preserves NVIDIA/injection and off/none, and rejects typos", () => {
  const local = { baseUrl: "http://localhost:8080/v1", summaryModel: "m", mode: "shadow" };
  assert.ok(createAiProvider({ ...local, provider: "llamacpp" }) instanceof LlamaCppProvider);
  assert.ok(createAiProvider({ ...local, provider: "nvidia" }) instanceof NvidiaNimProvider);
  for (const provider of ["none", "nvidia", "llamacpp"]) assert.ok(createAiProvider({ provider, mode: "off" }) instanceof NoopAiProvider);
  assert.ok(createAiProvider({ provider: "none", mode: "visible" }) instanceof NoopAiProvider);
  assert.throws(() => createAiProvider({ provider: "typo", mode: "off" }), { code: "AI_PROVIDER_INVALID" });
  const injected = {};
  assert.equal(createAiProvider({}, injected), injected);
  assert.ok(new AiProviderError("test", "test") instanceof Error);
});
