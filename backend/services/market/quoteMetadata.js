const DATA_MODE_STAGE = Object.freeze({
  live: "provider-live",
  "web-delayed": "provider-web-delayed",
  "historical-eod": "provider-historical-eod",
  "router-stale": "router-stale-cache",
  "synthetic-fallback": "router-deterministic-fallback",
  stale: "router-stale-cache",
  fallback: "router-deterministic-fallback"
});

const MODE_ALIAS = Object.freeze({
  stale: "router-stale",
  fallback: "synthetic-fallback"
});

export function normalizeQuoteDataMode(mode = "synthetic-fallback") {
  const normalized = String(mode || "").trim().toLowerCase();
  return MODE_ALIAS[normalized] || normalized || "synthetic-fallback";
}

export function resolveQuoteOriginStage(quote = {}) {
  const normalizedMode = normalizeQuoteDataMode(quote?.dataMode || (quote?.synthetic ? "synthetic-fallback" : "live"));
  return DATA_MODE_STAGE[normalizedMode] || "unknown";
}

export function getQuoteTimestamp(quote = {}) {
  return quote?.asOf || quote?.updatedAt || quote?.staleAt || null;
}

export function computeQuoteAgeMin(quote = {}, referenceNow = Date.now()) {
  const asOfTime = new Date(getQuoteTimestamp(quote) || 0).getTime();
  if (!Number.isFinite(asOfTime) || asOfTime <= 0) {
    return null;
  }

  const referenceMs = Number.isFinite(referenceNow) ? referenceNow : Date.now();
  const ageMs = Math.max(0, referenceMs - asOfTime);
  return Math.round(ageMs / 60_000);
}

export function decorateQuote(quote = {}, referenceNow = Date.now()) {
  const dataMode = normalizeQuoteDataMode(quote?.dataMode || (quote?.synthetic ? "synthetic-fallback" : "live"));
  return {
    ...quote,
    dataMode,
    quoteOriginStage: resolveQuoteOriginStage({ ...quote, dataMode }),
    quoteAgeMin: computeQuoteAgeMin({ ...quote, dataMode }, referenceNow)
  };
}

export function buildCoverageByMode(quotes = {}) {
  const coverage = {
    live: 0,
    webDelayed: 0,
    historicalEod: 0,
    routerStale: 0,
    syntheticFallback: 0
  };

  for (const quote of Object.values(quotes || {})) {
    const mode = normalizeQuoteDataMode(quote?.dataMode || (quote?.synthetic ? "synthetic-fallback" : "live"));
    if (mode === "live") {
      coverage.live += 1;
      continue;
    }
    if (mode === "web-delayed") {
      coverage.webDelayed += 1;
      continue;
    }
    if (mode === "historical-eod") {
      coverage.historicalEod += 1;
      continue;
    }
    if (mode === "router-stale") {
      coverage.routerStale += 1;
      continue;
    }
    coverage.syntheticFallback += 1;
  }

  return coverage;
}
