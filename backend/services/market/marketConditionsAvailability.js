import { sessionPolicyResolver } from "./sessionPolicyResolver.js";

const FIVE_MINUTES_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;
const SYNTHETIC_MODES = new Set(["synthetic", "seeded", "fallback"]);
const STALE_MODES = new Set(["stale", "stale-if-error"]);
const ACQUISITION_STATES = new Set(["queued", "pending_bootstrap", "provider_cooldown"]);

function iso(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function positiveMilliseconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function modeOf(value = {}) {
  return String(value.dataMode || value.mode || (value.synthetic ? "synthetic" : "observed")).toLowerCase();
}

function isSynthetic(value = {}) {
  return value.synthetic === true || SYNTHETIC_MODES.has(modeOf(value));
}

function isExplicitlyStale(value = {}) {
  return value.stale === true
    || STALE_MODES.has(modeOf(value))
    || value.quality === "stale-if-error"
    || value.provenance?.stale === true;
}

function isClosedCandle(candle, asOfMs) {
  const closeMs = Date.parse(candle?.closeTime);
  return Number.isFinite(closeMs) && closeMs <= asOfMs && !isSynthetic(candle);
}

function acquisitionStateOf(value = {}) {
  const state = String(value?.state || "").trim().toLowerCase().replaceAll("-", "_");
  return ACQUISITION_STATES.has(state) ? state : null;
}

function providerRetryAt(value = {}) {
  const attemptedAt = Date.parse(value?.lastAttemptAt || "");
  const retryAfterMs = Number(value?.retryAfterMs);
  if (!Number.isFinite(attemptedAt) || !(retryAfterMs > 0)) return null;
  return new Date(attemptedAt + retryAfterMs).toISOString();
}

function resolveBaseHistory({ baseCandles, base5m, seriesCandles, seriesInterval, asOfMs }) {
  const explicitBase = Array.isArray(baseCandles) ? baseCandles : [];
  const inferredBase = explicitBase.length || seriesInterval !== "5min" ? explicitBase : seriesCandles;
  const closedBase = inferredBase.filter((candle) => candle?.interval === "5min" && isClosedCandle(candle, asOfMs));
  const count = Number.isFinite(Number(base5m?.count)) ? Math.max(0, Number(base5m.count)) : closedBase.length;
  const nonSyntheticCount = Number.isFinite(Number(base5m?.nonSyntheticCount))
    ? Math.max(0, Number(base5m.nonSyntheticCount))
    : closedBase.length;
  const latestFromCandles = closedBase.sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime)).at(-1);
  const lastCandleAt = iso(base5m?.lastCandleAt || latestFromCandles?.closeTime || seriesCandles.at(-1)?.closeTime);
  const explicitlyStale = base5m?.explicitlyStale === true
    || closedBase.some(isExplicitlyStale)
    || (seriesInterval !== "5min" && seriesCandles.some(isExplicitlyStale));
  return { count, nonSyntheticCount, lastCandleAt, explicitlyStale };
}

/**
 * Classifies whether a persisted symbol series can represent current conditions.
 * This function is intentionally pure: it never reads the store or calls a provider.
 */
export function classifyMarketConditionsAvailability({
  instrument = {},
  quote = {},
  baseCandles = [],
  base5m = null,
  seriesCandles = [],
  seriesInterval = "5min",
  seriesQuality = {},
  seriesGaps = [],
  incompleteBuckets = [],
  windowMin = 240,
  asOf = new Date().toISOString(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  automaticIngestionEnabled = true,
  acquisitionState = null,
  outsideIntradayLimit = false
} = {}) {
  const asOfIso = iso(asOf);
  if (!asOfIso) throw new TypeError("invalid-market-conditions-availability-as-of");
  const asOfMs = Date.parse(asOfIso);
  const session = sessionPolicyResolver.resolve(instrument, asOfMs, { intervalMs: FIVE_MINUTES_MS });
  const automaticIngestionSupported = session.automaticIngestionSupported;
  const sessionPolicyPartial = automaticIngestionSupported && session.sessionPolicyPartial;
  const sessionState = automaticIngestionSupported ? session.sessionState : "unsupported";
  const acquisitionLifecycle = acquisitionStateOf(acquisitionState);
  const history = resolveBaseHistory({ baseCandles, base5m, seriesCandles, seriesInterval, asOfMs });
  const fromMs = asOfMs - Math.max(1, Number(windowMin) || 1) * 60_000;
  const availableClosedCandles = seriesCandles.filter((candle) => {
    const closeMs = Date.parse(candle?.closeTime);
    return isClosedCandle(candle, asOfMs) && closeMs >= fromMs;
  }).length;
  const freshnessToleranceMs = Math.max(
    2 * positiveMilliseconds(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    3 * FIVE_MINUTES_MS
  );
  const expectedLatestMs = Date.parse(session.expectedLatestCandleAt || "");
  const lastCandleMs = Date.parse(history.lastCandleAt || "");
  const staleByRecency = Number.isFinite(expectedLatestMs)
    && Number.isFinite(lastCandleMs)
    && expectedLatestMs - lastCandleMs > freshnessToleranceMs;
  const noHistory = history.nonSyntheticCount === 0 || !history.lastCandleAt;
  const stale = !noHistory && (history.explicitlyStale || isExplicitlyStale(quote) || staleByRecency);
  const marketClosed = automaticIngestionSupported && sessionState === "closed";
  const warmingUp = !noHistory && !stale && !marketClosed && availableClosedCandles < 2;
  const rollupGaps = Boolean(
    seriesQuality?.gapDetected
    || seriesGaps.length
    || incompleteBuckets.some((bucket) => bucket?.reason !== "bucket_open")
  );

  let blockingReason = null;
  if (outsideIntradayLimit) blockingReason = "outside_intraday_limit";
  else if (noHistory) blockingReason = acquisitionLifecycle || "no_5m_history";
  else if (stale) blockingReason = "stale_local_data";
  else if (marketClosed) blockingReason = "market_closed";
  else if (warmingUp) blockingReason = "warming_up";
  const primaryReason = blockingReason || acquisitionLifecycle || (sessionPolicyPartial ? "session_policy_partial" : null);

  const reasonCodes = [];
  if (outsideIntradayLimit) {
    reasonCodes.push("outside_intraday_limit");
  } else {
    if (noHistory) reasonCodes.push("no_5m_history");
    if (stale) reasonCodes.push("stale_local_data");
    if (marketClosed) reasonCodes.push("market_closed");
    if (warmingUp) reasonCodes.push("warming_up");
    if (rollupGaps) reasonCodes.push("rollup_gaps");
    if (acquisitionLifecycle) reasonCodes.push(acquisitionLifecycle);
    if (sessionPolicyPartial) reasonCodes.push("session_policy_partial");
    if (!automaticIngestionSupported) reasonCodes.push("automatic_ingestion_unsupported");
    else if (automaticIngestionEnabled !== true) reasonCodes.push("automatic_ingestion_disabled");
  }

  const ingestionState = outsideIntradayLimit
    ? "not_scheduled"
    : !automaticIngestionSupported
      ? "unsupported"
      : automaticIngestionEnabled !== true
        ? "disabled"
        : acquisitionLifecycle || (sessionPolicyPartial ? "session_policy_partial" : "enabled");

  const nextEligibleAt = acquisitionLifecycle === "provider_cooldown"
    ? providerRetryAt(acquisitionState) || session.nextEligibleAt
    : session.nextEligibleAt;

  return {
    analyzable: blockingReason == null,
    primaryReason,
    reasonCodes,
    sessionState,
    ingestionState,
    lastCandleAt: history.lastCandleAt,
    expectedLatestCandleAt: session.expectedLatestCandleAt,
    nextEligibleAt,
    requiredClosedCandles: 2,
    availableClosedCandles
  };
}
