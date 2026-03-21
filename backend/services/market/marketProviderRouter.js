import apiQuotaTracker from "../admin/apiQuotaTrackerService.js";
import { resolveBandByProviderSnapshots } from "../refreshPolicyService.js";
import { createLogger } from "../../utils/logger.js";
import { fetchTwelveQuotes } from "./providers/twelveProvider.js";
import { fetchYahooQuotes } from "./providers/yahooProvider.js";
import { buildFallbackQuote } from "./providers/quoteFallback.js";
import { isMarketOpenEt } from "./marketSessionService.js";
import { buildCoverageByMode } from "./quoteMetadata.js";

const log = createLogger("backend/services/market/marketProviderRouter");

const PROVIDERS = Object.freeze({
  twelve: {
    fetcher: fetchTwelveQuotes,
    transport: "api",
    estimateUnits: () => 1
  },
  yahoo: {
    fetcher: fetchYahooQuotes,
    transport: "web",
    estimateUnits: (tickers = []) => Math.max(1, Array.isArray(tickers) ? tickers.length : 0)
  }
});

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

function normalizeProvider(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized in PROVIDERS ? normalized : "";
}

function resolveDefaultFallbackProvider(primaryProvider = "") {
  return primaryProvider === "twelve" ? "yahoo" : "";
}

function buildProviderChain(primaryProvider = "", fallbackProvider = "") {
  return [primaryProvider, fallbackProvider].filter(Boolean).join("+") || null;
}

function buildProviderConfig(provider, config = {}, session = null) {
  if (provider === "twelve") {
    return {
      baseUrl: config.twelveBaseUrl,
      apiKey: config.twelveApiKey,
      enablePrepost: config.twelveEnablePrepost === true,
      session
    };
  }

  return {
    baseUrl: config.yahooBaseUrl,
    userAgent: config.yahooUserAgent,
    session
  };
}

function resolveProviderAvailability(provider, config = {}, { reserve = 0, allowExhaustedProviders = false, tickers = [] } = {}) {
  const snapshot = apiQuotaTracker.getProviderSnapshot(provider);
  const remaining = snapshot?.effectiveRemaining;
  const normalizedReserve = Math.max(0, Number.parseInt(String(reserve ?? 0), 10) || 0);
  const estimatedUnits = PROVIDERS[provider]?.estimateUnits?.(tickers) ?? 1;

  if (allowExhaustedProviders) {
    return {
      available: true,
      snapshot,
      estimatedUnits,
      reason: null
    };
  }

  if (snapshot?.exhausted) {
    return {
      available: false,
      snapshot,
      estimatedUnits,
      reason: "exhausted"
    };
  }

  if (Number.isFinite(remaining) && remaining - estimatedUnits < normalizedReserve) {
    return {
      available: false,
      snapshot,
      estimatedUnits,
      reason: "reserve-floor"
    };
  }

  return {
    available: true,
    snapshot,
    estimatedUnits,
    reason: null
  };
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

function resolveProviderStatus(result = null, { idle = false, skipped = false, disabled = false } = {}) {
  if (disabled) {
    return "disabled";
  }
  if (skipped) {
    return "skipped";
  }
  if (idle) {
    return "idle";
  }
  if (!result) {
    return "idle";
  }

  const returnedCount = Number((result.returnedTickers || []).length || 0);
  const missingCount = Number((result.missingTickers || []).length || 0);
  const errorCount = Number((result.errors || []).length || 0);

  if (returnedCount <= 0) {
    return errorCount > 0 ? "error" : "empty";
  }
  if (missingCount > 0 || errorCount > 0) {
    return "partial";
  }
  return "ok";
}

function buildSampleQuotes(quotes = {}, orderedTickers = [], maxItems = 5) {
  const order = [...new Set((orderedTickers || []).map((ticker) => String(ticker || "").toUpperCase()).filter(Boolean))];
  return order
    .map((ticker) => {
      const quote = quotes?.[ticker];
      if (!quote) {
        return null;
      }
      return {
        ticker,
        price: Number.isFinite(Number(quote.price)) ? Number(quote.price) : null,
        asOf: quote.asOf || quote.updatedAt || null,
        source: quote.source || null,
        sourceDetail: quote.sourceDetail || null,
        dataMode: quote.dataMode || null,
        providerScore: Number.isFinite(Number(quote.providerScore)) ? Number(quote.providerScore) : null,
        providerLatencyMs: Number.isFinite(Number(quote.providerLatencyMs)) ? Number(quote.providerLatencyMs) : null,
        marketState: quote.marketState || null
      };
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function buildProviderSlot({
  role,
  provider,
  requestResult = null,
  configuredBaseUrl = null,
  quotaSnapshot = null,
  requestedTickers = [],
  statusOverride = null,
  marketEnabled = true
} = {}) {
  const transport = PROVIDERS[provider]?.transport || null;
  const status = statusOverride || resolveProviderStatus(requestResult, { disabled: marketEnabled === false });
  const result = requestResult || {};
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const sampleQuotes = buildSampleQuotes(result.quotes || {}, requestedTickers, 5);

  return {
    role,
    provider,
    transport,
    configuredBaseUrl,
    status,
    requestMode: result.requestMode || (status === "idle" ? "standby" : "unavailable"),
    returnedTickers: result.returnedTickers || [],
    missingTickers: result.missingTickers || [],
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : 0,
    latencyMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : 0,
    quotaSnapshot: quotaSnapshot || result.quotaSnapshot || apiQuotaTracker.getProviderSnapshot(provider),
    requestUrls: result.requestUrls || [],
    httpStatus: Number.isFinite(Number(result.httpStatus)) ? Number(result.httpStatus) : null,
    errorCode: errors.at(-1)?.code || errors.at(-1)?.reason || null,
    errorMessage: errors.at(-1)?.message || null,
    responsePreview: result.responsePreview || errors.at(-1)?.responsePreview || null,
    sampleQuotes,
    lastAttemptAt: result.lastAttemptAt || null,
    lastSuccessAt: result.lastSuccessAt || null
  };
}

function buildSkippedSlot({
  role,
  provider,
  requestedTickers = [],
  availability,
  configuredBaseUrl = null
} = {}) {
  const reason = availability?.reason || "unavailable";
  const message =
    reason === "reserve-floor"
      ? `${provider} was skipped because the request would cross the reserve floor.`
      : `${provider} was skipped because quota is exhausted.`;

  return buildProviderSlot({
    role,
    provider,
    configuredBaseUrl,
    quotaSnapshot: availability?.snapshot || apiQuotaTracker.getProviderSnapshot(provider),
    requestedTickers,
    statusOverride: "skipped",
    requestResult: {
      requestMode: "unavailable",
      returnedTickers: [],
      missingTickers: requestedTickers,
      score: 0,
      durationMs: 0,
      requestUrls: [],
      httpStatus: null,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: null,
      errors: [
        {
          provider,
          code: reason,
          reason,
          message
        }
      ]
    }
  });
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

function buildDisabledProviderSlots(config = {}) {
  const slots = [];
  if (config.provider) {
    slots.push(
      buildProviderSlot({
        role: "primary",
        provider: config.provider,
        configuredBaseUrl: config.provider === "twelve" ? config.twelveBaseUrl : config.yahooBaseUrl,
        requestedTickers: config.tickers || [],
        marketEnabled: false
      })
    );
  }
  if (config.fallbackProvider) {
    slots.push(
      buildProviderSlot({
        role: "fallback",
        provider: config.fallbackProvider,
        configuredBaseUrl: config.fallbackProvider === "twelve" ? config.twelveBaseUrl : config.yahooBaseUrl,
        requestedTickers: config.tickers || [],
        marketEnabled: false
      })
    );
  }
  return slots;
}

function buildDisabledMarketResult(config = {}, timestamp = new Date().toISOString()) {
  const tickers = (config.tickers || []).map((ticker) => String(ticker).toUpperCase());
  const batchSize = Number.parseInt(String(config.batchChunkSize ?? 25), 10) || 25;
  const session = buildMarketSession(timestamp);
  const providerChain = buildProviderChain(config.provider, config.fallbackProvider);

  return {
    provider: "disabled",
    sourceMode: "disabled",
    revision: null,
    session,
    sourceMeta: {
      enabled: false,
      provider: "disabled",
      providerChain,
      configuredProvider: config.provider || null,
      configuredFallbackProvider: config.fallbackProvider || null,
      effectiveProvider: null,
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
      providerSlots: buildDisabledProviderSlots(config),
      routerDecision: {
        attemptedOrder: [],
        providersSkipped: [],
        usedStaleQuotes: [],
        syntheticFallbackTickers: [],
        fallbackReason: config.disabledReason || "market-provider-empty"
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

export async function fetchMarketQuotes(config = {}) {
  if (config.enabled === false) {
    return buildDisabledMarketResult(config);
  }

  const tickers = [...new Set((config.tickers || []).map((ticker) => String(ticker).toUpperCase()).filter(Boolean))];
  const timestampSource = config.timestamp || new Date().toISOString();
  const parsedTimestamp = new Date(timestampSource);
  const timestamp = Number.isFinite(parsedTimestamp.getTime()) ? parsedTimestamp.toISOString() : new Date().toISOString();
  const session = buildMarketSession(timestamp);
  const primaryProvider = normalizeProvider(config.provider);
  const fallbackProvider = normalizeProvider(config.fallbackProvider || resolveDefaultFallbackProvider(primaryProvider));
  const providerChain = buildProviderChain(primaryProvider, fallbackProvider);

  if (!primaryProvider) {
    return buildDisabledMarketResult({
      ...config,
      provider: "",
      fallbackProvider: "",
      disabledReason: config.disabledReason || "market-provider-invalid"
    });
  }

  const attemptedOrder = [...new Set([primaryProvider, fallbackProvider].filter(Boolean))];
  const requestReserve = Math.max(0, Number.parseInt(String(config.requestReserve ?? 0), 10) || 0);
  const staleTtlMs = Math.max(0, Number.parseInt(String(config.staleTtlMs ?? 0), 10) || 0);
  const previousQuotes = config.previousQuotes || {};
  const mergedQuotes = {};
  const historicalSeries = {};
  const providersUsed = [];
  const providersSkipped = [];
  const providerErrors = [];
  const providerResults = {};
  let unresolved = [...tickers];
  let lastUpstreamError = null;

  for (const provider of attemptedOrder) {
    if (!unresolved.length) {
      break;
    }

    const role = provider === primaryProvider ? "primary" : "fallback";
    const configuredBaseUrl = provider === "twelve" ? config.twelveBaseUrl : config.yahooBaseUrl;
    const availability = resolveProviderAvailability(provider, config, {
      reserve: requestReserve,
      allowExhaustedProviders: config.allowExhaustedProviders === true,
      tickers: unresolved
    });

    if (!availability.available) {
      providersSkipped.push({
        provider,
        reason: availability.reason,
        remaining: availability.snapshot?.effectiveRemaining ?? null,
        estimatedUnits: availability.estimatedUnits,
        transport: PROVIDERS[provider]?.transport || null
      });
      providerResults[provider] = buildSkippedSlot({
        role,
        provider,
        requestedTickers: unresolved,
        availability,
        configuredBaseUrl
      });
      continue;
    }

    const providerResult = await PROVIDERS[provider].fetcher({
      ...buildProviderConfig(provider, config, session),
      tickers: unresolved,
      timeoutMs: config.timeoutMs,
      timestamp
    });

    providersUsed.push(provider);
    providerResults[provider] = buildProviderSlot({
      role,
      provider,
      requestResult: providerResult,
      configuredBaseUrl,
      quotaSnapshot: providerResult.quotaSnapshot,
      requestedTickers: unresolved
    });
    Object.assign(mergedQuotes, providerResult.quotes || {});
    Object.assign(historicalSeries, providerResult.historicalSeries || {});
    providerErrors.push(
      ...(providerResult.errors || []).map((error) => ({
        provider,
        ...error,
        code: error.code || error.reason || "unknown-error",
        reason: error.reason || error.code || "unknown-error"
      }))
    );
    const providerErrorCode = providerResult.errors?.at(-1)?.code || providerResult.errors?.at(-1)?.reason || null;
    if (providerErrorCode) {
      lastUpstreamError = providerErrorCode;
    }
    unresolved = unresolved.filter((ticker) => !providerResult.quotes?.[ticker]);
  }

  for (const provider of attemptedOrder) {
    if (providerResults[provider]) {
      continue;
    }
    const role = provider === primaryProvider ? "primary" : "fallback";
    providerResults[provider] = buildProviderSlot({
      role,
      provider,
      configuredBaseUrl: provider === "twelve" ? config.twelveBaseUrl : config.yahooBaseUrl,
      requestedTickers: tickers,
      statusOverride: "idle"
    });
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
  }

  const coverageByMode = buildCoverageByMode(mergedQuotes);
  const providerBackedCount = coverageByMode.live + coverageByMode.webDelayed;
  const fallbackCount = coverageByMode.routerStale + coverageByMode.syntheticFallback;
  const usedStaleQuotes = Object.keys(staleQuotes);

  const providerSlots = attemptedOrder.map((provider) => providerResults[provider]).filter(Boolean);
  const effectiveProvider =
    providerSlots
      .filter((slot) => Number((slot.returnedTickers || []).length || 0) > 0)
      .sort((left, right) => {
        const leftReturned = Number((left.returnedTickers || []).length || 0);
        const rightReturned = Number((right.returnedTickers || []).length || 0);
        if (rightReturned !== leftReturned) {
          return rightReturned - leftReturned;
        }
        if ((right.score || 0) !== (left.score || 0)) {
          return (right.score || 0) - (left.score || 0);
        }
        return (left.latencyMs || Number.MAX_SAFE_INTEGER) - (right.latencyMs || Number.MAX_SAFE_INTEGER);
      })[0]?.provider || null;
  const effectiveSlot = providerSlots.find((slot) => slot.provider === effectiveProvider) || null;
  const providerSnapshots = attemptedOrder
    .map((provider) => apiQuotaTracker.getProviderSnapshot(provider))
    .filter(Boolean);
  const quotaBand = resolveBandByProviderSnapshots(providerSnapshots);
  const requestMode = [
    ...new Set(
      providerSlots
        .map((slot) => slot.requestMode)
        .filter((mode) => mode && mode !== "standby")
    )
  ].join("+") || "unavailable";
  const routerDecision = {
    attemptedOrder,
    providersSkipped,
    usedStaleQuotes,
    syntheticFallbackTickers,
    fallbackReason: resolveRouterFallbackReason({
      providersSkipped,
      usedStaleQuotes,
      syntheticFallbackTickers,
      errors: providerErrors
    })
  };

  log.info("market_router_completed", {
    providerChain,
    effectiveProvider,
    providersUsed,
    providersSkipped,
    liveCount: coverageByMode.live,
    fallbackCount,
    totalTickers: tickers.length,
    quotaBand,
    sourceMode: resolveSourceMode(providerBackedCount, tickers.length)
  });

  return {
    provider: providerChain || primaryProvider,
    sourceMode: resolveSourceMode(providerBackedCount, tickers.length),
    sourceMeta: {
      enabled: true,
      provider: providerChain || primaryProvider,
      providerChain,
      configuredProvider: primaryProvider,
      configuredFallbackProvider: fallbackProvider || null,
      effectiveProvider,
      providerScore: effectiveSlot?.score ?? 0,
      providerLatencyMs: effectiveSlot?.latencyMs ?? null,
      marketSession: session,
      session,
      providerScores: Object.fromEntries(providerSlots.map((slot) => [slot.provider, slot.score || 0])),
      providersUsed,
      providersSkipped,
      liveCount: coverageByMode.live,
      delayedCount: coverageByMode.webDelayed,
      webDelayedCount: coverageByMode.webDelayed,
      totalTickers: tickers.length,
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
      providerSlots,
      routerDecision
    },
    quotes: mergedQuotes,
    historicalSeries,
    updatedAt: timestamp,
    session,
    revision: null
  };
}
