import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { createAdminAccessMiddleware } from "./middleware/adminAccessMiddleware.js";
import routes from "./routes/index.js";
import stateManager from "./state/stateManager.js";
import RefreshOrchestratorService from "./services/refreshOrchestratorService.js";
import ManualRefreshService from "./services/manualRefreshService.js";
import apiQuotaTracker from "./services/admin/apiQuotaTrackerService.js";
import { normalizeNewsQueryPacks } from "./services/news/newsQueryPackService.js";
import { RssAggregatorService } from "./services/news/rssAggregator.js";
import { SignalCorrelatorService } from "./services/intel/signalCorrelator.js";
import { MapLayerService } from "./services/map/mapLayerService.js";
import { MarketHistoryStore } from "./services/market/marketHistoryStore.js";
import MediaStreamService from "./services/media/mediaStreamService.js";
import { compileIpAllowlist, parseTrustProxySetting } from "./utils/clientIp.js";
import { createSocketServer } from "./websocket/socketServer.js";
import { errorHandler, notFoundHandler } from "./utils/error.js";
import { createLogger, requestLogger } from "./utils/logger.js";

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
const DEFAULT_RSS_FEEDS = Object.freeze([
  { label: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { label: "ABC International", url: "https://abcnews.go.com/abcnews/internationalheadlines" },
  { label: "Fox World", url: "https://moxie.foxnews.com/google-publisher/world.xml" }
]);
const DEFAULT_RSS_DISABLED_FEEDS = Object.freeze([
  {
    label: "ZeroHedge",
    url: "https://www.zerohedge.com/",
    reason: "disabled-until-valid-xml-feed"
  }
]);

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

function toStructuredObject(value, fallback = {}) {
  if (!value) {
    return structuredClone(fallback);
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
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

function readConfig(overrides = {}) {
  const newsOverrides = overrides.news || {};
  const watchlistCountries = toList(process.env.WATCHLIST_COUNTRIES, ["US", "IL", "IR"]).map((value) =>
    value.toUpperCase()
  );
  const newsProviders = toList(process.env.NEWS_PROVIDERS, ["newsapi"]).map((provider) =>
    provider.toLowerCase()
  );
  const newsSourceAllowlist = toList(process.env.NEWS_SOURCE_ALLOWLIST, []).map((source) => source.toLowerCase());
  const newsDomainAllowlist = toList(process.env.NEWS_DOMAIN_ALLOWLIST, []).map((domain) => domain.toLowerCase());
  const rssActiveFeeds = toFeedList(process.env.NEWS_RSS_FEEDS, DEFAULT_RSS_FEEDS);
  const rssDisabledFeeds = toFeedList(
    process.env.NEWS_RSS_DISABLED_FEEDS,
    DEFAULT_RSS_DISABLED_FEEDS,
    { disabled: true }
  );
  const envMarketProvider = toTrimmedString(process.env.MARKET_PROVIDER);
  const envMarketFallbackProvider = toTrimmedString(process.env.MARKET_PROVIDER_FALLBACK);
  const marketTickers = toList(process.env.MARKET_TICKERS, ["GD", "BA", "NOC", "LMT", "RTX", "XOM", "CVX"]).map(
    (ticker) => ticker.toUpperCase()
  );
  const normalizedNewsQueryPacks = normalizeNewsQueryPacks(
    toStructuredObject(process.env.NEWS_QUERY_PACKS, DEFAULT_NEWS_QUERY_PACKS),
    {
      marketTickers,
      defaultEditorialPacks: DEFAULT_NEWS_QUERY_PACKS
    }
  );
  const trustProxy = parseTrustProxySetting(process.env.TRUST_PROXY, false);
  const adminIpAllowlist = toList(process.env.ADMIN_IP_ALLOWLIST, []);

  const config = {
    port: toInt(process.env.PORT, 8080),
    refreshIntervalMs: toInt(process.env.REFRESH_INTERVAL_MS, 30_000),
    wsHeartbeatMs: toInt(process.env.WS_HEARTBEAT_MS, 15_000),
    wsPath: "/ws",
    watchlistCountries,
    manualRefresh: {
      cooldownMs: toInt(process.env.MANUAL_REFRESH_COOLDOWN_MS, 120_000),
      perClientWindowMs: toInt(process.env.MANUAL_REFRESH_PER_CLIENT_WINDOW_MS, 900_000),
      perClientMax: toInt(process.env.MANUAL_REFRESH_PER_CLIENT_MAX, 3)
    },
    news: {
      providers: newsProviders,
      newsApiKey: process.env.NEWS_API_KEY || "",
      newsApiBaseUrl: process.env.NEWS_API_BASE_URL || "https://newsapi.org/v2",
      gnewsApiKey: process.env.GNEWS_API_KEY || "",
      gnewsBaseUrl: process.env.GNEWS_BASE_URL || "https://gnews.io/api/v4",
      mediastackApiKey: process.env.MEDIASTACK_API_KEY || "",
      mediastackBaseUrl: process.env.MEDIASTACK_BASE_URL || "http://api.mediastack.com/v1",
      gdeltBaseUrl: process.env.GDELT_BASE_URL || "https://api.gdeltproject.org/api/v2/doc/doc",
      rssFeeds: mergeFeedLists(rssActiveFeeds, rssDisabledFeeds),
      rssDisabledFeeds,
      query: process.env.NEWS_QUERY || "geopolitics OR conflict OR sanctions OR military",
      queryPacks: normalizedNewsQueryPacks.flattened,
      queryPackGroups: normalizedNewsQueryPacks,
      language: process.env.NEWS_LANGUAGE || "en",
      pageSize: toInt(process.env.NEWS_PAGE_SIZE, 50),
      timeoutMs: toInt(process.env.NEWS_TIMEOUT_MS, 9_000),
      intervalMs: toInt(process.env.NEWS_INTERVAL_MS, toInt(process.env.REFRESH_INTERVAL_MS, 30_000)),
      backoffMaxMs: toInt(process.env.NEWS_BACKOFF_MAX_MS, 300_000),
      analyzeLimit: toInt(process.env.NEWS_ANALYZE_LIMIT, 80),
      candidateWindowHours: toInt(process.env.NEWS_CANDIDATE_WINDOW_HOURS, 36),
      maxPerSource: toInt(process.env.NEWS_MAX_PER_SOURCE, 3),
      maxSimilarHeadline: toInt(process.env.NEWS_MAX_SIMILAR_HEADLINE, 2),
      rssAggregateIntervalMs: toInt(process.env.NEWS_RSS_AGGREGATE_INTERVAL_MS, 900_000),
      rssAggregateFeedsPerRun: toInt(process.env.NEWS_RSS_AGGREGATE_FEEDS_PER_RUN, 18),
      rssAggregateMaxItems: toInt(process.env.NEWS_RSS_AGGREGATE_MAX_ITEMS, 900),
      sourceAllowlist: newsSourceAllowlist,
      domainAllowlist: newsDomainAllowlist,
      intervalByBandMs: {
        GREEN: toInt(process.env.NEWS_INTERVAL_GREEN_MS, 600_000),
        YELLOW: toInt(process.env.NEWS_INTERVAL_YELLOW_MS, 1_200_000),
        RED: toInt(process.env.NEWS_INTERVAL_RED_MS, 2_700_000),
        CRITICAL: toInt(process.env.NEWS_INTERVAL_CRITICAL_MS, 7_200_000)
      },
      pageSizeByBand: {
        GREEN: toInt(process.env.NEWS_PAGE_SIZE_GREEN, 100),
        YELLOW: toInt(process.env.NEWS_PAGE_SIZE_YELLOW, 75),
        RED: toInt(process.env.NEWS_PAGE_SIZE_RED, 40),
        CRITICAL: toInt(process.env.NEWS_PAGE_SIZE_CRITICAL, 20)
      },
      countries: watchlistCountries,
      marketTickers
    },
    market: {
      enabled: Boolean(envMarketProvider),
      provider: envMarketProvider,
      fallbackProvider: envMarketProvider ? envMarketFallbackProvider : "",
      disabledReason: envMarketProvider ? null : "market-provider-empty",
      fmpApiKey: process.env.FMP_API_KEY || "",
      fmpBaseUrl: process.env.FMP_BASE_URL || "https://financialmodelingprep.com/stable",
      fmpStableBaseUrl:
        process.env.FMP_STABLE_BASE_URL ||
        process.env.FMP_BASE_URL ||
        "https://financialmodelingprep.com/stable",
      webSource: process.env.MARKET_WEB_SOURCE || "stooq",
      webBaseUrl: process.env.MARKET_WEB_BASE_URL || "https://stooq.com",
      webTimeoutMs: toInt(process.env.MARKET_WEB_TIMEOUT_MS, toInt(process.env.MARKET_TIMEOUT_MS, 10_000)),
      webUserAgent: process.env.MARKET_WEB_USER_AGENT || "ogid/1.0",
      timeoutMs: toInt(process.env.MARKET_TIMEOUT_MS, 10_000),
      tickers: marketTickers,
      refreshIntervalMs: toInt(process.env.MARKET_REFRESH_INTERVAL_MS, 60_000),
      minTickerTtlMs: toInt(process.env.MARKET_MIN_TICKER_TTL_MS, 45_000),
      batchChunkSize: toInt(process.env.MARKET_BATCH_CHUNK_SIZE, 25),
      staleTtlMs: toInt(process.env.MARKET_STALE_TTL_MS, 14_400_000),
      requestReserve: toInt(process.env.MARKET_REQUEST_RESERVE, 25),
      historyPersist: toBool(process.env.MARKET_HISTORY_PERSIST, true),
      historyDir: process.env.MARKET_HISTORY_DIR || path.resolve(__dirname, "./data/market"),
      snapshotFile: process.env.MARKET_SNAPSHOT_FILE || "snapshot.json",
      activeIntervalMs: toInt(
        process.env.MARKET_ACTIVE_INTERVAL_MS,
        toInt(process.env.MARKET_REFRESH_INTERVAL_MS, 180_000)
      ),
      offHoursIntervalMs: toInt(process.env.MARKET_OFFHOURS_INTERVAL_MS, 1_800_000),
      intervalByBandMs: {
        GREEN: {
          activeIntervalMs: 180_000,
          offHoursIntervalMs: 1_800_000
        },
        YELLOW: {
          activeIntervalMs: 300_000,
          offHoursIntervalMs: 3_600_000
        },
        RED: {
          activeIntervalMs: 900_000,
          offHoursIntervalMs: 7_200_000
        },
        CRITICAL: {
          activeIntervalMs: 7_200_000,
          offHoursIntervalMs: 7_200_000
        }
      },
      impactWindowMin: toInt(process.env.IMPACT_WINDOW_MIN, 120)
    },
    apiLimits: {
      newsapiDailyLimit: toInt(process.env.NEWSAPI_DAILY_LIMIT, 500),
      gnewsDailyLimit: toInt(process.env.GNEWS_DAILY_LIMIT, 500),
      mediastackDailyLimit: toInt(process.env.MEDIASTACK_DAILY_LIMIT, 500),
      rssDailyLimit: toInt(process.env.RSS_DAILY_LIMIT, 0),
      gdeltDailyLimit: toInt(process.env.GDELT_DAILY_LIMIT, 0),
      fmpDailyLimit: toInt(process.env.FMP_DAILY_LIMIT, 250),
      webDailyLimit: toInt(process.env.MARKET_WEB_DAILY_LIMIT, 0)
    },
    media: {
      refreshIntervalMs: toInt(process.env.MEDIA_STREAM_REFRESH_INTERVAL_MS, 300_000),
      timeoutMs: toInt(process.env.MEDIA_STREAM_TIMEOUT_MS, 8_000)
    },
    security: {
      trustProxy,
      adminIpAllowlist,
      adminIpAllowlistMatcher: compileIpAllowlist(adminIpAllowlist),
      adminMenuVisible: toBool(process.env.ADMIN_MENU_VISIBLE, false)
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
      fmpApiKey:
        overrides.market?.fmpApiKey ??
        config.market.fmpApiKey,
      fmpStableBaseUrl:
        overrides.market?.fmpStableBaseUrl ??
        overrides.market?.fmpBaseUrl ??
        config.market.fmpStableBaseUrl,
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
    apiLimits: {
      ...config.apiLimits,
      ...(overrides.apiLimits || {})
    },
    media: {
      ...config.media,
      ...(overrides.media || {})
    },
    security: {
      ...config.security,
      ...(overrides.security || {}),
      trustProxy: parseTrustProxySetting(overrides.security?.trustProxy ?? config.security.trustProxy, false),
      adminIpAllowlist:
        overrides.security?.adminIpAllowlist !== undefined
          ? toList(overrides.security.adminIpAllowlist, [])
          : config.security.adminIpAllowlist,
      adminMenuVisible:
        overrides.security?.adminMenuVisible ??
        config.security.adminMenuVisible
    },
    runtime: {
      disableBackgroundRefresh:
        overrides.runtime?.disableBackgroundRefresh ??
        overrides.disableBackgroundRefresh ??
        toBool(process.env.DISABLE_BACKGROUND_REFRESH, false)
    }
  };

  const resolvedMarketTickers = overrides.market?.tickers || config.market.tickers;
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
  mergedConfig.security = {
    ...mergedConfig.security,
    adminIpAllowlistMatcher: compileIpAllowlist(mergedConfig.security.adminIpAllowlist || [])
  };

  const resolvedMarketProvider = toTrimmedString(mergedConfig.market?.provider);
  const resolvedMarketFallbackProvider = toTrimmedString(mergedConfig.market?.fallbackProvider);
  const marketEnabledOverride = Object.prototype.hasOwnProperty.call(overrides.market || {}, "enabled")
    ? overrides.market.enabled
    : undefined;
  const marketEnabled = marketEnabledOverride !== undefined ? marketEnabledOverride !== false : Boolean(resolvedMarketProvider);

  mergedConfig.market = {
    ...mergedConfig.market,
    enabled: marketEnabled,
    provider: marketEnabled ? resolvedMarketProvider || "web" : "",
    fallbackProvider:
      marketEnabled
        ? resolvedMarketFallbackProvider || (resolvedMarketProvider === "web" || !resolvedMarketProvider ? "fmp" : "")
        : "",
    disabledReason: marketEnabled ? null : "market-provider-empty"
  };

  return mergedConfig;
}

export function createAppServer(overrides = {}) {
  const config = readConfig(overrides);
  const frontendPath = path.resolve(__dirname, "../frontend");
  const app = express();
  const adminAccessMiddleware = createAdminAccessMiddleware();

  app.disable("x-powered-by");
  app.set("trust proxy", config.security?.trustProxy ?? false);
  app.use(
    helmet({
      contentSecurityPolicy: false
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(requestLogger);

  app.use(express.static(frontendPath, { index: "index.html" }));
  app.use("/api/admin", adminAccessMiddleware);
  app.use("/api", routes);
  app.get(["/admin", "/admin/"], adminAccessMiddleware, (_req, res) => {
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

  stateManager.reset({
    refreshIntervalMs: config.news.intervalMs,
    watchlistCountries: config.watchlistCountries,
    marketTickers: config.market.tickers,
    impactWindowMin: config.market.impactWindowMin,
    marketEnabled: config.market.enabled,
    marketDisabledReason: config.market.disabledReason
  });
  apiQuotaTracker.reset(config.apiLimits);
  const rssAggregator = new RssAggregatorService({
    news: config.news,
    rssFeeds: config.news.rssFeeds,
    refreshIntervalMs: config.news.rssAggregateIntervalMs,
    maxFeedsPerRun: config.news.rssAggregateFeedsPerRun,
    maxCorpusItems: config.news.rssAggregateMaxItems,
    timeoutMs: config.news.timeoutMs
  });
  const signalCorrelator = new SignalCorrelatorService();
  const mapLayerService = new MapLayerService({
    stateManager,
    rssAggregator
  });
  const marketHistoryStore = new MarketHistoryStore({
    enabled: config.market?.historyPersist !== false,
    rootDir: config.market?.historyDir,
    snapshotFile: config.market?.snapshotFile,
    tickers: config.market?.tickers || []
  });
  const mediaStreamService = new MediaStreamService({
    refreshIntervalMs: config.media?.refreshIntervalMs,
    timeoutMs: config.media?.timeoutMs
  });

  const server = http.createServer(app);
  const socketServer = createSocketServer({
    server,
    path: config.wsPath,
    heartbeatMs: config.wsHeartbeatMs,
    stateManager
  });
  const orchestrator = new RefreshOrchestratorService({
    stateManager,
    socketServer,
    config,
    rssAggregator,
    signalCorrelator,
    mapLayerService,
    marketHistoryStore
  });
  const manualRefreshService = new ManualRefreshService({
    orchestrator,
    cooldownMs: config.manualRefresh.cooldownMs,
    perClientWindowMs: config.manualRefresh.perClientWindowMs,
    perClientMax: config.manualRefresh.perClientMax
  });

  app.locals.socketServer = socketServer;
  app.locals.orchestrator = orchestrator;
  app.locals.manualRefreshService = manualRefreshService;
  app.locals.config = config;
  app.locals.rssAggregator = rssAggregator;
  app.locals.signalCorrelator = signalCorrelator;
  app.locals.mapLayerService = mapLayerService;
  app.locals.mediaStreamService = mediaStreamService;
  app.locals.marketHistoryStore = marketHistoryStore;

  return {
    app,
    server,
    orchestrator,
    manualRefreshService,
    socketServer,
    mediaStreamService,
    config,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      log.info("api_config_status", {
        newsApiKeyConfigured: isRealKey(config.news.newsApiKey),
        gnewsApiKeyConfigured: isRealKey(config.news.gnewsApiKey),
        mediastackKeyConfigured: isRealKey(config.news.mediastackApiKey),
        fmpApiKeyConfigured: isRealKey(config.market.fmpApiKey),
        trustProxy: config.security?.trustProxy ?? false,
        adminIpAllowlistEnabled: Boolean(config.security?.adminIpAllowlistMatcher?.enabled),
        adminIpAllowlistInvalidEntries: config.security?.adminIpAllowlistMatcher?.invalidEntries || [],
        adminMenuVisible: config.security?.adminMenuVisible === true,
        marketEnabled: config.market.enabled,
        marketProvider: config.market.provider,
        marketFallbackProvider: config.market.fallbackProvider,
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
        mediaRefreshIntervalMs: config.media?.refreshIntervalMs,
        mediaTimeoutMs: config.media?.timeoutMs
      });
      await marketHistoryStore.hydrateState(stateManager);
      if (!config.runtime.disableBackgroundRefresh) {
        orchestrator.start();
        mediaStreamService.start();
      }
      log.info("server_started", { port: server.address().port, refreshIntervalMs: config.news.intervalMs });
    },
    async stop() {
      orchestrator.stop();
      mediaStreamService.stop();
      socketServer.close();
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      log.info("server_stopped");
    }
  };
}

async function run() {
  const runtime = createAppServer();

  const shutdown = async (signal) => {
    log.info("shutdown_signal_received", { signal });
    try {
      await runtime.stop();
      process.exit(0);
    } catch (error) {
      log.error("shutdown_failed", { message: error.message });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await runtime.start();
  } catch (error) {
    log.error("startup_failed", { message: error.message, stack: error.stack });
    process.exit(1);
  }
}

if (process.argv[1] === __filename) {
  run();
}
