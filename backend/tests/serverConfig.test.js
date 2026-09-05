import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "../server.js";

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("server config enables all llama.cpp features in shadow with isolated credentials", () => withEnv({
  AI_PROVIDER: " LLAMACPP ", AI_MODE: "shadow",
  AI_FEATURES: "article-summary,country-insight,market-explanation,invalid,article-summary",
  LLAMACPP_BASE_URL: "http://ai-server:8080/v1?token=discarded#discarded",
  LLAMACPP_API_KEY: "test-llama-key", LLAMACPP_MODEL_SUMMARY: "qwen3.8-27b",
  LLAMACPP_MODEL_REASONING: "qwen3.8-27b", LLAMACPP_JSON_MODE: " AUTO ", LLAMACPP_ALLOW_PRIVATE_HTTP: "1",
  NVIDIA_API_KEY: "must-not-use-nvidia-key", NVIDIA_MODEL_SUMMARY: "must-not-use-nvidia-model",
  AI_TIMEOUT_MS: "180000", AI_MAX_CONCURRENCY: "1", AI_QUEUE_MAX: "50", AI_MAX_JOBS_PER_CYCLE: "4",
  PORT: "3000", HOST: "127.0.0.1", ALLOW_LOCAL_ADMIN: "0"
}, () => {
  const runtime = createAppServer({ market: { historyPersist: false } });
  assert.equal(runtime.config.host, "127.0.0.1");
  assert.equal(runtime.config.port, 3000);
  assert.equal(runtime.config.security.allowLocalAdmin, false);
  assert.equal(runtime.config.ai.provider, "llamacpp");
  assert.equal(runtime.config.ai.apiKey, "test-llama-key");
  assert.equal(runtime.config.ai.timeoutMs, 180_000);
  const admin = runtime.aiCoordinator.getAdminSnapshot();
  assert.equal(admin.configuredProvider, "llamacpp");
  assert.equal(admin.activeProvider, "llamacpp");
  assert.equal(admin.mode, "shadow");
  assert.equal(admin.jsonMode, "auto");
  assert.equal(admin.endpoint, "http://ai-server:8080");
  assert.equal(admin.apiKeyConfigured, true);
  assert.deepEqual(admin.models, { summary: "qwen3.8-27b", reasoning: "qwen3.8-27b" });
  assert.deepEqual(admin.features, ["article_summary", "country_insight", "market_explanation"]);
  assert.deepEqual(admin.queue, { depth: 0, active: 0, maxSize: 50, concurrency: 1 });
  assert.equal(admin.transport.calls, 0);
  assert.equal(admin.transport.circuit.state, "closed");
  assert.doesNotMatch(JSON.stringify(admin), /test-llama-key|must-not-use|discarded|Authorization/);
}));

test("AI defaults remain none/off; unknown providers fail explicitly even when off", () => {
  const runtime = createAppServer({ market: { historyPersist: false } });
  assert.equal(runtime.config.ai.provider, "none");
  assert.equal(runtime.config.ai.mode, "off");
  assert.equal(runtime.aiCoordinator.getAdminSnapshot().transport.calls, 0);
  withEnv({ AI_PROVIDER: "llama-typo", AI_MODE: "off" }, () => {
    assert.throws(() => createAppServer(), { code: "AI_PROVIDER_INVALID" });
  });
});

test("provider overrides select the matching environment and never inherit NVIDIA secrets", () => withEnv({
  AI_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvidia-secret", NVIDIA_MODEL_SUMMARY: "nvidia-model",
  LLAMACPP_BASE_URL: "http://localhost:8080/v1", LLAMACPP_MODEL_SUMMARY: "local-model"
}, () => {
  const runtime = createAppServer({ ai: { provider: "llamacpp", mode: "shadow" }, market: { historyPersist: false } });
  assert.equal(runtime.config.ai.apiKey, "");
  assert.equal(runtime.config.ai.reasoningModel, "local-model");
  assert.equal(runtime.config.ai.allowPrivateHttp, false);
  assert.equal(runtime.aiCoordinator.provider.jsonMode, "auto");
}));

test("server preserves NVIDIA aliases, format and budget aliases", () => withEnv({
  AI_PROVIDER: "nvidia", AI_MODE: "shadow", NVIDIA_API_KEY: "test-nvidia-key",
  NVIDIA_SUMMARY_MODEL: "summary-legacy", NVIDIA_REASONING_MODEL: "reasoning-legacy",
  NVIDIA_STRUCTURED_OUTPUT_MODE: "response-format", AI_REQUEST_DAILY_BUDGET: "7", AI_TOKEN_DAILY_BUDGET: "9000"
}, () => {
  const runtime = createAppServer({ market: { historyPersist: false } });
  const admin = runtime.aiCoordinator.getAdminSnapshot();
  assert.equal(admin.activeProvider, "nvidia");
  assert.equal(admin.structuredOutputMode, "response-format");
  assert.deepEqual(admin.models, { summary: "summary-legacy", reasoning: "reasoning-legacy" });
  assert.equal(admin.budget.requestBudget, 7);
  assert.equal(admin.budget.tokenBudget, 9000);
}));

test("server rejects invalid llama.cpp JSON mode when enabled", () => withEnv({
  AI_PROVIDER: "llamacpp", AI_MODE: "shadow", LLAMACPP_BASE_URL: "http://localhost:8080/v1",
  LLAMACPP_MODEL_SUMMARY: "m", LLAMACPP_JSON_MODE: "guess"
}, () => assert.throws(() => createAppServer(), { code: "AI_JSON_MODE_INVALID" })));

test("server resolves relative market history dirs against the backend directory", () => {
  const runtime = createAppServer({
    disableBackgroundRefresh: true,
    market: {
      provider: "",
      fallbackProvider: "",
      historyDir: "data/custom-market",
      historyPersist: false
    }
  });

  const expected = path.resolve(path.dirname(fileURLToPath(new URL("../server.js", import.meta.url))), "data/custom-market");
  assert.equal(path.normalize(runtime.config.market.historyDir), path.normalize(expected));
});

test("server keeps market off-hours strategy and provider budgets from config", () => {
  const runtime = createAppServer({
    disableBackgroundRefresh: true,
    market: {
      provider: "twelve",
      fallbackProvider: "yahoo",
      offHoursStrategy: "skip",
      requestReserve: 2,
      intervalByBandMs: {
        GREEN: {
          activeIntervalMs: 120_000,
          offHoursIntervalMs: 1_800_000
        }
      },
      historyPersist: false
    },
    apiLimits: {
      twelveDailyLimit: 800,
      twelveDailyBudget: 600,
      twelveMinuteLimit: 8,
      twelveMinuteBudget: 4,
      yahooDailyLimit: 200,
      yahooDailyBudget: 150
    }
  });

  assert.equal(runtime.config.market.offHoursStrategy, "skip");
  assert.equal(runtime.config.market.requestReserve, 2);
  assert.equal(runtime.config.market.intervalByBandMs.GREEN.activeIntervalMs, 120_000);
  assert.equal(runtime.config.market.intervalByBandMs.GREEN.offHoursIntervalMs, 1_800_000);
  assert.equal(runtime.config.apiLimits.twelveDailyLimit, 800);
  assert.equal(runtime.config.apiLimits.twelveDailyBudget, 600);
  assert.equal(runtime.config.apiLimits.twelveMinuteLimit, 8);
  assert.equal(runtime.config.apiLimits.twelveMinuteBudget, 4);
  assert.equal(runtime.config.apiLimits.yahooDailyLimit, 200);
  assert.equal(runtime.config.apiLimits.yahooDailyBudget, 150);
});

test("server wires intraday cadence into Market Conditions without a symbol cap", () => {
  const runtime = createAppServer({
    disableBackgroundRefresh: true,
    market: {
      provider: "",
      fallbackProvider: "",
      historyPersist: false,
      intradayCandles: {
        enabled: false,
        interval: "5min",
        pollIntervalMs: 1_200_000
      }
    }
  });

  assert.equal(runtime.marketConditionsService.intradayCandlesEnabled, false);
  assert.equal(runtime.marketConditionsService.pollIntervalMs, 1_200_000);
  assert.equal("maxInstruments" in runtime.marketConditionsService, false);
});
