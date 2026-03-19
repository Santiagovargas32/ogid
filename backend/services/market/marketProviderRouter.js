import apiQuotaTracker from "../admin/apiQuotaTrackerService.js";
import { resolveBandByProviderSnapshots } from "../refreshPolicyService.js";
import { createLogger } from "../../utils/logger.js";
import { fetchFmpQuotes } from "./providers/fmpProvider.js";
import { buildFallbackQuote } from "./providers/quoteFallback.js";
import { fetchWebQuotes } from "./providers/webQuoteProvider.js";
import { isMarketOpenEt } from "./marketSessionService.js";
import { buildCoverageByMode } from "./quoteMetadata.js";

const log = createLogger("backend/services/market/marketProviderRouter");

const PROVIDER_MAP = {
  web: fetchWebQuotes,
  fmp: fetchFmpQuotes
};

function buildDisabledCoverageByMode() {
  return {
    live: 0,
    webDelayed: 0,
    historicalEod: 0,
    routerStale: 0,
    syntheticFallback: 0
  };
}

function buildMarketSession(timestamp = new Date().toISOString()) {
  const now = new Date(timestamp);
  const open = isMarketOpenEt(now);
  return {
    open,
    state: open ? "open" : "closed",
    checkedAt: timestamp,
    timezone: "America/New_York"
  };
}

function computeProviderScore(provider, providerResult = {}, marketSession = {}) {
  const diagnostic = providerResult.sourceMeta?.providerDiagnostics?.[provider] || {};
  const returnedCount = Number((diagnostic.returnedTickers || Object.keys(providerResult.quotes || {})).length || 0);
  const totalCount = Number(providerResult.sourceMeta?.totalTickers || returnedCount || 0);
  const durationMs = Number.isFinite(Number(diagnostic.durationMs))
    ? Number(diagnostic.durationMs)
    : Number.isFinite(Number(providerResult.sourceMeta?.providerLatencyMs))
      ? Number(providerResult.sourceMeta.providerLatencyMs)
      : 0;
  const coverage = totalCount > 0 ? returnedCount / totalCount : 0;
  const liveCount = Number(providerResult.sourceMeta?.liveCount || 0);
  const delayedCount = Number(providerResult.sourceMeta?.delayedCount || 0);
  const freshnessBonus = liveCount > 0 ? 20 : delayedCount > 0 ? 10 : 0;
  const latencyPenalty = Math.min(30, durationMs / 180);
  const errorPenalty = Number((providerResult.sourceMeta?.errors || []).length || 0) * 5;
  const sessionBonus = marketSession?.open ? 5 : 0;

  return Math.max(0, Math.round(coverage * 60 + freshnessBonus + sessionBonus - latencyPenalty - errorPenalty));
}

function decorateProviderDiagnostic(provider, providerResult = {}, marketSession = {}) {
  const diagnostic = providerResult.sourceMeta?.providerDiagnostics?.[provider] || {};
  const providerScore = computeProviderScore(provider, providerResult, marketSession);
  return {
    ...diagnostic,
    providerScore,
    providerLatencyMs: Number.isFinite(Number(diagnostic.durationMs))
      ? Number(diagnostic.durationMs)
      : Number.isFinite(Number(providerResult.sourceMeta?.providerLatencyMs))
        ? Number(providerResult.sourceMeta.providerLatencyMs)
        : null,
    marketSession,
    sourceMode: providerResult.sourceMode || diagnostic.sourceMode || null,
    liveCount: providerResult.sourceMeta?.liveCount ?? null,
    delayedCount: providerResult.sourceMeta?.delayedCount ?? null,
    effectiveSource: providerResult.sourceMeta?.effectiveSource || diagnostic.effectiveSource || null
  };
}

function normalizeProvider(value, fallback) {
  const normalized = String(value || "").toLowerCase();
  return normalized in PROVIDER_MAP ? normalized : fallback;
}

function resolveSourceMode(providerCount, totalCount) {
  if (providerCount <= 0) {
    return "fallback";
  }
  if (providerCount >= totalCount) {
    return "live";
  }
  return "mixed";
}

function buildProviderConfig(provider, config, primaryProvider, fallbackProvider) {
  if (provider === "web") {
    return {
      source: config.webSource || "twelve",
      baseUrl: config.webBaseUrl || "https://api.twelvedata.com",
      yahooBaseUrl: config.webYahooBaseUrl || "https://query1.finance.yahoo.com",
      userAgent: config.webUserAgent || "ogid/1.0",
      twelveApiKey: config.twelveApiKey || "",
      twelveBaseUrl: config.twelveBaseUrl || "https://api.twelvedata.com",
      twelveEnablePrepost: config.twelveEnablePrepost === true,
      requestReserve: config.requestReserve,
      allowExhaustedSources: config.allowExhaustedProviders === true,
      session: config.session || null,
      configuredProvider: primaryProvider,
      configuredFallbackProvider: fallbackProvider
    };
  }

  return {
    apiKey: config.fmpApiKey || "",
    baseUrl:
      config.fmpStableBaseUrl ||
      config.fmpBaseUrl ||
      "https://financialmodelingprep.com/stable",
    batchChunkSize: config.batchChunkSize,
    enableHistoricalBackfill: config.enableHistoricalBackfill === true,
    historicalBackfillTickers: config.historicalBackfillTickers || [],
    configuredProvider: primaryProvider,
    configuredFallbackProvider: fallbackProvider
  };
}

function resolveDefaultFallbackProvider(primaryProvider = "fmp") {
  if (primaryProvider === "web") {
    return "fmp";
  }
  return "";
}

function resolveQuotaProviderName(provider, config = {}) {
  if (String(provider || "").toLowerCase() !== "web") {
    return String(provider || "").toLowerCase();
  }

  return String(config.webSource || "twelve").toLowerCase() === "yahoo" ? "yahoo" : "twelve";
}

function resolveProviderAvailability(provider, config = {}, { reserve = 0, allowExhaustedProviders = false } = {}) {
  const quotaProvider = resolveQuotaProviderName(provider, config);
  const snapshot = apiQuotaTracker.getProviderSnapshot(quotaProvider);
  const remaining = snapshot?.effectiveRemaining;
  const reserveFloor = Math.max(0, Number.parseInt(String(reserve ?? ""), 10) || 0);

  if (allowExhaustedProviders) {
    return {
      available: true,
      snapshot,
      quotaProvider,
      reason: null
    };
  }

  if (snapshot?.exhausted) {
    return {
      available: false,
      snapshot,
      quotaProvider,
      reason: "exhausted"
    };
  }

  if (Number.isFinite(remaining) && remaining <= reserveFloor) {
    return {
      available: false,
      snapshot,
      quotaProvider,
      reason: "reserve-floor"
    };
  }

  return {
    available: true,
    snapshot,
    quotaProvider,
    reason: null
  };
}

function buildProviderOrder(primaryProvider, fallbackProvider, config, options) {
  const attemptedOrder = [...new Set([primaryProvider, fallbackProvider].filter(Boolean))];
  const providersAvailable = [];
  const providersSkipped = [];
  const providerSnapshots = [];

  for (const provider of attemptedOrder) {
    const availability = resolveProviderAvailability(provider, config, options);
    if (availability.snapshot) {
      providerSnapshots.push({
        ...availability.snapshot,
        routerProvider: provider
      });
    }

    if (availability.available) {
      providersAvailable.push(provider);
      continue;
    }

    providersSkipped.push({
      provider,
      quotaProvider: availability.quotaProvider,
      reason: availability.reason,
      remaining: availability.snapshot?.effectiveRemaining ?? null
    });
  }

  return {
    attemptedOrder,
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
  const session = buildMarketSession(timestamp);

  return {
    provider: "disabled",
    sourceMode: "disabled",
    revision: null,
    session,
    sourceMeta: {
      enabled: false,
      provider: "disabled",
      configuredProvider: null,
      configuredFallbackProvider: null,
      effectiveProvider: null,
      effectiveSource: null,
      providerScore: 0,
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
      sourceAttempts: [],
      sourceSnapshots: {},
      providerDiagnostics: {
        web: null,
        fmp: null
      },
      routerDecision: {
        attemptedOrder: [],
        providersSkipped: [],
        usedStaleQuotes: [],
        syntheticFallbackTickers: [],
        fallbackReason: "market-provider-empty"
      },
      disabledReason: config.disabledReason || "market-provider-empty",
      marketSession: session,
      providerScores: {}
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
          dataMode: "synthetic-fallback",
          providerScore: 0,
          providerLatencyMs: null
        }
      ])
    ),
    historicalSeries: {},
    updatedAt: timestamp
  };
}

function mergeProviderDiagnostics(accumulator = {}, providerResult = {}) {
  return {
    ...accumulator,
    ...(providerResult.sourceMeta?.providerDiagnostics || {})
  };
}

function resolveRouterFallbackReason({ providersSkipped = [], usedStaleQuotes = [], syntheticFallbackTickers = [], errors = [] }) {
  if (syntheticFallbackTickers.length) {
    return "synthetic-fallback";
  }
  if (usedStaleQuotes.length) {
    return "router-stale";
  }
  if (providersSkipped.length) {
    return providersSkipped.map((item) => `${item.provider}:${item.reason}`).join(", ");
  }
  if ((errors || []).length) {
    return errors.map((error) => `${error.provider}:${error.code || error.reason || "error"}`).join(", ");
  }
  return null;
}

export async function fetchMarketQuotes(config = {}) {
  if (config.enabled === false) {
    return buildDisabledMarketResult(config);
  }

  const tickers = [...new Set((config.tickers || []).map((ticker) => String(ticker).toUpperCase()).filter(Boolean))];
  const timestamp = new Date().toISOString();
  const session = buildMarketSession(timestamp);
  const primaryProvider = normalizeProvider(config.provider || "fmp", config.provider === "web" ? "web" : "fmp");
  const fallbackProvider = normalizeProvider(
    config.fallbackProvider || resolveDefaultFallbackProvider(primaryProvider),
    resolveDefaultFallbackProvider(primaryProvider)
  );
  const requestReserve = Math.max(0, Number.parseInt(String(config.requestReserve ?? 0), 10) || 0);
  const staleTtlMs = Math.max(0, Number.parseInt(String(config.staleTtlMs ?? 0), 10) || 0);
  const previousQuotes = config.previousQuotes || {};

  const providerOrder = buildProviderOrder(primaryProvider, fallbackProvider, config, {
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
  let providerDiagnostics = {};
  const providerScores = {};
  let unresolved = [...tickers];

  for (const provider of providerOrder.providersAvailable) {
    if (!unresolved.length) {
      break;
    }

    const fetcher = PROVIDER_MAP[provider];
    const providerSnapshot = providerOrder.providerSnapshots.find((snapshot) => snapshot.routerProvider === provider) || null;
    const historicalBackfillTickers = resolveHistoricalBackfillTickers(config, unresolved, provider, providerSnapshot);
    const providerConfig = buildProviderConfig(
      provider,
      {
        ...config,
        session,
        enableHistoricalBackfill: historicalBackfillTickers.length > 0,
        historicalBackfillTickers
      },
      primaryProvider,
      fallbackProvider
    );

    const providerResult = await fetcher({
      ...providerConfig,
      tickers: unresolved,
      timeoutMs: config.timeoutMs,
      timestamp
    });

    providersUsed.push(provider);
    Object.assign(mergedQuotes, providerResult.quotes || {});
    Object.assign(historicalSeries, providerResult.historicalSeries || {});
    const decoratedDiagnostic = decorateProviderDiagnostic(provider, providerResult, session);
    providerDiagnostics = {
      ...providerDiagnostics,
      [provider]: decoratedDiagnostic
    };
    providerScores[provider] = decoratedDiagnostic.providerScore;
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

  const syntheticFallbackTickers = [...unresolved];
  if (syntheticFallbackTickers.length) {
    Object.assign(mergedQuotes, buildFallbackSet(syntheticFallbackTickers, timestamp));
    for (const provider of providersUsed) {
      apiQuotaTracker.markFallback(resolveQuotaProviderName(provider, config), timestamp);
    }
  }

  const liveCount = Object.values(mergedQuotes).filter((quote) => quote?.dataMode === "live").length;
  const totalTickers = tickers.length;
  const requestMode = [...new Set(requestModes)].join("+") || "unavailable";
  const usedStaleQuotes = Object.keys(staleQuotes);
  const coverageByMode = buildCoverageByMode(mergedQuotes);
  const providerCount = coverageByMode.live + coverageByMode.webDelayed + coverageByMode.historicalEod;
  const fallbackCount = coverageByMode.routerStale + coverageByMode.syntheticFallback;
  const providerErrors = errors.map((error) => ({
    ...error,
    code: error.code || error.reason || "unknown-error",
    reason: error.reason || error.code || "unknown-error"
  }));
  const effectiveProvider =
    [...providersUsed]
      .filter((provider) => Number((providerDiagnostics[provider]?.returnedTickers || []).length || 0) > 0)
      .sort((left, right) => {
        const leftScore = providerScores[left] ?? 0;
        const rightScore = providerScores[right] ?? 0;
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }

        const leftReturned = providerDiagnostics[left]?.returnedTickers?.length || 0;
        const rightReturned = providerDiagnostics[right]?.returnedTickers?.length || 0;
        if (rightReturned !== leftReturned) {
          return rightReturned - leftReturned;
        }

        const leftLatency = providerDiagnostics[left]?.providerLatencyMs ?? Number.MAX_SAFE_INTEGER;
        const rightLatency = providerDiagnostics[right]?.providerLatencyMs ?? Number.MAX_SAFE_INTEGER;
        return leftLatency - rightLatency;
      })[0] || null;
  const effectiveProviderScore = effectiveProvider ? providerScores[effectiveProvider] ?? 0 : 0;
  const effectiveSource = effectiveProvider === "web" ? providerDiagnostics.web?.effectiveSource || null : null;
  const sourceAttempts = providerDiagnostics.web?.sourceAttempts || [];
  const sourceSnapshots = providerDiagnostics.web?.sourceSnapshots || {};
  const routerDecision = {
    attemptedOrder: providerOrder.attemptedOrder,
    providersSkipped: providerOrder.providersSkipped,
    usedStaleQuotes,
    syntheticFallbackTickers,
    fallbackReason: resolveRouterFallbackReason({
      providersSkipped: providerOrder.providersSkipped,
      usedStaleQuotes,
      syntheticFallbackTickers,
      errors: providerErrors
    })
  };

  log.info("market_router_completed", {
    primaryProvider,
    fallbackProvider,
    effectiveProvider,
    effectiveProviderScore,
    providersUsed,
    providersSkipped: providerOrder.providersSkipped,
    liveCount,
    webDelayedCount: coverageByMode.webDelayed,
    staleCount: coverageByMode.routerStale,
    fallbackCount,
    totalTickers,
    quotaBand,
    sourceMode: resolveSourceMode(providerCount, totalTickers)
  });

  return {
    provider: providersUsed.join("+") || "market-router",
    sourceMode: resolveSourceMode(providerCount, totalTickers),
    sourceMeta: {
      provider: providersUsed.join("+") || "market-router",
      configuredProvider: primaryProvider,
      configuredFallbackProvider: fallbackProvider || null,
      effectiveProvider,
      effectiveSource,
      providerScore: effectiveProviderScore,
      providerLatencyMs: effectiveProvider ? providerDiagnostics[effectiveProvider]?.providerLatencyMs ?? null : null,
      marketSession: session,
      session,
      providerScores,
      providersUsed,
      providersSkipped: providerOrder.providersSkipped,
      liveCount,
      delayedCount: coverageByMode.webDelayed,
      webDelayedCount: coverageByMode.webDelayed,
      totalTickers,
      fallbackCount,
      unresolvedTickers: syntheticFallbackTickers,
      usedStaleQuotes,
      coverageByMode,
      quotaBand,
      requestMode,
      batchSize: Number.parseInt(String(config.batchChunkSize ?? 25), 10) || 25,
      lastUpstreamError,
      errors: providerErrors,
      providerErrors,
      sourceAttempts,
      sourceSnapshots,
      providerDiagnostics: {
        web: providerDiagnostics.web || null,
        fmp: providerDiagnostics.fmp || null
      },
      routerDecision
    },
    quotes: mergedQuotes,
    historicalSeries,
    updatedAt: timestamp,
    session,
    revision: null
  };
}
