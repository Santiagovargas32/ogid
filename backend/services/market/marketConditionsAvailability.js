import { isExchangeSessionOpen } from "./marketSessionService.js";

const FIVE_MINUTES_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;
const AUTOMATIC_EXCHANGE_ASSET_TYPES = new Set(["equity", "etf", "fund", "index"]);
const SYNTHETIC_MODES = new Set(["synthetic", "seeded", "fallback"]);
const STALE_MODES = new Set(["stale", "stale-if-error"]);

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

function normalizedAssetType(instrument = {}) {
  return String(instrument.assetType || "").trim().toLowerCase();
}

function isContinuousInstrument(instrument = {}) {
  return instrument.sessionPolicy === "24x7" || normalizedAssetType(instrument) === "crypto";
}

function isExchangeInstrument(instrument = {}) {
  return ["exchange-hours", "nyse-equities"].includes(String(instrument.sessionPolicy || "").toLowerCase());
}

function supportsAutomaticIngestion(instrument = {}) {
  if (isContinuousInstrument(instrument) || instrument.sessionPolicy === "nyse-equities") return true;
  return instrument.sessionPolicy === "exchange-hours" && AUTOMATIC_EXCHANGE_ASSET_TYPES.has(normalizedAssetType(instrument));
}

function exchangeOpen(instrument, value) {
  try {
    return isExchangeSessionOpen(new Date(value), instrument.timezone || "America/New_York");
  } catch {
    return null;
  }
}

function floorToFiveMinutes(timestamp) {
  return Math.floor(timestamp / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

function localDateTime(value, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).formatToParts(new Date(value));
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour) % 24,
      minute: Number(map.minute)
    };
  } catch {
    return null;
  }
}

function calendarDate(parts, offsetDays = 0) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

function weekdayDate(parts, direction, includeCurrent = false) {
  for (let offset = includeCurrent ? 0 : direction; Math.abs(offset) <= 8; offset += direction) {
    const candidate = calendarDate(parts, offset);
    if (candidate.weekday >= 1 && candidate.weekday <= 5) return candidate;
  }
  return null;
}

function zonedDateTimeIso(parts, timeZone) {
  const targetWallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let candidate = targetWallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localDateTime(candidate, timeZone);
    if (!actual) return null;
    const actualWallClock = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const correction = targetWallClock - actualWallClock;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
}

function expectedLatestExchangeClose(instrument, asOfMs) {
  const timeZone = instrument.timezone || "America/New_York";
  const local = localDateTime(asOfMs, timeZone);
  if (!local) return null;
  const today = calendarDate(local);
  const minute = local.hour * 60 + local.minute;
  if (today.weekday >= 1 && today.weekday <= 5 && minute >= 9 * 60 + 35 && minute <= 16 * 60) {
    const closedMinute = Math.floor(minute / 5) * 5;
    return zonedDateTimeIso({ ...today, hour: Math.floor(closedMinute / 60), minute: closedMinute % 60 }, timeZone);
  }
  if (today.weekday >= 1 && today.weekday <= 5 && minute > 16 * 60) {
    return zonedDateTimeIso({ ...today, hour: 16, minute: 0 }, timeZone);
  }
  const previous = weekdayDate(local, -1);
  return previous ? zonedDateTimeIso({ ...previous, hour: 16, minute: 0 }, timeZone) : null;
}

function nextExchangeOpen(instrument, asOfMs) {
  const timeZone = instrument.timezone || "America/New_York";
  const local = localDateTime(asOfMs, timeZone);
  if (!local) return null;
  const today = calendarDate(local);
  const minute = local.hour * 60 + local.minute;
  if (today.weekday >= 1 && today.weekday <= 5 && minute < 9 * 60 + 30) {
    return zonedDateTimeIso({ ...today, hour: 9, minute: 30 }, timeZone);
  }
  const next = weekdayDate(local, 1);
  return next ? zonedDateTimeIso({ ...next, hour: 9, minute: 30 }, timeZone) : null;
}

function sessionDetails(instrument, asOfMs, automaticIngestionSupported) {
  if (isContinuousInstrument(instrument)) {
    return {
      sessionState: "continuous",
      expectedLatestCandleAt: new Date(floorToFiveMinutes(asOfMs)).toISOString(),
      nextEligibleAt: null
    };
  }
  if (!isExchangeInstrument(instrument)) {
    return { sessionState: "unknown", expectedLatestCandleAt: null, nextEligibleAt: null };
  }
  if (!automaticIngestionSupported) {
    return { sessionState: "unsupported", expectedLatestCandleAt: null, nextEligibleAt: null };
  }
  const open = exchangeOpen(instrument, asOfMs);
  if (open == null) return { sessionState: "unknown", expectedLatestCandleAt: null, nextEligibleAt: null };
  return {
    sessionState: open ? "open" : "closed",
    expectedLatestCandleAt: automaticIngestionSupported ? expectedLatestExchangeClose(instrument, asOfMs) : null,
    nextEligibleAt: !open && automaticIngestionSupported ? nextExchangeOpen(instrument, asOfMs) : null
  };
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
  outsideIntradayLimit = false
} = {}) {
  const asOfIso = iso(asOf);
  if (!asOfIso) throw new TypeError("invalid-market-conditions-availability-as-of");
  const asOfMs = Date.parse(asOfIso);
  const automaticIngestionSupported = supportsAutomaticIngestion(instrument);
  const session = sessionDetails(instrument, asOfMs, automaticIngestionSupported);
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
  const marketClosed = automaticIngestionSupported && session.sessionState === "closed";
  const warmingUp = !noHistory && !stale && !marketClosed && availableClosedCandles < 2;
  const rollupGaps = Boolean(
    seriesQuality?.gapDetected
    || seriesGaps.length
    || incompleteBuckets.some((bucket) => bucket?.reason !== "bucket_open")
  );

  let primaryReason = null;
  if (outsideIntradayLimit) primaryReason = "outside_intraday_limit";
  else if (noHistory) primaryReason = "no_5m_history";
  else if (stale) primaryReason = "stale_local_data";
  else if (marketClosed) primaryReason = "market_closed";
  else if (warmingUp) primaryReason = "warming_up";

  const reasonCodes = [];
  if (outsideIntradayLimit) {
    reasonCodes.push("outside_intraday_limit");
  } else {
    if (noHistory) reasonCodes.push("no_5m_history");
    if (stale) reasonCodes.push("stale_local_data");
    if (marketClosed) reasonCodes.push("market_closed");
    if (warmingUp) reasonCodes.push("warming_up");
    if (rollupGaps) reasonCodes.push("rollup_gaps");
    if (!automaticIngestionSupported) reasonCodes.push("automatic_ingestion_unsupported");
    else if (automaticIngestionEnabled !== true) reasonCodes.push("automatic_ingestion_disabled");
  }

  const ingestionState = outsideIntradayLimit
    ? "not_scheduled"
    : !automaticIngestionSupported
      ? "unsupported"
      : automaticIngestionEnabled === true
        ? "enabled"
        : "disabled";

  return {
    analyzable: primaryReason == null,
    primaryReason,
    reasonCodes,
    sessionState: session.sessionState,
    ingestionState,
    lastCandleAt: history.lastCandleAt,
    expectedLatestCandleAt: session.expectedLatestCandleAt,
    nextEligibleAt: session.nextEligibleAt,
    requiredClosedCandles: 2,
    availableClosedCandles
  };
}
