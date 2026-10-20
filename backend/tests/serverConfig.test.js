import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer, readConfig } from "../server.js";
import { RUNTIME_POLICY } from "../config/runtimePolicy.js";
import { storageConfig, storageCommandTimeout } from "../storage/config.js";
import { DEPLOYMENT_ENV_KEYS, unsupportedDeploymentVariables, validateDeploymentEnvironment } from "../config/deploymentEnv.js";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";

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

test("WebSocket transport budgets reach the live server configuration", () => withEnv({
  WS_MAX_MESSAGE_BYTES: "32768", WS_MAX_BUFFERED_BYTES: "131072",
  WS_MAX_QUEUE_BYTES: "131072", WS_MAX_QUEUE_ITEMS: "32",
  WS_SLOW_CLIENT_MS: "8000", WS_CLOSE_GRACE_MS: "4000"
}, () => {
  const runtime = createAppServer({ wsTransportLimits: {maxMessageBytes:32768,maxBufferedBytes:131072,maxQueueBytes:131072,maxQueueItems:32,slowClientMs:8000,closeGraceMs:4000}, market: { historyPersist: false } });
  assert.deepEqual(runtime.socketServer.getHealth().transportLimits, {
    maxMessageBytes: 32768, maxBufferedBytes: 131072, maxQueueBytes: 131072,
    maxQueueItems: 32, slowClientMs: 8000, closeGraceMs: 4000
  });
}));

test("server config enables all llama.cpp features in shadow with isolated credentials", () => withEnv({
  AI_PROVIDER: " LLAMACPP ", AI_MODE: "shadow",
  AI_FEATURES: "article-summary,country-insight,market-explanation,invalid,article-summary",
  LLAMACPP_BASE_URL: "http://ai-server:8080/v1?token=discarded#discarded",
  LLAMACPP_API_KEY: "test-llama-key", LLAMACPP_MODEL_SUMMARY: "qwen3.8-27b",
  LLAMACPP_MODEL_REASONING: "qwen3.8-27b", LLAMACPP_JSON_MODE: " AUTO ", LLAMACPP_ALLOW_PRIVATE_HTTP: "1",
  NVIDIA_API_KEY: "must-not-use-nvidia-key", NVIDIA_MODEL_SUMMARY: "must-not-use-nvidia-model",
  AI_TIMEOUT_MS: "180000", AI_MAX_CONCURRENCY: "1", AI_QUEUE_MAX: "50", AI_MAX_JOBS_PER_CYCLE: "4",
  PORT: "3000", HOST: "127.0.0.1"
}, () => {
  const runtime = createAppServer({ai:{features:["article-summary","country-insight","market-explanation"],maxQueueSize:50,maxConcurrency:1},market:{historyPersist:false}});
  assert.equal(runtime.config.host, "127.0.0.1");
  assert.equal(runtime.config.port, 3000);
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
test("disabled legacy AI does not inherit NVIDIA credentials, models or endpoint",()=>withEnv({AI_PROVIDER:"none",AI_MODE:"off",NVIDIA_API_KEY:"unused-secret",NVIDIA_MODEL_SUMMARY:"unused-model",LLAMACPP_MODEL_SUMMARY:"unused-local-model"},()=>{
 const config=readConfig();assert.equal(config.ai.baseUrl,"");assert.equal(config.ai.apiKey,"");assert.equal(config.ai.summaryModel,"");
 const runtime=createAppServer({market:{historyPersist:false}}),status=runtime.aiCoordinator.getAdminSnapshot();
 assert.equal(status.enabled,false);assert.equal(status.endpoint,null);assert.equal(status.apiKeyConfigured,false);assert.equal(status.transport.calls,0);
}));

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

test("server uses canonical NVIDIA deployment settings and internal output/budget policy", () => withEnv({
  AI_PROVIDER: "nvidia", AI_MODE: "shadow", NVIDIA_API_KEY: "test-nvidia-key",
  NVIDIA_MODEL_SUMMARY: "summary-model", NVIDIA_MODEL_REASONING: "reasoning-model",
  NVIDIA_STRUCTURED_OUTPUT_MODE: "response-format", AI_REQUEST_DAILY_BUDGET: "7", AI_TOKEN_DAILY_BUDGET: "9000"
}, () => {
  const runtime = createAppServer({ market: { historyPersist: false } });
  const admin = runtime.aiCoordinator.getAdminSnapshot();
  assert.equal(admin.activeProvider, "nvidia");
  assert.equal(admin.structuredOutputMode, RUNTIME_POLICY.ai.structuredOutputMode);
  assert.deepEqual(admin.models, { summary: "summary-model", reasoning: "reasoning-model" });
  assert.equal(admin.budget.requestBudget, RUNTIME_POLICY.ai.dailyRequestBudget);
  assert.equal(admin.budget.tokenBudget, RUNTIME_POLICY.ai.dailyTokenBudget);
}));

test("explicit programmatic llama.cpp settings still validate the JSON transport", () => withEnv({
  AI_PROVIDER: "llamacpp", AI_MODE: "shadow", LLAMACPP_BASE_URL: "http://localhost:8080/v1",
  LLAMACPP_MODEL_SUMMARY: "m", LLAMACPP_JSON_MODE: "guess"
}, () => assert.throws(() => createAppServer({ai:{jsonMode:"guess"}}), { code: "AI_JSON_MODE_INVALID" })));

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


test("retired environment tuning cannot change runtime limits or scheduling",()=>withEnv({
  STORAGE_ENABLED:"0",STORAGE_BUSINESS_ENABLED:"0",STORAGE_TIMEOUT_MS:"1",STORAGE_QUEUE_TIMEOUT_MS:"1",
  NEWS_INTERVAL_MS:"1",NEWS_DISPLAY_LIMIT:"1",NEWS_RSS_PIPELINE_MODE:"legacy",AI_TIMEOUT_MS:"1",AI_MAX_CONCURRENCY:"99",WS_MAX_QUEUE_ITEMS:"1",WATCHLIST_COUNTRIES:"XX"
},()=>{
  const config=readConfig();
  assert.equal(config.news.intervalMs,RUNTIME_POLICY.news.intervalMs);assert.equal(config.news.rssPipelineMode,"canonical");
  assert.equal(config.news.displayLimit,100);assert.equal(config.ai.timeoutMs,180000);assert.equal(config.ai.maxConcurrency,2);
  assert.equal(config.wsTransportLimits.maxQueueItems,64);assert.deepEqual(config.watchlistCountries,RUNTIME_POLICY.watchlistCountries);
  const storage=storageConfig({},{NODE_ENV:"production",STORAGE_ENABLED:"0",STORAGE_BUSINESS_ENABLED:"0",STORAGE_TIMEOUT_MS:"1"});
  assert.equal(storage.enabled,true);assert.equal(storage.businessEnabled,true);assert.equal(storage.timeoutMs,30000);assert.equal(storage.queueTimeoutMs,90000);
  assert.ok(storage.shutdownTimeoutMs>=storage.queueTimeoutMs+storageCommandTimeout(storage,"domain.call",{service:"advanced",method:"getSnapshot"}));
  assert.equal(storageCommandTimeout(storage,"news.collect"),180000);assert.equal(storageCommandTimeout(storage,"domain.call",{service:"news",method:"getProjection"}),90000);
  assert.ok(Number.isFinite(config.market.activeIntervalMs));assert.ok(Number.isFinite(config.news.intervalByBandMs.GREEN));
}));

test("environment examples contain only supported deployment settings without duplicate keys",()=>{
  for(const file of [".env.example",".env.production.example"]){
    const text=readFileSync(new URL(`../${file}`,import.meta.url),"utf8"),parsed=dotenv.parse(text);
    const keys=text.split("\n").filter(line=>/^[A-Z][A-Z0-9_]*=/.test(line)).map(line=>line.split("=")[0]);
    assert.equal(keys.length,new Set(keys).size,file);
    for(const key of Object.keys(parsed))assert.ok(DEPLOYMENT_ENV_KEYS.includes(key),`${file}: ${key}`);
    assert.equal(parsed.AI_PROVIDER,"none");assert.equal(parsed.AI_MODE,"off");
  }
});

test("policy and prior configurations stay unchanged when a caller overrides a cadence",()=>{
  const bands={GREEN:{activeIntervalMs:1,offHoursIntervalMs:1000}};
  readConfig({market:{provider:"twelve",intervalByBandMs:bands}});
  assert.equal(bands.GREEN.activeIntervalMs,1);
  assert.equal(readConfig().news.intervalMs,RUNTIME_POLICY.news.intervalMs);
  assert.throws(()=>{RUNTIME_POLICY.storage.timeoutMs=1;},TypeError);
});


test("deployment validation reports unsupported names and rejects ambiguous values without printing secrets",()=>{
  assert.deepEqual(unsupportedDeploymentVariables({NEWS_TIMEOUT_MS:"1",STORAGE_ENABLED:"0",NEWS_API_KEY:"private-secret",HOST:"localhost"}),["NEWS_TIMEOUT_MS","STORAGE_ENABLED"]);
  for(const env of [{PORT:"3000oops"},{PORT:"3e3"},{PORT:"0x100"},{AI_MODE:"shdaow"},{NEWS_PROVIDERS:"rss,unknown"},{ALLOW_LAN_ADMIN:"sometimes"}]){
    assert.throws(()=>validateDeploymentEnvironment({...env,NEWS_API_KEY:"private-secret"}),reason=>{
      assert.equal(reason.code,"CONFIG_INVALID_DEPLOYMENT");assert.doesNotMatch(reason.message,/private-secret/);return true;
    });
  }
  validateDeploymentEnvironment({PORT:"3000",AI_MODE:"off",NEWS_PROVIDERS:"rss,gnews",ALLOW_LAN_ADMIN:"0"});
});


test("explicit tool deadlines override profiles while isolated workers inherit resolved application budgets",()=>{
  const tool=storageConfig({timeoutMs:17},{NODE_ENV:"test"});
  assert.equal(storageCommandTimeout(tool,"domain.configure"),17);
  assert.equal(storageCommandTimeout(tool,"domain.call",{service:"sources",method:"run"}),17);
  const application=storageConfig({},{NODE_ENV:"production"}),reader=storageConfig({...application,analysisWorker:true},{NODE_ENV:"production"});
  assert.equal(storageCommandTimeout(reader,"domain.call",{service:"advanced",method:"getSnapshot"}),180000);
});
