import "dotenv/config";
import { createAiProvider } from "../services/ai/aiProviders.js";
import { AiBudgetService } from "../services/ai/aiBudgetService.js";
import { UNBOUNDED_QUOTA, sanitizeProviderData } from "../services/ai/aiProviderUtils.js";
import { providerRuntime } from "../services/providers/providerRuntime.js";

if (process.env.RUN_LIVE_LLAMACPP_SMOKE !== "1") {
  process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: "Set RUN_LIVE_LLAMACPP_SMOKE=1 to contact the configured llama.cpp server." })}\n`);
} else {
  const started = Date.now();
  try {
    const provider = createAiProvider({
      provider: "llamacpp", mode: "shadow",
      baseUrl: process.env.LLAMACPP_BASE_URL, apiKey: process.env.LLAMACPP_API_KEY,
      summaryModel: process.env.LLAMACPP_MODEL_SUMMARY, reasoningModel: process.env.LLAMACPP_MODEL_REASONING,
      jsonMode: process.env.LLAMACPP_JSON_MODE || "auto",
      allowPrivateHttp: process.env.LLAMACPP_ALLOW_PRIVATE_HTTP === "1",
      timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 180_000,
      maxOutputTokens: Number(process.env.AI_MAX_OUTPUT_TOKENS) || 1_200,
      maxRetries: Number(process.env.AI_MAX_RETRIES ?? 1), maxConcurrency: 1
    });
    const headers = { Accept: "application/json" };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const modelsUrl = new URL(`${provider.baseUrl.pathname}/models`, provider.baseUrl);
    const response = await providerRuntime.fetch("llamacpp", modelsUrl, {
      headers, timeoutMs: Math.min(provider.timeoutMs, 10_000), retries: 0,
      redirect: "error", bufferResponse: true, throwHttpErrors: true, quotaTracker: UNBOUNDED_QUOTA
    });
    if (!response.ok) throw Object.assign(new Error("Model listing failed."), { code: "AI_MODELS_HTTP_ERROR", status: response.status });
    const models = await response.json();
    if (!Array.isArray(models?.data) || !models.data.length) throw Object.assign(new Error("No models returned."), { code: "AI_MODELS_EMPTY" });
    // Isolated smoke budget: never reads or changes the production budget/state.
    const budget = new AiBudgetService({ dailyRequestBudget: 2, dailyTokenBudget: 100_000 });
    const result = await provider.generate({
      kind: "article_summary", inputHash: "manual-connectivity-smoke-v1", budget,
      messages: [{ role: "system", content: 'Return exactly one JSON object: {"ok":true}. No Markdown, code fences, or additional text.' }, { role: "user", content: "Confirm this connectivity test." }],
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { const: true } } }
    });
    if (result.output?.ok !== true || Object.keys(result.output).length !== 1) throw Object.assign(new Error("Unexpected smoke output."), { code: "AI_SMOKE_OUTPUT_INVALID" });
    process.stdout.write(`${JSON.stringify(sanitizeProviderData({
      ok: true, durationMs: Date.now() - started, modelCount: models.data.length,
      responseMetadata: result.responseMetadata, budget: budget.snapshot(), transport: provider.getMetrics()
    }, provider.apiKey), null, 2)}\n`);
  } catch (error) {
    // No response bodies, prompts, headers, URL or raw error messages in output.
    const responseMetadata = error?.responseMetadata || null;
    process.stdout.write(`${JSON.stringify(sanitizeProviderData({
      ok: false, durationMs: Date.now() - started, code: error?.code || "AI_SMOKE_FAILED",
      httpStatus: error?.status || responseMetadata?.httpStatus || null,
      responseMetadata
    }, process.env.LLAMACPP_API_KEY || ""), null, 2)}\n`);
    process.exitCode = 1;
  }
}
