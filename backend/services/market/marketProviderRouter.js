import apiQuotaTracker from "../admin/apiQuotaTrackerService.js";
import { resolveBandByProviderSnapshots } from "../refreshPolicyService.js";
import { createLogger } from "../../utils/logger.js";
import { fetchAlphaVantageProviderQuotes } from "./providers/alphaVantageProvider.js";
import { fetchFmpQuotes } from "./providers/fmpProvider.js";
import { buildFallbackQuote } from "./providers/quoteFallback.js";
import { buildCoverageByMode } from "./quoteMetadata.js";

const log = createLogger("backend/services/market/marketProviderRouter");

const PROVIDER_MAP = {
  fmp: fetchFmpQuotes,
  alphavantage: fetchAlphaVantageProviderQuotes
};

function buildDisabledCoverageByMode() {
  return {
    live: 0,
    historicalEod: 0,
    routerStale: 0,
    syntheticFallback: 0
  };
}

function normalizeProvider(value, fallback) {
  const normalized = String(value || "").toLowerCase();
  return normalized in PROVIDER_MAP ? normalized : fallback;
}

function resolveSourceMode(liveCount, totalCount) {
  if (liveCount <= 0) {
    return "fallback";
  }
  if (liveCount >= totalCount) {
    return "live";
  }
  return "mixed";
}

function buildProviderConfig(provider, config) {
  if (provider === "fmp") {
    return {
      apiKey: config.fmpApiKey || "",
      baseUrl:
        config.fmpStableBaseUrl ||
        config.fmpBaseUrl ||
        "https://financialmodelingprep.com/stable",
      batchChunkSize: config.batchChunkSize,
      enableHistoricalBackfill: config.enableHistoricalBackfill === true,
      historicalBackfillTickers: config.historicalBackfillTickers || []
    };
  }

  return {
    apiKey: config.apiKey || config.alphaVantageApiKey || "",
    baseUrl: config.baseUrl || config.alphaVantageBaseUrl || "https://www.alphavantage.co/query",
    maxRequestsPerRun: config.alphaVantageMaxRequestsPerRun
  };
}

function resolveProviderAvailability(provider, { reserve = 0, allowExhaustedProviders = false } = {}) {
  const snapshot = apiQuotaTracker.getProviderSnapshot(provider);
  const remaining = snapshot?.effectiveRemaining;
  const reserveFloor = Math.max(0, Number.parseInt(String(reserve ?? ""), 10) || 0);

  if (allowExhaustedProviders) {
    return {
      available: true,
      snapshot,
      reason: null
    };
  }

  if (snapshot?.exhausted) {
    return {
      available: false,
      snapshot,
      reason: "exhausted"
    };
  }

  if (Number.isFinite(remaining) && remaining <= reserveFloor) {
    return {
      available: false,
      snapshot,
      reason: "reserve-floor"
    };
  }

  return {
    available: true,
    snapshot,
    reason: null
  };
}

function buildProviderOrder(primaryProvider, fallbackProvider, options) {
  const attemptedOrder = [...new Set([primaryProvider, fallbackProvider].filter(Boolean))];
  const providersAvailable = [];
  const providersSkipped = [];
  const providerSnapshots = [];

  for (const provider of attemptedOrder) {
    const availability = resolveProviderAvailability(provider, options);
    if (availability.snapshot) {
      providerSnapshots.push(availability.snapshot);
    }

    if (availability.available) {
      providersAvailable.push(provider);
      continue;
    }

    providersSkipped.push({
      provider,
      reason: availability.reason,
      remaining: availability.snapshot?.effectiveRemaining ?? null
    });
  }

  return {
    providersAvailable,
    providersSkipped,
    providerSnapshots
  };
}

function resolveHistoricalBackfillTickers(config = {}, tickers = [], provider, providerSnapshot) {
  if (provider !== "fmp") {
    return [];
  }

  const previousTimeseries = config.previousTimeseries || {};
  const seedTickers = tickers.filter((ticker) => (previousTimeseries[ticker] || []).length === 0);
  if (!seedTickers.length) {
    return [];
  }

  const reserve = Math.max(0, Number.parseInt(String(config.requestReserve ?? 0), 10) || 0);
  const remaining = providerSnapshot?.effectiveRemaining;
  if (Number.isFinite(remaining) && remaining <= reserve + seedTickers.length) {
    return [];
  }

  return seedTickers;
}

function buildStaleQuote(previousQuote, { timestamp, staleTtlMs }) {
  if (!previousQuote || !Number.isFinite(previousQuote.price)) {
    return null;
  }

  const asOfValue = previousQuote.asOf || previousQuote.updatedAt;
  const asOfTime = new Date(asOfValue || 0).getTime();
  const ttlMs = Math.max(0, Number.parseInt(String(staleTtlMs ?? 0), 10) || 0);
  if (!Number.isFinite(asOfTime)) {
    return null;
  }

  if (ttlMs > 0 && Date.now() - asOfTime > ttlMs) {
    return null;
  }

  return {
    ...previousQuote,
    synthetic: false,
    dataMode: "router-stale",
    staleAt: timestamp
  };
}

function buildFallbackSet(unresolved, timestamp) {
  return Object.fromEntries(unresolved.map((ticker) => [ticker, buildFallbackQuote(ticker, timestamp)]));
}

function buildDisabledMarketResult(config = {}, timestamp = new Date().toISOString()) {
  const tickers = (config.tickers || []).map((ticker) => String(ticker).toUpperCase());
  const batchSize = Number.parseInt(String(config.batchChunkSize ?? 25), 10) || 25;

  return {
    provider: "disabled",
    sourceMode: "disabled",
    sourceMeta: {
      enabled: false,
      provider: "disabled",
      providersUsed: [],
      providersSkipped: [],
      liveCount: 0,
      totalTickers: tickers.length,
      fallbackCount: 0,
      unresolvedTickers: tickers,
      usedStaleQuotes: [],
      coverageByMode: buildDisabledCoverageByMode(),
      quotaBand: null,
      requestMode: "disabled",
      batchSize,
      lastUpstreamError: null,
      errors: [],
      providerErrors: [],
      disabledReason: config.disabledReason || "market-provider-empty"
    },
    quotes: Object.fromEntries(
      tickers.map((ticker) => [
        ticker,
        {
          price: null,
          changePct: 0,
          asOf: null,
          source: "disabled",
          synthetic: true,
          dataMode: "synthetic-fallback"
        }
      ])
    ),
    historicalSeries: {},
    updatedAt: timestamp
  };
}

export async function fetchMarketQuotes(config = {}) {
  if (config.enabled === false) {
    return buildDisabledMarketResult(config);
  }

  const tickers = (config.tickers || []).map((ticker) => String(ticker).toUpperCase());
  const timestamp = new Date().toISOString();
  const primaryProvider = normalizeProvider(config.provider || "fmp", "fmp");
  const fallbackProvider = normalizeProvider(
    config.fallbackProvider || (primaryProvider === "fmp" ? "alphavantage" : "fmp"),
    primaryProvider === "fmp" ? "alphavantage" : "fmp"
  );
  const requestReserve = Math.max(0, Number.parseInt(String(config.requestReserve ?? 0), 10) || 0);
  const staleTtlMs = Math.max(0, Number.parseInt(String(config.staleTtlMs ?? 0), 10) || 0);
  const previousQuotes = config.previousQuotes || {};

  const providerOrder = buildProviderOrder(primaryProvider, fallbackProvider, {
    reserve: requestReserve,
    allowExhaustedProviders: config.allowExhaustedProviders === true
  });
  const quotaBand = resolveBandByProviderSnapshots(providerOrder.providerSnapshots);
  const mergedQuotes = {};
  const providersUsed = [];
  const errors = [];
  const historicalSeries = {};
  let lastUpstreamError = null;
  const requestModes = [];
  let unresolved = [...tickers];

  for (const provider of providerOrder.providersAvailable) {
    if (!unresolved.length) {
      break;
    }

    const fetcher = PROVIDER_MAP[provider];
    const providerSnapshot = providerOrder.providerSnapshots.find((snapshot) => snapshot.provider === provider) || null;
    const historicalBackfillTickers = resolveHistoricalBackfillTickers(config, unresolved, provider, providerSnapshot);
    const providerConfig = buildProviderConfig(provider, {
      ...config,
      enableHistoricalBackfill: historicalBackfillTickers.length > 0,
      historicalBackfillTickers
    });

    const providerResult = await fetcher({
      ...providerConfig,
      tickers: unresolved,
      timeoutMs: config.timeoutMs,
      timestamp
    });

    providersUsed.push(provider);
    Object.assign(mergedQuotes, providerResult.quotes || {});
    Object.assign(historicalSeries, providerResult.historicalSeries || {});
    errors.push(
      ...(providerResult.sourceMeta?.errors || []).map((error) => ({
        provider,
        ...error,
        code: error.code || error.reason || "unknown-error",
        reason: error.reason || error.code || "unknown-error"
      }))
    );
    if (providerResult.sourceMeta?.requestMode) {
      requestModes.push(providerResult.sourceMeta.requestMode);
    }

    const providerError =
      providerResult.sourceMeta?.errors?.at?.(-1)?.code ||
      providerResult.sourceMeta?.errors?.at?.(-1)?.reason ||
      providerResult.sourceMeta?.reason ||
      null;
    if (providerError) {
      lastUpstreamError = providerError;
    }

    unresolved = unresolved.filter((ticker) => !providerResult.quotes?.[ticker]);
  }

  const staleQuotes = {};
  if (unresolved.length && staleTtlMs > 0) {
    for (const ticker of unresolved) {
      const staleQuote = buildStaleQuote(previousQuotes[ticker], {
        timestamp,
        staleTtlMs
      });
      if (!staleQuote) {
        continue;
      }
      staleQuotes[ticker] = staleQuote;
      mergedQuotes[ticker] = staleQuote;
    }
    unresolved = unresolved.filter((ticker) => !staleQuotes[ticker]);
  }

  if (unresolved.length) {
    Object.assign(mergedQuotes, buildFallbackSet(unresolved, timestamp));
    for (const provider of providersUsed) {
      apiQuotaTracker.markFallback(provider, timestamp);
    }
  }

  const liveCount = Object.values(mergedQuotes).filter((quote) => quote?.dataMode === "live").length;
  const totalTickers = tickers.length;
  const requestMode = [...new Set(requestModes)].join("+") || "unavailable";
  const usedStaleQuotes = Object.keys(staleQuotes);
  const coverageByMode = buildCoverageByMode(mergedQuotes);
  const providerErrors = errors.map((error) => ({
    ...error,
    code: error.code || error.reason || "unknown-error",
    reason: error.reason || error.code || "unknown-error"
  }));

  log.info("market_router_completed", {
    primaryProvider,
    fallbackProvider,
    providersUsed,
    providersSkipped: providerOrder.providersSkipped,
    liveCount,
    staleCount: coverageByMode.routerStale,
    fallbackCount: unresolved.length,
    totalTickers,
    quotaBand,
    sourceMode: resolveSourceMode(liveCount, totalTickers)
  });

  return {
    provider: providersUsed.join("+") || "market-router",
    sourceMode: resolveSourceMode(liveCount, totalTickers),
    sourceMeta: {
      provider: providersUsed.join("+") || "market-router",
      providersUsed,
      providersSkipped: providerOrder.providersSkipped,
      liveCount,
      totalTickers,
      fallbackCount: unresolved.length,
      unresolvedTickers: unresolved,
      usedStaleQuotes,
      coverageByMode,
      quotaBand,
      requestMode,
      batchSize: Number.parseInt(String(config.batchChunkSize ?? 25), 10) || 25,
      lastUpstreamError,
      errors: providerErrors,
      providerErrors
    },
    quotes: mergedQuotes,
    historicalSeries,
    updatedAt: timestamp
  };
}
