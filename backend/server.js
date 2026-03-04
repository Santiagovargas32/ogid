import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import routes from "./routes/index.js";
import stateManager from "./state/stateManager.js";
import RefreshOrchestratorService from "./services/refreshOrchestratorService.js";
import apiQuotaTracker from "./services/admin/apiQuotaTrackerService.js";
import { createSocketServer } from "./websocket/socketServer.js";
import { errorHandler, notFoundHandler } from "./utils/error.js";
import { createLogger, requestLogger } from "./utils/logger.js";

const log = createLogger("backend/server");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  const watchlistCountries = toList(process.env.WATCHLIST_COUNTRIES, ["US", "IL", "IR"]).map((value) =>
    value.toUpperCase()
  );
  const newsProviders = toList(process.env.NEWS_PROVIDERS, ["newsapi"]).map((provider) =>
    provider.toLowerCase()
  );
  const marketTickers = toList(process.env.MARKET_TICKERS, ["GD", "BA", "NOC", "LMT", "RTX", "XOM", "CVX"]).map(
    (ticker) => ticker.toUpperCase()
  );

  const config = {
    port: toInt(process.env.PORT, 8080),
    refreshIntervalMs: toInt(process.env.REFRESH_INTERVAL_MS, 30_000),
    wsHeartbeatMs: toInt(process.env.WS_HEARTBEAT_MS, 15_000),
    wsPath: "/ws",
    watchlistCountries,
    news: {
      providers: newsProviders,
      newsApiKey: process.env.NEWS_API_KEY || "",
      newsApiBaseUrl: process.env.NEWS_API_BASE_URL || "https://newsapi.org/v2",
      gnewsApiKey: process.env.GNEWS_API_KEY || "",
      gnewsBaseUrl: process.env.GNEWS_BASE_URL || "https://gnews.io/api/v4",
      mediastackApiKey: process.env.MEDIASTACK_API_KEY || "",
      mediastackBaseUrl: process.env.MEDIASTACK_BASE_URL || "http://api.mediastack.com/v1",
      query: process.env.NEWS_QUERY || "geopolitics OR conflict OR sanctions OR military",
      language: process.env.NEWS_LANGUAGE || "en",
      pageSize: toInt(process.env.NEWS_PAGE_SIZE, 50),
      timeoutMs: toInt(process.env.NEWS_TIMEOUT_MS, 9_000),
      countries: watchlistCountries
    },
    market: {
      provider: process.env.MARKET_PROVIDER || "alphavantage",
      apiKey: process.env.ALPHAVANTAGE_API_KEY || "",
      baseUrl: process.env.ALPHAVANTAGE_BASE_URL || "https://www.alphavantage.co/query",
      timeoutMs: toInt(process.env.MARKET_TIMEOUT_MS, 10_000),
      tickers: marketTickers,
      refreshIntervalMs: toInt(process.env.MARKET_REFRESH_INTERVAL_MS, 60_000),
      impactWindowMin: toInt(process.env.IMPACT_WINDOW_MIN, 120)
    },
    apiLimits: {
      newsapiDailyLimit: toInt(process.env.NEWSAPI_DAILY_LIMIT, 500),
      gnewsDailyLimit: toInt(process.env.GNEWS_DAILY_LIMIT, 500),
      mediastackDailyLimit: toInt(process.env.MEDIASTACK_DAILY_LIMIT, 500),
      alphavantageDailyLimit: toInt(process.env.ALPHAVANTAGE_DAILY_LIMIT, 500)
    }
  };

  return {
    ...config,
    ...overrides,
    watchlistCountries: overrides.watchlistCountries || config.watchlistCountries,
    news: {
      ...config.news,
      ...(overrides.news || {}),
      countries:
        overrides.news?.countries ||
        overrides.watchlistCountries ||
        config.news.countries
    },
    market: {
      ...config.market,
      ...(overrides.market || {})
    },
    apiLimits: {
      ...config.apiLimits,
      ...(overrides.apiLimits || {})
    }
  };
}

export function createAppServer(overrides = {}) {
  const config = readConfig(overrides);
  const frontendPath = path.resolve(__dirname, "../frontend");
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: false
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(requestLogger);

  app.use(express.static(frontendPath, { index: "index.html" }));
  app.use("/api", routes);

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
    refreshIntervalMs: config.refreshIntervalMs,
    watchlistCountries: config.watchlistCountries,
    marketTickers: config.market.tickers,
    impactWindowMin: config.market.impactWindowMin
  });
  apiQuotaTracker.reset(config.apiLimits);

  const server = http.createServer(app);
  const socketServer = createSocketServer({
    server,
    path: config.wsPath,
    heartbeatMs: config.wsHeartbeatMs,
    stateManager
  });
  const orchestrator = new RefreshOrchestratorService({ stateManager, socketServer, config });

  app.locals.socketServer = socketServer;
  app.locals.config = config;

  return {
    app,
    server,
    orchestrator,
    socketServer,
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
        alphaVantageKeyConfigured: isRealKey(config.market.apiKey),
        apiLimits: config.apiLimits,
        newsProviders: config.news.providers,
        refreshIntervalMs: config.refreshIntervalMs,
        marketRefreshIntervalMs: config.market.refreshIntervalMs
      });
      orchestrator.start();
      log.info("server_started", { port: server.address().port, refreshIntervalMs: config.refreshIntervalMs });
    },
    async stop() {
      orchestrator.stop();
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
