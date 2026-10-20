import "./config/loadEnvironment.js";
import { RUNTIME_POLICY as POLICY } from "./config/runtimePolicy.js";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import routes from "./routes/index.js";
import stateManager from "./state/stateManager.js";
import { PipelineMonitor } from "./services/pipelineMonitor.js";
import RefreshOrchestratorService from "./services/refreshOrchestratorService.js";
import ManualRefreshService from "./services/manualRefreshService.js";
import apiQuotaTracker from "./services/admin/apiQuotaTrackerService.js";
import { providerRuntime } from "./services/providers/providerRuntime.js";
import { normalizeNewsQueryPacks } from "./services/news/newsQueryPackService.js";
import { RssAggregatorService } from "./services/news/rssAggregator.js";
import { NEWS_SOURCE_CATALOG, projectLegacyRssFeeds, validateNewsSourceCatalog } from "./services/news/newsSourceCatalog.js";
import { SignalCorrelatorService } from "./services/intel/signalCorrelator.js";
import { AdvancedIntelligenceService } from "./services/intel/advancedIntelligenceService.js";
import { MapLayerService } from "./services/map/mapLayerService.js";
import { MarketHistoryStore } from "./services/market/marketHistoryStore.js";
import { DailyCandleStore } from "./services/market/dailyCandleStore.js";
import { DailyCandleService } from "./services/market/dailyCandleService.js";
import { IntradayCandleService } from "./services/market/intradayCandleService.js";
import { TechnicalIndicatorService } from "./services/market/technicalIndicatorService.js";
import { NewsPriceCouplingService } from "./services/market/newsPriceCouplingService.js";
import { MarketWatchlistService } from "./services/market/marketWatchlistService.js";
import { MarketConditionsService } from "./services/market/marketConditionsService.js";
import { MarketDataService, MarketDataStoreAdapter, YahooClient } from "./services/marketData/index.js";
import { SlidingWindowRateLimiter } from "./services/marketData/rateLimit.js";
import { resolveVerifiedInstrumentReferences, listVerifiedInstruments } from "./services/market/instrumentRegistry.js";
import { calculateMinimumSafeIntervalMs, MarketCreditScheduler, TWELVE_BASIC_POLICY } from "./services/market/marketCreditScheduler.js";
import RetiredMediaService from "./services/agent/retiredMedia.js";
import agentRoutes from "./routes/agentRoutes.js";
import { loadAgentConfig, readyModel } from "./services/agent/config.js";
import { OpenCodeClient } from "./services/agent/opencodeClient.js";
import { AgentModelSelection } from "./services/agent/modelSelection.js";
import { prepareManagedAgentConfig, ManagedAgentRuntime } from "./services/agent/managedRuntime.js";
import { AgentMaintenance } from "./services/agent/maintenance.js";
import { createSocketServer } from "./websocket/socketServer.js";
import { errorHandler, notFoundHandler } from "./utils/error.js";
import { createLogger, requestLogger } from "./utils/logger.js";
import { queryParamAllowlist } from "./utils/queryParamAllowlist.js";
import { sensitiveRouteAuth } from "./middleware/sensitiveRouteAuth.js";
import { mcpOperatorAuth, readOperatorCredentials } from "./middleware/mcpOperatorAuth.js";
import { ForecastEvaluationService } from "./services/research/forecastEvaluationService.js";
import { ScenarioService, loadSignalPolicy } from "./services/research/scenarioService.js";
import { ResearchStore } from "./services/research/researchStore.js";
import { PipelinePersistence } from "./storage/pipelinePersistence.js";
import { createBusinessAdapters } from "./storage/businessAdapters.js";
import { StorageManager } from "./storage/StorageManager.js";
import { EventLedger } from "./services/research/eventLedger.js";
import { SecSourceAgent } from "./services/research/secSourceAgent.js";
import { OfficialSourceService, loadResearchSources } from "./services/research/officialSources.js";
import { HistoricalAcquisitionService } from "./services/market/historicalAcquisitionService.js";
import { HistoricalImportService } from "./services/market/historicalImportService.js";
import { TechnicalContextService } from "./services/market/technicalContextService.js";
import { NewsArchive } from "./services/research/newsArchive.js";
import { MaterialAlertStore } from "./services/research/materialAlertStore.js";
import { PortfolioContextService } from "./services/research/portfolioContext.js";
import { AiBudgetService } from "./services/ai/aiBudgetService.js";
import { AiEnrichmentStore } from "./services/ai/aiEnrichmentStore.js";
import { AiEnrichmentCoordinator } from "./services/ai/aiEnrichmentCoordinator.js";
import { AiProviderError, createAiProvider } from "./services/ai/aiProviders.js";
import { AwarenessStore } from "./services/awareness/awarenessStore.js";
import { AwarenessService, normalizeAwarenessMode } from "./services/awareness/awarenessService.js";
import { RuntimeMetrics } from "./services/runtimeMetrics.js";
import { setImmediate as yieldToRuntime } from "node:timers/promises";

const log = createLogger("backend/server");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_NEWS_QUERY_PACKS = Object.freeze({
  defense: "missile OR defense contractor OR arms deal OR air defense",
  energy: "oil OR gas OR lng OR pipeline OR refinery",
  sanctions: "sanctions OR export controls OR secondary sanctions",
  shipping: "shipping lane OR tanker OR strait OR maritime security",
  macro: "central bank OR inflation OR tariffs OR sovereign risk",
  semiconductors: "semiconductor OR chip export OR foundry OR fab"
});
const DEFAULT_RSS_PROJECTION = projectLegacyRssFeeds(NEWS_SOURCE_CATALOG);
const DEFAULT_RSS_FEEDS = Object.freeze(DEFAULT_RSS_PROJECTION.filter((feed) => !feed.disabled));
const DEFAULT_RSS_DISABLED_FEEDS = Object.freeze(DEFAULT_RSS_PROJECTION.filter((feed) => feed.disabled));

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}



function toList(value, fallback = []) {
  if (!value) {
    return [...fallback];
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}


function mergeNewsQueryPackGroups(baseGroups = {}, overrides = {}, marketTickers = []) {
  const overrideSource = overrides.queryPackGroups || overrides.queryPacks || {};
  const normalizedOverrides = normalizeNewsQueryPacks(overrideSource, {
    marketTickers,
    defaultEditorialPacks: {}
  });

  return {
    editorial: {
      ...(baseGroups.editorial || {}),
      ...(normalizedOverrides.editorial || {})
    },
    marketSignals: {
      ...(baseGroups.marketSignals || {}),
      ...(normalizedOverrides.marketSignals || {})
    }
  };
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toFeedList(value, fallback = DEFAULT_RSS_FEEDS, options = {}) {
  const { disabled = false } = options;
  if (!value) {
    return structuredClone(fallback).map((entry) => ({
      ...entry,
      disabled: Boolean(entry.disabled || disabled),
      reason: entry.reason || (disabled ? "feed-disabled" : null)
    }));
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, url, reason] = entry.includes("|") ? entry.split("|") : [entry, entry, ""];
      return {
        label: String(label || "").trim(),
        url: String(url || "").trim(),
        disabled,
        reason: disabled ? String(reason || "feed-disabled").trim() : null
      };
    })
    .filter((entry) => entry.url);
}

function mergeFeedLists(activeFeeds = [], disabledFeeds = []) {
  const merged = new Map();

  for (const feed of Array.isArray(activeFeeds) ? activeFeeds : []) {
    const key = String(feed?.url || "").trim().toLowerCase();
    if (!key) {
      continue;
    }
    merged.set(key, {
      ...feed,
      disabled: false,
      reason: null
    });
  }

  for (const feed of Array.isArray(disabledFeeds) ? disabledFeeds : []) {
    const key = String(feed?.url || "").trim().toLowerCase();
    if (!key) {
      continue;
    }
    const current = merged.get(key) || {};
    merged.set(key, {
      ...current,
      ...feed,
      disabled: true,
      reason: feed.reason || current.reason || "feed-disabled"
    });
  }

  return [...merged.values()];
}

function isRealKey(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith("your_")) {
    return false;
  }
  if (lower.startsWith("***")) {
    return false;
  }
  if (lower.includes("placeholder")) {
    return false;
  }

  return true;
}

const MARKET_PROVIDERS = new Set(["twelve", "yahoo"]);

function normalizeMarketProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MARKET_PROVIDERS.has(normalized) ? normalized : "";
}

function resolveDefaultMarketFallbackProvider(provider = "") {
  return provider === "twelve" ? "yahoo" : "";
}

function resolveMarketProviderChain(provider = "", fallbackProvider = "") {
  return [provider, fallbackProvider].filter(Boolean).join("+") || null;
}

function resolveMarketHistoryDir(value) {
  const candidate = String(value || "").trim();
  if (!candidate) {
    return path.resolve(__dirname, "./data/market");
  }

  return path.isAbsolute(candidate) ? candidate : path.resolve(__dirname, candidate);
}

function normalizeMarketOffHoursStrategy(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["skip", "yahoo", "keep"].includes(normalized) ? normalized : "keep";
}

const AI_PROVIDERS = new Set(["none", "nvidia", "llamacpp"]);
const AI_MODES = new Set(["off", "shadow", "visible"]);

function normalizeAiProvider(value = "") {
  const normalized = String(value || "none").trim().toLowerCase();
  if (!AI_PROVIDERS.has(normalized)) throw new AiProviderError("AI_PROVIDER_INVALID", "AI_PROVIDER must be none, nvidia or llamacpp.");
  return normalized;
}

function normalizeAiMode(value = "") {
  const normalized = String(value || "off").trim().toLowerCase();
  return AI_MODES.has(normalized) ? normalized : "off";
}


export function readConfig(overrides = {}) {
  validateNewsSourceCatalog(NEWS_SOURCE_CATALOG);
  const aiProvider = normalizeAiProvider(overrides.ai?.provider ?? process.env.AI_PROVIDER);
  // Select the environment before merging overrides to keep credentials and
  // model names isolated when the provider changes.
  const aiTransport = aiProvider === "llamacpp" ? {
    baseUrl: process.env.LLAMACPP_BASE_URL || "",
    apiKey: process.env.LLAMACPP_API_KEY || "",
    summaryModel: process.env.LLAMACPP_MODEL_SUMMARY || "",
    reasoningModel: process.env.LLAMACPP_MODEL_REASONING || process.env.LLAMACPP_MODEL_SUMMARY || "",
    jsonMode: POLICY.ai.jsonMode,
    allowPrivateHttp: toBool(process.env.LLAMACPP_ALLOW_PRIVATE_HTTP, false)
  } : aiProvider === "nvidia" ? {
    baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    apiKey: process.env.NVIDIA_API_KEY || "",
    structuredOutputMode: POLICY.ai.structuredOutputMode,
    summaryModel: process.env.NVIDIA_MODEL_SUMMARY || "",
    reasoningModel: process.env.NVIDIA_MODEL_REASONING || process.env.NVIDIA_MODEL_SUMMARY || ""
  } : {baseUrl:"",apiKey:"",summaryModel:"",reasoningModel:""};
  const newsOverrides = overrides.news || {};
  const watchlistCountries = [...POLICY.watchlistCountries];
  const newsProviders = toList(process.env.NEWS_PROVIDERS, ["rss"]).map(provider=>provider.toLowerCase());
  const rssActiveFeeds = toFeedList(process.env.NEWS_RSS_FEEDS, DEFAULT_RSS_FEEDS);
  const rssDisabledFeeds = toFeedList(process.env.NEWS_RSS_DISABLED_FEEDS, DEFAULT_RSS_DISABLED_FEEDS, {disabled:true});
  const envMarketProvider = toTrimmedString(process.env.MARKET_PROVIDER);
  const envMarketFallbackProvider = toTrimmedString(process.env.MARKET_PROVIDER_FALLBACK);
  // Selection is already persisted and managed through the watchlist API.
  const configuredMarketTickers = [];
  const marketTickers = [];
  const marketCreditPolicy = {...TWELVE_BASIC_POLICY};
  const normalizedNewsQueryPacks = normalizeNewsQueryPacks(DEFAULT_NEWS_QUERY_PACKS, {marketTickers,defaultEditorialPacks:DEFAULT_NEWS_QUERY_PACKS});

  const config = {
    port: toInt(process.env.PORT, 3000),
    host: toTrimmedString(process.env.HOST) || undefined,
    refreshIntervalMs: POLICY.refreshIntervalMs,
    wsHeartbeatMs: POLICY.wsHeartbeatMs,
    wsTransportLimits: {...POLICY.wsTransportLimits},
    wsTrustedProxyIps: toList(process.env.WS_TRUSTED_PROXY_IPS),
    wsAllowedOrigins: toList(process.env.WS_ALLOWED_ORIGINS),
    wsPath: "/ws",
    watchlistCountries,
    manualRefresh: {...POLICY.manualRefresh},
    news: {
      ...structuredClone(POLICY.news),
      providers: newsProviders,
      newsApiKey: process.env.NEWS_API_KEY || "",
      newsApiBaseUrl: process.env.NEWS_API_BASE_URL || "https://newsapi.org/v2",
      gnewsApiKey: process.env.GNEWS_API_KEY || "",
      gnewsBaseUrl: process.env.GNEWS_BASE_URL || "https://gnews.io/api/v4",
      mediastackApiKey: process.env.MEDIASTACK_API_KEY || "",
      mediastackBaseUrl: process.env.MEDIASTACK_BASE_URL || "https://api.mediastack.com/v1",
      gdeltBaseUrl: process.env.GDELT_BASE_URL || "https://api.gdeltproject.org/api/v2/doc/doc",
      rssFeeds: mergeFeedLists(rssActiveFeeds, rssDisabledFeeds),
      rssDisabledFeeds,
      sourceCatalog: NEWS_SOURCE_CATALOG,
      queryPacks: normalizedNewsQueryPacks.flattened,
      queryPackGroups: normalizedNewsQueryPacks,
      rssCanonicalStateFile: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, process.env.NEWS_RSS_CANONICAL_STATE_FILE || "data/rss-canonical-state.json"),
      countries: watchlistCountries,
      marketTickers
    },
    awareness: {
      ...POLICY.awareness,
      mode: normalizeAwarenessMode(process.env.AWARENESS_MODE || "off"),
      userAgent: process.env.AWARENESS_USER_AGENT || "OGID-awareness/1.0 (+https://localhost; contact: local-operator)",
      snapshotPath: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, process.env.AWARENESS_STATE_FILE || "data/intel/awareness-events.json"),
      auditPath: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, process.env.AWARENESS_AUDIT_FILE || "data/intel/awareness-events.jsonl"),
      pollAuditPath: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, process.env.AWARENESS_POLL_AUDIT_FILE || "data/intel/awareness-polls.jsonl")
    },
    ai: {
      ...structuredClone(POLICY.ai),
      provider: aiProvider,
      mode: normalizeAiMode(process.env.AI_MODE),
      ...aiTransport,
      stateFile: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, process.env.AI_STATE_FILE || "data/ai/ai-enrichments.json"),
      budgetStateFile: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, process.env.AI_BUDGET_STATE_FILE || "data/ai/ai-budget.json")
    },
    market: {
      ...structuredClone(POLICY.market),
      enabled: Boolean(envMarketProvider),
      provider: normalizeMarketProvider(envMarketProvider),
      fallbackProvider: envMarketProvider ? normalizeMarketProvider(envMarketFallbackProvider) : "",
      disabledReason: envMarketProvider ? null : "market-provider-empty",
      providerChain: null,
      twelveApiKey: process.env.MARKET_TWELVE_API_KEY || "",
      twelveBaseUrl: process.env.MARKET_TWELVE_BASE_URL || "https://api.twelvedata.com",
      yahooBaseUrl: process.env.MARKET_YAHOO_BASE_URL || "https://finance.yahoo.com",
      tickers: marketTickers,
      initialTickers: configuredMarketTickers,
      historyDir: resolveMarketHistoryDir(process.env.MARKET_HISTORY_DIR),
      snapshotFile: process.env.MARKET_SNAPSHOT_FILE || "snapshot.json",
      creditPolicy: marketCreditPolicy,
      creditStateFile: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, process.env.MARKET_CREDIT_STATE_FILE || "data/market-credit-state.json"),
      dailyCandles: {...POLICY.market.dailyCandles,enabled:process.env.NODE_ENV !== "test" && POLICY.market.dailyCandles.enabled},
      intradayCandles: {...POLICY.market.intradayCandles,enabled:process.env.NODE_ENV !== "test" && POLICY.market.intradayCandles.enabled}
    },
    apiLimits: {
      ...POLICY.apiLimits,
      twelveDailyLimit: marketCreditPolicy.declaredDailyLimit,
      twelveDailyBudget: marketCreditPolicy.internalHardLimit,
      twelveMinuteLimit: marketCreditPolicy.declaredMinuteLimit,
      twelveMinuteBudget: marketCreditPolicy.absoluteMinuteLimit
    },
    media: {status:'retired'},
    security: {
      adminApiToken: process.env.ADMIN_API_TOKEN || "",
      allowLocalAdmin: toBool(process.env.ALLOW_LOCAL_ADMIN, true),
      allowLanAdmin: toBool(process.env.ALLOW_LAN_ADMIN, true)
    }
  };
  const mergedConfig = {
    ...config,
    ...overrides,
    watchlistCountries: overrides.watchlistCountries || config.watchlistCountries,
    manualRefresh: {
      ...config.manualRefresh,
      ...(overrides.manualRefresh || {})
    },
    news: {
      ...config.news,
      ...newsOverrides,
      rssDisabledFeeds: newsOverrides.rssDisabledFeeds || config.news.rssDisabledFeeds,
      rssFeeds: Array.isArray(newsOverrides.rssFeeds)
        ? structuredClone(newsOverrides.rssFeeds)
        : mergeFeedLists(
            (config.news.rssFeeds || []).filter((feed) => !feed.disabled),
            newsOverrides.rssDisabledFeeds || config.news.rssDisabledFeeds
          ),
      intervalMs:
        newsOverrides.intervalMs ||
        overrides.refreshIntervalMs ||
        newsOverrides.refreshIntervalMs ||
        config.news.intervalMs,
      intervalByBandMs: {
        ...config.news.intervalByBandMs,
        ...(newsOverrides.intervalByBandMs || {})
      },
      pageSizeByBand: {
        ...config.news.pageSizeByBand,
        ...(newsOverrides.pageSizeByBand || {})
      },
      countries:
        newsOverrides.countries ||
        overrides.watchlistCountries ||
        config.news.countries,
      marketTickers: newsOverrides.marketTickers || config.news.marketTickers
    },
    market: {
      ...config.market,
      ...(overrides.market || {}),
      historyDir: resolveMarketHistoryDir(overrides.market?.historyDir ?? config.market.historyDir),
      activeIntervalMs:
        overrides.market?.activeIntervalMs ||
        overrides.market?.refreshIntervalMs ||
        config.market.activeIntervalMs,
      offHoursIntervalMs:
        overrides.market?.offHoursIntervalMs ||
        Math.max(overrides.market?.refreshIntervalMs || 0, config.market.offHoursIntervalMs),
      intervalByBandMs: {
        ...config.market.intervalByBandMs,
        ...(overrides.market?.intervalByBandMs || {})
      }
    },
    ai: {
      ...config.ai,
      ...(overrides.ai || {}),
      provider: aiProvider,
      reasoningModel: overrides.ai?.reasoningModel ?? overrides.ai?.summaryModel ?? config.ai.reasoningModel,
      features: overrides.ai?.features || config.ai.features
    },
    awareness: {
      ...config.awareness,
      ...(overrides.awareness || {}),
      mode: normalizeAwarenessMode(overrides.awareness?.mode || config.awareness.mode)
    },
    apiLimits: {
      ...config.apiLimits,
      ...(overrides.apiLimits || {})
    },
    media: {status:'retired'},
    security: {
      ...config.security,
      ...(overrides.security || {})
    },
    runtime: {
      disableBackgroundRefresh:
        overrides.runtime?.disableBackgroundRefresh ??
        overrides.disableBackgroundRefresh ??
        process.env.NODE_ENV === "test"
    }
  };

  const resolvedMarketTickers = overrides.market?.tickers || config.market.tickers;
  mergedConfig.market.initialTickers = overrides.market?.tickers || mergedConfig.market.initialTickers;
  const mergedQueryPackGroups = mergeNewsQueryPackGroups(
    config.news.queryPackGroups,
    newsOverrides,
    resolvedMarketTickers
  );
  mergedConfig.news = {
    ...mergedConfig.news,
    queryPackGroups: mergedQueryPackGroups,
    queryPacks: {
      ...mergedQueryPackGroups.editorial,
      ...mergedQueryPackGroups.marketSignals
    }
  };

  const requestedMarketProvider = toTrimmedString(mergedConfig.market?.provider);
  const resolvedMarketProvider = normalizeMarketProvider(requestedMarketProvider);
  const requestedMarketFallbackProvider = toTrimmedString(mergedConfig.market?.fallbackProvider);
  const resolvedMarketFallbackProvider = normalizeMarketProvider(requestedMarketFallbackProvider);
  const marketEnabledOverride = Object.prototype.hasOwnProperty.call(overrides.market || {}, "enabled")
    ? overrides.market.enabled
    : undefined;
  const requestedMarketEnabled =
    marketEnabledOverride !== undefined ? marketEnabledOverride !== false : Boolean(requestedMarketProvider);
  const fallbackProvider =
    requestedMarketEnabled && resolvedMarketProvider
      ? resolvedMarketFallbackProvider && resolvedMarketFallbackProvider !== resolvedMarketProvider
        ? resolvedMarketFallbackProvider
        : resolveDefaultMarketFallbackProvider(resolvedMarketProvider)
      : "";
  const marketEnabled = requestedMarketEnabled && Boolean(resolvedMarketProvider);
  const disabledReason = marketEnabled
    ? null
    : requestedMarketProvider && !resolvedMarketProvider
      ? "market-provider-invalid"
      : "market-provider-empty";

  mergedConfig.market = {
    ...mergedConfig.market,
    enabled: marketEnabled,
    provider: marketEnabled ? resolvedMarketProvider : "",
    fallbackProvider,
    providerChain: marketEnabled ? resolveMarketProviderChain(resolvedMarketProvider, fallbackProvider) : null,
    offHoursStrategy: normalizeMarketOffHoursStrategy(mergedConfig.market?.offHoursStrategy),
    disabledReason
  };

  const instruments=resolveVerifiedInstrumentReferences(mergedConfig.market.tickers).instruments;
  const safeMarketActiveIntervalMs=marketEnabled && resolvedMarketProvider === "twelve"
    ? calculateMinimumSafeIntervalMs({symbolCount:Math.max(1,instruments.filter(i=>i.refreshTier === "hot").length),dailyBudget:mergedConfig.market.creditPolicy.normalSoftLimit,policy:mergedConfig.market.creditPolicy}) : 0;
  mergedConfig.market.minimumSafeActiveIntervalMs=safeMarketActiveIntervalMs;
  mergedConfig.market.activeIntervalMs=Math.max(mergedConfig.market.activeIntervalMs,safeMarketActiveIntervalMs);
  for(const [key,band] of Object.entries(mergedConfig.market.intervalByBandMs))mergedConfig.market.intervalByBandMs[key]={...band,activeIntervalMs:Math.max(band.activeIntervalMs,safeMarketActiveIntervalMs)};
  return mergedConfig;
}

export function createAppServer(overrides = {}) {
  const config = readConfig(overrides);
  let agentConfig;
  try{agentConfig=prepareManagedAgentConfig(loadAgentConfig(process.env,overrides.agent || {}));}catch{
    agentConfig=loadAgentConfig({}, {mode:'off',health:{state:'degraded',errorCode:'AGENT_CONFIGURATION_UNAVAILABLE'}});
    log.warn('agent_configuration_unavailable',{code:'AGENT_CONFIGURATION_UNAVAILABLE'});
  }
  if((agentConfig.mode !== 'off'||agentConfig.health?.state==='degraded') && config.ai.provider === 'llamacpp')config.ai.mode='off';
  const storageManager = overrides.storageManager || new StorageManager(overrides.storage);

  const frontendPath = path.resolve(__dirname, "../frontend");
  const app = express();
  const runtimeMetrics = new RuntimeMetrics();
  app.locals.runtimeMetrics = runtimeMetrics;
  app.use(runtimeMetrics.middleware());

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
          imgSrc: ["'self'", "data:", "blob:", "https:"],
          connectSrc: ["'self'", "ws:", "wss:"],
          frameSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'self'"],
          upgradeInsecureRequests: null
        }
      }
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(requestLogger);
  app.use((req,res,next)=>{
    if(app.locals.initializing && req.path.startsWith("/api/") && !["/api/health","/api/health/live","/api/health/ready"].includes(req.path))return res.status(503).json({ok:false,error:{code:"BACKEND_INITIALIZING",message:"Inicializando almacenamiento y pipelines; consultar /api/health/ready."}});
    next();
  });
  app.use(mcpOperatorAuth);
  app.use("/api", agentRoutes);
  app.use(sensitiveRouteAuth);

  app.use(express.static(frontendPath, { index: "index.html" }));
  app.use("/api", queryParamAllowlist, routes);
  app.get(["/admin", "/admin/"], (_req, res) => {
    res.sendFile(path.join(frontendPath, "admin.html"));
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(frontendPath, "index.html"));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  config.market.creditScheduler = config.market.provider === "twelve" ? new MarketCreditScheduler({
    policy: { ...TWELVE_BASIC_POLICY, ...(config.market.creditPolicy || {}) },
    persistencePath: config.market.creditStateFile
  }) : null;
  const sqlBusiness = storageManager.options.businessEnabled && storageManager.options.enabled;
  let businessContext = () => undefined;
  const pipelinePersistence = sqlBusiness ? new PipelinePersistence(storageManager) : null;
  const business = sqlBusiness ? createBusinessAdapters(storageManager, {rootDir:config.market.historyDir,enabled:config.market?.dailyCandles?.enabled !== false || config.market?.intradayCandles?.enabled === true,context:()=>businessContext()}) : null;
  if (business) config.news.rssWorkerFetch = input => storageManager.request("rss.fetch",input);
  if (business) config.news.collectInWorker = async input => {
    const result=await storageManager.request("news.collect",{...input,deferSupplemental:true});
    if(result.supplementalDue){
      const task=storageManager.request("news.supplemental",{});
      activeCycles.add(task);
      task.catch(error=>log.warn("rss_supplemental_failed",{code:error.code || "RSS_SUPPLEMENTAL_FAILED"})).finally(()=>activeCycles.delete(task));
    }
    return result;
  };
  const dailyCandleStore = business?.candles || new DailyCandleStore({
    enabled: config.market?.dailyCandles?.enabled !== false || config.market?.intradayCandles?.enabled === true,
    rootDir: config.market?.historyDir,
    retentionDays: config.market?.dailyCandles?.retentionDays,
    rolloutBatch: config.market?.watchlistRollout,
    intervals: [config.market?.intradayCandles?.interval || "1h", "1h", "1wk", "1mo"]
  });
  const marketDataStore = new MarketDataStoreAdapter({ candleStore: dailyCandleStore,readThrough:!business,persistAsync:Boolean(business),
    onPersistenceError:error=>log.error("market_observations_persist_failed",{code:error.code || "MARKET_PERSISTENCE_FAILED"}),
    onPersisted:business ? async({candles,persistence})=>{
      if(!persistence.inserted && !persistence.updated)return;
      for(const candle of new Map(candles.map(c=>[`${c.instrumentId}|${c.interval}`,c])).values())
        await business.call("indicators","calculate",[{instrumentId:candle.instrumentId,interval:candle.interval,adjustmentMode:"splits",limit:500}]);
    } : null
  });
  const marketDataService = overrides.marketDataService || config.market.marketDataService || new MarketDataService({
    yahooClient: overrides.yahooClient || new YahooClient({ timeoutMs: config.market.timeoutMs }),
    store: marketDataStore
  });
  config.market.marketDataService = marketDataService;
  const marketSearchRateLimiter = overrides.marketSearchRateLimiter || new SlidingWindowRateLimiter({ maxRequests: 30, windowMs: 60_000, maxKeys: 1_000 });
  const researchSources = overrides.researchSources || loadResearchSources(process.env.RESEARCH_SOURCES_FILE);
  const marketWatchlistService = new MarketWatchlistService({
    rolloutBatch: config.market.watchlistRollout,
    initialReferences: config.market.initialTickers,
    maxSelected: null,
    persistencePath: process.env.NODE_ENV === "test" ? null : path.join(config.market.historyDir, "watchlist-selection.json"),
    legacySnapshotPath: process.env.NODE_ENV === "test" ? null : path.join(config.market.historyDir, config.market.snapshotFile),
    creditPolicy: config.market.creditScheduler?.policy || null,
    instrumentResolver: (symbol) => marketDataService.resolveInstrument(symbol)
  });
  config.market.watchlistService = marketWatchlistService;
  config.market.tickers = marketWatchlistService.selectedSymbols();
  config.news.marketTickers = config.market.tickers;

  stateManager.reset({
    refreshIntervalMs: config.news.intervalMs,
    watchlistCountries: config.watchlistCountries,
    marketTickers: config.market.tickers,
    marketWatchlistRollout: config.market.watchlistRollout,
    impactWindowMin: config.market.impactWindowMin,
    marketEnabled: config.market.enabled,
    marketDisabledReason: config.market.disabledReason
  });
  apiQuotaTracker.reset(config.apiLimits);
  providerRuntime.reset();
  if (!business && process.env.NODE_ENV !== "test") {
    apiQuotaTracker.configurePersistence(path.resolve(__dirname, process.env.PROVIDER_QUOTA_STATE_FILE || "data/provider-quota-state.json"));
  }
  const researchStore = overrides.researchStore || business?.store || new ResearchStore({persistencePath:process.env.NODE_ENV === "test"?null:path.resolve(__dirname,process.env.RESEARCH_LEDGER_FILE || "data/intel/research-ledger.json")});
  const eventLedger = business?.events || new EventLedger({store:researchStore});
  const officialSourceService = business?.sources || new OfficialSourceService({store:researchStore,eventLedger,sources:researchSources,userAgent:process.env.RESEARCH_SEC_USER_AGENT || null});
  const newsArchive = overrides.newsArchive || business?.news || new NewsArchive({ persistencePath: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, process.env.RESEARCH_NEWS_ARCHIVE_FILE || "data/intel/research-news.json") });
  const researchPipeline={};
  const monitor = new PipelineMonitor({publish:(id,stage)=>{
    stateManager.state.pipelineStatus={...stateManager.state.pipelineStatus,[id]:stage};
    socketServer.broadcast("update",{pipelineStatus:stateManager.state.pipelineStatus});
  },persist:business?(id,stage)=>pipelinePersistence.save("pipeline-stage",{id,stage}):null});
  if(business){
    config.market.newsFromStorage=true;
    config.market.analyzeInWorker=input=>monitor.run("market.analysis",()=>business.call("market","analyze",[input]),{
      counts:result=>({processed:result.newsCoverage?.analysisArticleCount ?? result.impact?.items?.length ?? 0}),
      revision:result=>result.newsCoverage?.revision ?? null
    });
  }
  const secSourceAgent=new SecSourceAgent({service:officialSourceService,
    instruments:()=>marketWatchlistService.selectedInstruments(),userAgent:process.env.RESEARCH_SEC_USER_AGENT || "",monitor});
  storageManager.on("stage",(id,stage)=>monitor.update(id,stage));
  storageManager.on("stage",(id,stage)=>{if(id==="storage" && stage.reason?.startsWith("configure."))log.info("storage_initializing",{stage:stage.reason});});
  const researchGuard=async(component,work)=>{
    try{const result=await monitor.run(`research.${component}`,work);const pendingReplay=component==="scenarios"?false:Boolean(researchPipeline[component]?.pendingReplay);researchPipeline[component]={...monitor.snapshot()[`research.${component}`],status:pendingReplay?"partial":"completed",pendingReplay};return result;}
    catch(error){researchPipeline[component]={...monitor.snapshot()[`research.${component}`],failureCode:error.code || "RESEARCH_PIPELINE_ERROR",pendingReplay:true};log.warn("research_pipeline_blocked",{component,code:error.code || "RESEARCH_PIPELINE_ERROR"});return null;}
  };
  if (!business) newsArchive.onIngest = items => researchGuard("archiveEvents",()=>{for(let offset=0;offset<items.length;offset+=500)eventLedger.ingest(items.slice(offset,offset+500));});
  const materialAlertStore = overrides.materialAlertStore || business?.alerts || new MaterialAlertStore({ persistencePath: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, process.env.RESEARCH_ALERT_STATE_FILE || "data/intel/research-alerts.json") });
  const rssAggregator = business?.rss || new RssAggregatorService({
    onCollected: async articles => {
      for (let offset=0; offset<articles.length; offset+=500) {
        newsArchive.ingest(articles.slice(offset,offset+500), { awarenessMode:config.awareness.mode });
        if (offset+500<articles.length) await yieldToRuntime();
      }
    },
    news: config.news,
    rssFeeds: config.news.rssFeeds,
    refreshIntervalMs: config.news.rssAggregateIntervalMs,
    maxFeedsPerRun: config.news.rssAggregateFeedsPerRun,
    maxCorpusItems: config.news.rssAggregateMaxItems,
    timeoutMs: config.news.timeoutMs,
    pipelineMode: config.news.rssPipelineMode,
    globalConcurrency: config.news.rssGlobalConcurrency,
    hostConcurrency: config.news.rssHostConcurrency,
    cycleDeadlineMs: config.news.rssCycleDeadlineMs,
    persistencePath: config.news.rssCanonicalStateFile
  });
  const aiStore = new AiEnrichmentStore({ persistencePath: business ? null : config.ai.stateFile });
  const aiBudget = new AiBudgetService({
    dailyRequestBudget: config.ai.dailyRequestBudget,
    dailyTokenBudget: config.ai.dailyTokenBudget,
    persistencePath: business ? null : config.ai.budgetStateFile
  });
  const aiProvider = createAiProvider(config.ai, overrides.aiProvider);
  const signalCorrelator = overrides.signalCorrelator || business?.signals || new SignalCorrelatorService({
    baselineDays: 30,
    persistencePath: process.env.NODE_ENV === "test" ? null : path.resolve(__dirname, "data/intel/signal-history.json")
  });
  const advancedIntelligenceService = overrides.advancedIntelligenceService || business?.advanced || new AdvancedIntelligenceService({
    stateManager,
    rssAggregator,
    signalCorrelator
  });
  const mapLayerService = business?.map || new MapLayerService({
    stateManager,
    rssAggregator
  });
  const marketHistoryStore = new MarketHistoryStore({
    enabled: config.market?.historyPersist !== false,
    rootDir: config.market?.historyDir,
    snapshotFile: config.market?.snapshotFile,
    tickers: config.market?.tickers || []
  });
  const mediaStreamService = new RetiredMediaService();
  const dailyCandleService = new DailyCandleService({ store: dailyCandleStore, marketConfig: config.market });
  const intradayCandleService = new IntradayCandleService({ store: dailyCandleStore, marketConfig: config.market });
  const technicalIndicatorService = business?.indicators || new TechnicalIndicatorService({ store: dailyCandleStore });
  const newsPriceCouplingService = business?.coupling || new NewsPriceCouplingService({ store: dailyCandleStore });

  const server = http.createServer(app);
  const socketServer = createSocketServer({
    server,
    path: config.wsPath,
    heartbeatMs: config.wsHeartbeatMs,
    transportLimits: config.wsTransportLimits,
    trustedProxyIps: config.wsTrustedProxyIps,
    allowedOrigins: config.wsAllowedOrigins,
    stateManager
  });
  app.locals.socketServer = socketServer;
  const awarenessStore = overrides.awarenessStore || new AwarenessStore({
    snapshotPath: business ? null : config.awareness.snapshotPath,
    auditPath: business ? null : config.awareness.auditPath,
    pollAuditPath: business ? null : config.awareness.pollAuditPath
  });
  const awarenessService = overrides.awarenessService || new AwarenessService({
    mode: config.awareness.mode,
    store: awarenessStore,
    stateManager,
    socketServer,
    timeoutMs: config.awareness.timeoutMs,
    userAgent: config.awareness.userAgent,
    globalConcurrency: config.awareness.globalConcurrency,
    hostConcurrency: config.awareness.hostConcurrency,
    persistent403Threshold: config.awareness.persistent403Threshold,
    forbiddenCooldownMs: config.awareness.forbiddenCooldownMs
  });
  const marketConditionsService = overrides.marketConditionsService || business?.conditions || new MarketConditionsService({
    stateManager,
    candleStore: dailyCandleStore,
    marketWatchlistService,
    newsPriceCouplingService,
    awarenessService,
    intradayCandleService,
    pollIntervalMs: config.market.intradayCandles.pollIntervalMs,
    intradayCandlesEnabled: config.market.intradayCandles.enabled
  });
  const aiCoordinator = new AiEnrichmentCoordinator({
    config: config.ai,
    provider: aiProvider,
    store: aiStore,
    budget: aiBudget,
    stateManager,
    socketServer,
    technicalIndicatorService,
    newsPriceCouplingService
  });
  aiCoordinator.syncProjection();
  mediaStreamService.setSocketServer(socketServer);
  const orchestrator = new RefreshOrchestratorService({
    newsArchive,
    stateManager,
    socketServer,
    config,
    rssAggregator,
    signalCorrelator,
    mapLayerService,
    marketHistoryStore,
    dailyCandleService,
    intradayCandleService,
    aiCoordinator,
    awarenessService
  });
  for(const [method,id]of [["executeNewsCycle","news"],["executeMarketCycle","market"]]){
    const run=orchestrator[method].bind(orchestrator);
    orchestrator[method]=(...args)=>monitor.run(id,()=>run(...args),{enabled:id!=="market"||config.market.enabled,counts:()=>{
      const telemetry=id==="news"?orchestrator.getNewsCycleTelemetry():orchestrator.getMarketCycleTelemetry();
      const snapshot=stateManager.state;
      const count=id==="news"?snapshot.news.length:Object.values(snapshot.market.quotes).filter(q=>Number.isFinite(q.price)&&q.synthetic!==true).length;
      const mode=id==="news"?snapshot.meta.sourceMode:snapshot.market.sourceMode;
      const qualityDegraded=["fallback","unavailable","stale","mixed"].includes(mode);
      return {processed:count,degraded:telemetry.lastStatus==="error"||count===0||qualityDegraded,reason:telemetry.lastError || (qualityDegraded?`data-${mode}`:count===0?"no-valid-observations":null)};
    },revision:()=>socketServer.sync.revision});
  }
  const manualRefreshService = new ManualRefreshService({
    orchestrator,
    cooldownMs: config.manualRefresh.cooldownMs,
    perClientWindowMs: config.manualRefresh.perClientWindowMs,
    perClientMax: config.manualRefresh.perClientMax
  });

  const historicalImportService = business?.imports || new HistoricalImportService({ledger:researchStore,rootDir:dailyCandleStore.rootDir});
  const technicalContextService = business?.technical || new TechnicalContextService({store:dailyCandleStore,imports:historicalImportService});
  const scenarioService = business?.scenarios || new ScenarioService({alerts:materialAlertStore,technicalContext:technicalContextService,eventLedger,candleStore:dailyCandleStore,policy:overrides.signalPolicy||loadSignalPolicy(process.env.RESEARCH_SIGNAL_POLICY_FILE)});
  const activeCycles=new Set();
  if(business)for(const method of ["runNewsCycle","runMarketCycle"]){const runCycle=orchestrator[method].bind(orchestrator);orchestrator[method]=(...args)=>{const task=runCycle(...args);activeCycles.add(task);task.finally(()=>activeCycles.delete(task)).catch(()=>{});return task;};}
  orchestrator.storageFlush = () => pipelinePersistence?.flush();
  if(business){const refresh=awarenessService.runCycle?.bind(awarenessService);if(refresh)awarenessService.runCycle=async(...args)=>{const result=await refresh(...args);await pipelinePersistence.flush();return result;};}
  orchestrator.researchCycle = async () => {
    const publicEvents=awarenessService.getSnapshot({limit:100},{publicView:true});
    if(publicEvents.mode === "visible") await researchGuard("awarenessEvents",()=>eventLedger.ingest([...publicEvents.recent,...publicEvents.upcoming].map(e=>({...e,url:e.canonicalUrl,eventTime:e.scheduledAt})),{sourceId:"awareness"}));
    await researchGuard("scenarios",()=>scenarioService.refresh({instrumentIds:marketWatchlistService.selectedInstrumentIds}));
  };
  app.locals.socketServer = socketServer;
  app.locals.newsArchive = newsArchive;
  app.locals.researchPipeline = researchPipeline;
  app.locals.pipelineMonitor = monitor;
  app.locals.researchStore = researchStore;
  app.locals.forecastEvaluationService = business?.forecasts || new ForecastEvaluationService({store:researchStore,candleStore:dailyCandleStore});
  app.locals.eventLedger = eventLedger;
  app.locals.officialSourceService = officialSourceService;
  app.locals.secSourceAgent = secSourceAgent;
  app.locals.technicalContextService = technicalContextService;
  app.locals.scenarioService = scenarioService;
  app.locals.historicalAcquisitionService = business?.history || new HistoricalAcquisitionService({ledger:researchStore,marketDataService,candleStore:dailyCandleStore});
  app.locals.historicalImportService = historicalImportService;
  app.locals.materialAlertStore = materialAlertStore;
  app.locals.portfolioContextService = business?.portfolio || new PortfolioContextService({ stateManager, archive: newsArchive, alerts: materialAlertStore, awarenessService, watchlist: marketWatchlistService, scenarioService });
  app.locals.mcpOperatorCredentials = overrides.mcpOperatorCredentials || readOperatorCredentials(process.env.MCP_OPERATOR_CREDENTIALS_FILE);
  app.locals.mcpOperatorAudit = row => log.info("mcp_operator_authorized", row);
  app.locals.orchestrator = orchestrator;
  app.locals.manualRefreshService = manualRefreshService;
  app.locals.config = config;
  app.locals.rssAggregator = rssAggregator;
  app.locals.signalCorrelator = signalCorrelator;
  app.locals.advancedIntelligenceService = advancedIntelligenceService;
  app.locals.mapLayerService = mapLayerService;
  app.locals.mediaStreamService = mediaStreamService;
  app.locals.marketHistoryStore = marketHistoryStore;
  app.locals.dailyCandleStore = dailyCandleStore;
  app.locals.dailyCandleService = dailyCandleService;
  app.locals.intradayCandleService = intradayCandleService;
  app.locals.technicalIndicatorService = technicalIndicatorService;
  app.locals.newsPriceCouplingService = newsPriceCouplingService;
  app.locals.storageManager = storageManager;
  app.locals.agentConfig = agentConfig;
  app.locals.agentRuntime = new ManagedAgentRuntime({config:agentConfig,logger:log});
  app.locals.agentProgress = new Map();
  app.locals.agentCall = (method,args={}) => {
    if(storageManager.state === 'disabled' && method === 'publications')return Promise.resolve({items:[],hasMore:false,nextCursor:null,status:'unavailable'});
    return storageManager.request("agent.call",{method,args});
  };
  app.locals.agentModels=new AgentModelSelection({config:agentConfig,call:app.locals.agentCall,opencode:new OpenCodeClient({baseUrl:agentConfig.opencodeUrl,password:agentConfig.opencodePassword})});
  app.locals.agentMaintenance = new AgentMaintenance({call:app.locals.agentCall,business,
    instruments:()=>marketWatchlistService.selectedInstrumentIds,
    enabled:Boolean(business && app.locals.agentConfig.mode !== "off")});
  app.locals.business = business;
  app.locals.marketWatchlistService = marketWatchlistService;
  app.locals.marketDataService = marketDataService;
  app.locals.marketSearchRateLimiter = marketSearchRateLimiter;
  app.locals.aiCoordinator = aiCoordinator;
  app.locals.awarenessService = awarenessService;
  if(business){app.locals.awarenessQuery=filters=>business.call("awareness","getSnapshot",[{mode:awarenessService.mode,filters,publicView:true}]);awarenessService.parseSource=(...args)=>business.call("awareness","parseSource",args);}
  app.locals.awarenessStore = awarenessStore;
  app.locals.marketConditionsService = marketConditionsService;
  let startTask = null;
  let stopTask = null;

  businessContext = () => ({snapshot:stateManager.getAnalysisSnapshot(),newsFromStorage:true,awareness:awarenessService.getSnapshot({limit:100},{publicView:true}),selectedInstrumentIds:marketWatchlistService.selectedInstrumentIds,intradayMetrics:intradayCandleService.getMetrics()});
  storageManager.rpcHandler = (operation,input) => {
    if(operation !== "market.fetch") throw new Error("Unknown provider bridge");
    return marketDataService.fetchYahooBars(input.symbol,input.options);
  };
  return {
    app,
    server,
    orchestrator,
    manualRefreshService,
    socketServer,
    mediaStreamService,
    aiCoordinator,
    signalCorrelator,
    advancedIntelligenceService,
    awarenessService,
    marketConditionsService,
    config,
    storageManager,
    start() {
      if (startTask) return startTask;
      startTask = (async () => {
      const startupAt = performance.now();
      app.locals.initializing=true;
      await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(config.port,config.host,()=>{server.removeListener("error",reject);resolve();});});
      log.info("http_listening",{port:server.address().port,ready:false});
      await storageManager.start();
      if (storageManager.state === "ready") {
        const now = new Date().toISOString();
        const runId = `boot-${randomUUID()}`;
        await storageManager.request("pipeline.record", { runId, pipelineId: "storage", startedAt: now, completedAt: now, status: "healthy", counts: { migrations: storageManager.getStatus().migrations.length } }, { requestId: runId });
        log.info("storage_worker_started", {state:storageManager.state,sqliteVersion:storageManager.getStatus().sqliteVersion,migrations:storageManager.getStatus().migrations.length,analysisWorker:Boolean(storageManager.analysisManager)});
      }
      if (business) {
        const workerNews = {...config.news,watchlistCountries:config.watchlistCountries,awarenessMode:config.awareness.mode};
        // Providers import the versioned catalog locally; retain feed overrides,
        // but avoid transferring the complete catalog with each configuration.
        delete workerNews.sourceCatalog;
        await storageManager.request("domain.configure", { requireImport:POLICY.storage.requireImport,instruments:listVerifiedInstruments(),apiLimits:config.apiLimits,news:JSON.parse(JSON.stringify(workerNews)),researchSources,rootDir:config.market.historyDir,candlesEnabled:dailyCandleStore.enabled,intradayEnabled:config.market.intradayCandles.enabled,awarenessMode:config.awareness.mode,signalPolicy:overrides.signalPolicy || loadSignalPolicy(process.env.RESEARCH_SIGNAL_POLICY_FILE),rss:{rssFeeds:config.news.rssFeeds,news:{rssAggregateIntervalMs:config.news.rssAggregateIntervalMs,rssAggregateFeedsPerRun:config.news.rssAggregateFeedsPerRun,rssAggregateMaxItems:config.news.rssAggregateMaxItems},timeoutMs:config.news.timeoutMs,pipelineMode:config.news.rssPipelineMode},newsRetentionDays:config.news.retentionDays});
        await newsArchive.coverage();
        await pipelinePersistence.hydrate({awarenessStore,aiStore,aiBudget,marketHistoryStore,quotaTracker:apiQuotaTracker});
        aiCoordinator.syncProjection();
      }
      if(business){
        const control=await app.locals.agentCall('control');app.locals.agentPaused=control.paused;
        if(control.backgroundModel){
          if(readyModel(agentConfig.manifest.models.find(m=>`llamacpp/${m.alias}`===control.backgroundModel)))agentConfig.backgroundModel=control.backgroundModel;
          else app.locals.agentModelWarning='AGENT_SAVED_MODEL_UNVERIFIED';
        }
      }
      const hydratedWatchlist = await marketWatchlistService.hydrate();
      if(business)await storageManager.request("domain.registry",{instruments:listVerifiedInstruments()});
      config.market.tickers = hydratedWatchlist.selectedSymbols;
      config.news.marketTickers = hydratedWatchlist.selectedSymbols;
      const hydratedQueryPacks = normalizeNewsQueryPacks(config.news.queryPackGroups, { marketTickers: hydratedWatchlist.selectedSymbols });
      config.news.queryPackGroups = { editorial: hydratedQueryPacks.editorial, marketSignals: hydratedQueryPacks.marketSignals };
      config.news.queryPacks = hydratedQueryPacks.flattened;
      stateManager.setMarketTickers(hydratedWatchlist.selectedSymbols);
      await marketHistoryStore.hydrateState(stateManager);
      stateManager.setMarketTickers(hydratedWatchlist.selectedSymbols);
      await dailyCandleStore.hydrate();
      if(business) await orchestrator.runNewsCycle("startup-storage",{storageOnly:true,skipSecondary:true});
      await monitor.flush();
      await pipelinePersistence?.flush();
      if(storageManager.options.enabled){
        await storageManager.request("storage.status");
        await storageManager.analysisManager?.request("storage.status");
      }
      app.locals.initializing=false;
      runtimeMetrics.start(performance.now() - startupAt);
      const aiStatus = aiCoordinator.getAdminSnapshot();
      log.info("api_config_status", {
        newsApiKeyConfigured: isRealKey(config.news.newsApiKey),
        gnewsApiKeyConfigured: isRealKey(config.news.gnewsApiKey),
        mediastackKeyConfigured: isRealKey(config.news.mediastackApiKey),
        twelveApiKeyConfigured: isRealKey(config.market.twelveApiKey),
        marketEnabled: config.market.enabled,
        marketProvider: config.market.provider,
        marketFallbackProvider: config.market.fallbackProvider,
        marketProviderChain: config.market.providerChain,
        marketOffHoursStrategy: config.market.offHoursStrategy,
        marketDisabledReason: config.market.disabledReason,
        marketBatchChunkSize: config.market.batchChunkSize,
        marketRequestReserve: config.market.requestReserve,
        marketHistoryPersist: config.market.historyPersist !== false,
        marketHistoryDir: config.market.historyDir,
        apiLimits: config.apiLimits,
        newsProviders: config.news.providers,
        newsSourceAllowlist: config.news.sourceAllowlist,
        newsDomainAllowlist: config.news.domainAllowlist,
        newsIntervalMs: config.news.intervalMs,
        newsIntervalByBandMs: config.news.intervalByBandMs,
        marketActiveIntervalMs: config.market.activeIntervalMs,
        marketOffHoursIntervalMs: config.market.offHoursIntervalMs,
        manualRefresh: config.manualRefresh,
        aiProvider: config.ai?.provider,
        aiActiveProvider: aiProvider.name,
        aiMode: config.ai?.mode,
        aiFeatures: config.ai?.features,
        aiModels: aiStatus.models,
        aiJsonMode: aiStatus.jsonMode,
        aiEndpoint: aiStatus.endpoint,
        aiApiKeyConfigured: aiStatus.apiKeyConfigured,
        awarenessMode: config.awareness?.mode,
        ...(config.ai?.provider === "nvidia" ? {
          nvidiaStructuredOutputMode: config.ai.structuredOutputMode,
          nvidiaApiKeyConfigured: isRealKey(config.ai.apiKey)
        } : {})
      });
      if (!config.runtime.disableBackgroundRefresh) {
        void awarenessService.start().catch((error) => log.warn("awareness_start_failed", { message: error.message }));
        orchestrator.start();
        void secSourceAgent.start();
        app.locals.agentMaintenance.start();
      }
      log.info("server_started", { port: server.address().port, refreshIntervalMs: config.news.intervalMs });
      void app.locals.agentRuntime.start(`http://127.0.0.1:${server.address().port}`);
      })();
      return startTask;
    },
    stop() {
      if (stopTask) return stopTask;
      stopTask = (async () => {
      const failures=[];
      const drain=async work=>{try{await work();}catch(error){failures.push(error);}};
      try {
      runtimeMetrics.stop();
      await drain(()=>app.locals.agentRuntime.stop());
      await drain(()=>app.locals.agentMaintenance.stop());
      // Stop accepting HTTP/upgrade work before draining owners of background jobs.
      const httpStopped = new Promise((resolve,reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
      });
      const httpDrained=drain(()=>httpStopped);
      // Attach rejection handlers immediately and drain every owner even when
      // one persistence operation fails. Storage must always release its handles.
      const backgroundStopped = Promise.all([
        drain(()=>socketServer.close()), drain(()=>awarenessService.stop()),drain(()=>secSourceAgent.stop()),
        drain(()=>mediaStreamService.stop()), drain(()=>marketDataService.close?.())
      ]);
      const cyclesStopped=drain(()=>orchestrator.stop());
      await drain(()=>rssAggregator.stop?.());
      await cyclesStopped;
      await drain(()=>newsArchive.flush?.());
      await backgroundStopped;
      await drain(()=>aiCoordinator.stop());
      await httpDrained;
      await Promise.allSettled([...activeCycles]);
      await drain(()=>marketDataStore.flushPersistence());
      await drain(()=>monitor.flush());
      await drain(()=>pipelinePersistence?.flush());
      } finally { await drain(()=>storageManager.close()); }
      log.info("server_stopped",{cleanupErrors:failures.length});
      if(failures.length)throw failures[0];
      })();
      return stopTask;
    }
  };
}

export async function run(overrides = {}) {
  const runtime = createAppServer(overrides);
  let shuttingDown = false;

  const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), Math.max(30_000,runtime.storageManager.options.shutdownTimeoutMs));
    deadline.unref();
    log.info("shutdown_signal_received", { signal });
    try {
      await runtime.stop();
      process.exit(exitCode);
    } catch (error) {
      log.error("shutdown_failed", { message: error.message });
      process.exit(1);
    }
  };

  runtime.storageManager.on("failed", (error) => {
    const status=runtime.storageManager.getStatus();
      const worker=error.diagnostic?.worker === "analysis" ? status.analysis?.worker : error.diagnostic?.worker === "queries" ? status.queries?.worker : status.worker;
    log.error("storage_worker_failed", { code: error.code,command:error.diagnostic,worker:worker?.lastCompletedCommand,news:worker?.news });
    if(["analysis","queries"].includes(error.diagnostic?.worker) && runtime.app.locals.runtimeMetrics.ready){
      void runtime.storageManager.recoverReader(error.diagnostic.worker).catch(reason=>log.warn("analysis_recovery_failed",{code:reason.code || "STORAGE_ANALYSIS_RECOVERY_FAILED"}));
      return;
    }
    if (runtime.server.listening) void shutdown("storage-worker-failed", 1);
  });
  runtime.storageManager.on("analysis-recovered",event=>log.info("analysis_worker_recovered",event));

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  const fatal = (event, error) => {
    log.error("fatal_runtime_error", { event, name:error?.name || "Error", message:error?.message || "Unhandled runtime failure" });
    void shutdown(event, 1);
  };
  process.on("unhandledRejection", error => fatal("unhandledRejection", error));
  process.on("uncaughtException", error => fatal("uncaughtException", error));

  try {
    await runtime.start();
  } catch (error) {
    log.error("startup_failed", { message: error.message, stack: error.stack, code: error.code, command: error.diagnostic });
    try { await runtime.stop(); }
    catch (cleanupError) { log.error("startup_cleanup_failed",{code:cleanupError.code,message:cleanupError.message}); }
    process.exit(1);
  }
}

if (process.argv[1] === __filename) {
  run();
}
