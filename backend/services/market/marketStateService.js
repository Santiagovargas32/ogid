import { createHash } from "node:crypto";
import { isMarketOpenEt } from "./marketSessionService.js";

const MAX_MARKET_POINTS = 120;

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
  const open = isMarketOpenEt(new Date(timestamp));
  return {
    open,
    state: open ? "open" : "closed",
    checkedAt: timestamp,
    timezone: "America/New_York"
  };
}

function computeMarketRevision(quotes = {}, session = {}, provider = "market-router", sourceMode = "fallback") {
  const revisionSeed = Object.keys(quotes || {})
    .sort()
    .map((ticker) => {
      const quote = quotes[ticker] || {};
      return [
        ticker,
        Number.isFinite(Number(quote.price)) ? Number(quote.price).toFixed(2) : "null",
        Number.isFinite(Number(quote.changePct)) ? Number(quote.changePct).toFixed(2) : "null",
        quote.asOf || quote.staleAt || "null",
        quote.source || "null",
        quote.sourceDetail || "null",
        quote.dataMode || "null",
        quote.marketState || "null"
      ].join("|");
    })
    .join("||");

  return createHash("sha1")
    .update([provider, sourceMode, session?.state || "unknown", revisionSeed].join("::"))
    .digest("hex")
    .slice(0, 16);
}

export function buildInitialMarketState(tickers = [], { enabled = true, disabledReason = null } = {}) {
  const normalizedTickers = Array.isArray(tickers) ? tickers : [];
  const marketDisabled = enabled === false;
  const now = new Date().toISOString();
  const session = buildMarketSession(now);

  return {
    provider: marketDisabled ? "disabled" : "market-router",
    sourceMode: marketDisabled ? "disabled" : "fallback",
    revision: null,
    session,
    sourceMeta: marketDisabled
      ? {
          provider: "disabled",
          reason: disabledReason || "market-provider-empty",
          enabled: false,
          requestMode: "disabled",
          disabledReason: disabledReason || "market-provider-empty",
          coverageByMode: buildDisabledCoverageByMode(),
          providerErrors: [],
          marketSession: session
        }
      : {
          provider: "seed",
          reason: "initial-state",
          enabled: true,
          marketSession: session
        },
    updatedAt: now,
    quotes: Object.fromEntries(
      normalizedTickers.map((ticker) => [
        ticker,
        {
          price: null,
          changePct: 0,
          asOf: null,
          source: marketDisabled ? "disabled" : "seed",
          synthetic: true,
          dataMode: "synthetic-fallback",
          providerScore: 0,
          providerLatencyMs: null
        }
      ])
    ),
    timeseries: Object.fromEntries(normalizedTickers.map((ticker) => [ticker, []]))
  };
}

function appendPoint(series = [], point) {
  const lastPoint = series.at(-1);
  if (
    lastPoint &&
    lastPoint.timestamp === point.timestamp &&
    Number(lastPoint.price) === Number(point.price) &&
    Number(lastPoint.changePct) === Number(point.changePct)
  ) {
    return series.slice(-MAX_MARKET_POINTS);
  }

  return [...series, point].slice(-MAX_MARKET_POINTS);
}

function seedHistoricalSeries(existingSeries = [], seededSeries = []) {
  if (existingSeries.length || !seededSeries.length) {
    return existingSeries;
  }

  return seededSeries
    .filter((point) => Number.isFinite(point?.price) && point?.timestamp)
    .slice(-MAX_MARKET_POINTS)
    .map((point) => ({
      timestamp: point.timestamp,
      price: point.price,
      changePct: point.changePct
    }));
}

function markProviderSlotsPaused(providerSlots = [], upstreamPaused = false) {
  return (Array.isArray(providerSlots) ? providerSlots : []).map((slot) => ({
    ...slot,
    upstreamPaused
  }));
}

export function refreshMarketSessionMetadata(
  previousMarketState = {},
  { timestamp = new Date().toISOString(), pauseReason = "offhours-skip", upstreamPaused = true } = {}
) {
  const nextSession = buildMarketSession(timestamp);
  const previousSourceMeta = previousMarketState.sourceMeta || {};
  const nextSourceMeta = {
    ...previousSourceMeta,
    session: nextSession,
    marketSession: nextSession,
    upstreamPaused,
    pauseReason,
    providerSlots: markProviderSlotsPaused(previousSourceMeta.providerSlots || [], upstreamPaused),
    routerDecision: {
      ...(previousSourceMeta.routerDecision || {}),
      upstreamPaused,
      pauseReason
    }
  };

  return {
    ...previousMarketState,
    sourceMeta: nextSourceMeta,
    revision: computeMarketRevision(
      previousMarketState.quotes || {},
      nextSession,
      previousMarketState.provider || "market-router",
      previousMarketState.sourceMode || "fallback"
    ),
    session: nextSession
  };
}

export function mergeMarketState(previousMarketState = {}, marketResult = {}) {
  const nextQuotes = {
    ...(previousMarketState.quotes || {}),
    ...(marketResult.quotes || {})
  };

  const nextTimeseries = { ...(previousMarketState.timeseries || {}) };
  const timestamp = marketResult.updatedAt || new Date().toISOString();
  const nextSession = marketResult.session || previousMarketState.session || buildMarketSession(timestamp);

  for (const [ticker, seededSeries] of Object.entries(marketResult.historicalSeries || {})) {
    nextTimeseries[ticker] = seedHistoricalSeries(nextTimeseries[ticker] || [], seededSeries);
  }

  for (const [ticker, quote] of Object.entries(nextQuotes)) {
    if (!Number.isFinite(quote.price)) {
      continue;
    }

    const point = {
      timestamp: quote.asOf || timestamp,
      price: quote.price,
      changePct: quote.changePct
    };
    nextTimeseries[ticker] = appendPoint(nextTimeseries[ticker] || [], point);
  }

  return {
    provider: marketResult.provider || previousMarketState.provider || "market-router",
    sourceMode: marketResult.sourceMode || previousMarketState.sourceMode || "fallback",
    sourceMeta: marketResult.sourceMeta || previousMarketState.sourceMeta || { provider: "unknown" },
    revision:
      marketResult.revision ||
      computeMarketRevision(
        nextQuotes,
        nextSession,
        marketResult.provider || previousMarketState.provider || "market-router",
        marketResult.sourceMode || previousMarketState.sourceMode || "fallback"
      ),
    session: nextSession,
    updatedAt: timestamp,
    quotes: nextQuotes,
    timeseries: nextTimeseries
  };
}
