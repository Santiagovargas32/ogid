import { DATA_MODES, normalizeDataMode } from "../../utils/dataMode.js";

const DATA_MODE_STAGE = Object.freeze({ observed: "provider-observed", derived: "analysis-derived", seeded: "catalog-seeded", stale: "router-stale-cache", synthetic: "router-deterministic-fallback" });

export function normalizeQuoteDataMode(mode = DATA_MODES.SYNTHETIC) {
  return normalizeDataMode(mode, DATA_MODES.SYNTHETIC);
}

export function resolveQuoteOriginStage(quote = {}) {
  const mode = normalizeQuoteDataMode(quote?.dataMode || (quote?.synthetic ? DATA_MODES.SYNTHETIC : DATA_MODES.OBSERVED));
  return DATA_MODE_STAGE[mode] || "unknown";
}

export function getQuoteTimestamp(quote = {}) {
  return quote?.asOf || quote?.updatedAt || quote?.staleAt || null;
}

export function computeQuoteAgeMin(quote = {}, referenceNow = Date.now()) {
  const asOfTime = new Date(getQuoteTimestamp(quote) || 0).getTime();
  if (!Number.isFinite(asOfTime) || asOfTime <= 0) return null;
  const referenceMs = Number.isFinite(referenceNow) ? referenceNow : Date.now();
  return Math.round(Math.max(0, referenceMs - asOfTime) / 60_000);
}

export function decorateQuote(quote = {}, referenceNow = Date.now()) {
  const dataMode = normalizeQuoteDataMode(quote?.dataMode || (quote?.synthetic ? DATA_MODES.SYNTHETIC : DATA_MODES.OBSERVED));
  return { ...quote, dataMode, quoteOriginStage: resolveQuoteOriginStage({ ...quote, dataMode }), quoteAgeMin: computeQuoteAgeMin(quote, referenceNow) };
}

export function buildCoverageByMode(quotes = {}) {
  const coverage = { live: 0, webDelayed: 0, historicalEod: 0, routerStale: 0, syntheticFallback: 0 };
  for (const quote of Object.values(quotes || {})) {
    const mode = normalizeQuoteDataMode(quote?.dataMode || (quote?.synthetic ? DATA_MODES.SYNTHETIC : DATA_MODES.OBSERVED));
    if (mode === DATA_MODES.OBSERVED && quote?.providerDataMode === "web-delayed") coverage.webDelayed += 1;
    else if (mode === DATA_MODES.OBSERVED) coverage.live += 1;
    else if (mode === DATA_MODES.STALE) coverage.routerStale += 1;
    else coverage.syntheticFallback += 1;
  }
  return coverage;
}
