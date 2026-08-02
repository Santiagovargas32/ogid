import { candleIntervalMs } from "./canonicalCandle.js";

export const CANDLE_ROLLUP_METHOD_VERSION = "candle-rollup-v1";
export const MARKET_CONDITION_INTERVALS = Object.freeze({ 15: "5min", 60: "15min", 240: "1h", 1440: "1h" });

const EQUITY_SESSION_OPEN_MINUTE = 9 * 60 + 30;
const EQUITY_SESSION_CLOSE_MINUTE = 16 * 60;
const SUPPORTED_ROLLUPS = Object.freeze({ "5min:15min": 3, "15min:1h": 4 });

function finite(value) { return Number.isFinite(Number(value)); }
function iso(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }
function adjustmentMode(candle) { return candle?.provenance?.adjustmentMode || (candle?.adjusted === false ? "none" : "splits"); }
function statusRank(value) { return { observed: 0, partial: 1, stale: 2, synthetic: 3, insufficient_data: 4 }[value] ?? 1; }
function worstStatus(values = []) { return values.reduce((worst, value) => statusRank(value) > statusRank(worst) ? value : worst, "observed"); }
function candleStatus(candle) {
  if (candle?.dataMode === "synthetic" || candle?.quality === "synthetic") return "synthetic";
  if (candle?.dataMode === "stale" || candle?.quality === "stale-if-error" || candle?.provenance?.stale === true) return "stale";
  if (candle?.dataMode !== "observed" || !["valid", "derived-valid", undefined, null].includes(candle?.quality)) return "partial";
  return "observed";
}

function localParts(timestamp, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(new Date(timestamp));
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      date: `${map.year}-${map.month}-${map.day}`,
      weekday: map.weekday,
      hour: Number(map.hour) % 24,
      minute: Number(map.minute),
      second: Number(map.second)
    };
  } catch {
    return null;
  }
}

function validMarketCandle(candle, interval) {
  const openMs = Date.parse(candle?.openTime); const closeMs = Date.parse(candle?.closeTime);
  return candle?.interval === interval
    && Number.isFinite(openMs)
    && Number.isFinite(closeMs)
    && closeMs > openMs
    && [candle.open, candle.high, candle.low, candle.close].every(finite)
    && Number(candle.high) >= Math.max(Number(candle.open), Number(candle.close), Number(candle.low))
    && Number(candle.low) <= Math.min(Number(candle.open), Number(candle.close), Number(candle.high))
    && (candle.volume == null || finite(candle.volume));
}

function normalizeClosedSeries(candles, { interval, asOf }) {
  const asOfMs = Date.parse(iso(asOf) || ""); const byOpenTime = new Map(); let rejectedCandles = 0; let openCandles = 0; let duplicateCandles = 0;
  for (const candle of candles || []) {
    if (!validMarketCandle(candle, interval)) { rejectedCandles += 1; continue; }
    if (Date.parse(candle.closeTime) > asOfMs) { openCandles += 1; continue; }
    const key = `${candle.instrumentId}|${candle.openTime}|${adjustmentMode(candle)}`; const current = byOpenTime.get(key);
    if (current) duplicateCandles += 1;
    if (!current || Date.parse(candle.fetchedAt || 0) >= Date.parse(current.fetchedAt || 0)) byOpenTime.set(key, candle);
  }
  const values = [...byOpenTime.values()].sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime));
  return { values, rejectedCandles, openCandles, duplicateCandles };
}

function sessionDescriptor(candle, instrument) {
  if (instrument?.sessionPolicy === "24x7" || candle?.session === "24x7") return { kind: "24x7", id: "24x7", minute: null };
  const local = localParts(candle.openTime, instrument?.timezone);
  if (!local) return null;
  return { kind: "exchange", id: local.date, minute: local.hour * 60 + local.minute, second: local.second, eligible: ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(local.weekday) };
}

function isSessionCandle(candle, instrument) {
  const session = sessionDescriptor(candle, instrument);
  return session?.kind === "24x7" || Boolean(session?.eligible && session.minute >= EQUITY_SESSION_OPEN_MINUTE && session.minute < EQUITY_SESSION_CLOSE_MINUTE);
}

function gapBetween(previous, current, { interval, instrument }) {
  const expectedMs = candleIntervalMs(interval); if (!expectedMs) return null;
  const previousSession = sessionDescriptor(previous, instrument); const currentSession = sessionDescriptor(current, instrument);
  if (!previousSession || !currentSession) return { reason: "session_unresolved", after: previous.closeTime, before: current.openTime, missingCandles: null };
  if (previousSession.kind === "exchange" && (!previousSession.eligible || !currentSession.eligible || previousSession.id !== currentSession.id)) return null;
  const delta = Date.parse(current.openTime) - Date.parse(previous.openTime);
  if (delta <= expectedMs) return null;
  return { reason: "missing_candles", after: previous.closeTime, before: current.openTime, missingCandles: Math.max(1, Math.round(delta / expectedMs) - 1), session: currentSession.id };
}

export function detectCandleGaps(candles = [], { interval = "5min", instrument = null } = {}) {
  const gaps = [];
  for (let index = 1; index < candles.length; index += 1) {
    const gap = gapBetween(candles[index - 1], candles[index], { interval, instrument });
    if (gap) gaps.push(gap);
  }
  return gaps;
}

function bucketDescriptor(candle, { targetInterval, instrument }) {
  const openMs = Date.parse(candle.openTime); const targetMs = candleIntervalMs(targetInterval);
  const session = sessionDescriptor(candle, instrument);
  if (!session || !targetMs) return null;
  if (session.kind === "24x7") {
    const startMs = Math.floor(openMs / targetMs) * targetMs;
    return { key: `24x7:${startMs}`, startMs, expectedEndMs: startMs + targetMs, expectedMinutes: targetMs / 60_000, sessionId: "24x7", partialSessionBucket: false };
  }
  if (!session.eligible || session.minute < EQUITY_SESSION_OPEN_MINUTE || session.minute >= EQUITY_SESSION_CLOSE_MINUTE) return null;
  const targetMinutes = targetMs / 60_000; const offsetMinutes = session.minute - EQUITY_SESSION_OPEN_MINUTE; const bucketIndex = Math.floor(offsetMinutes / targetMinutes); const bucketStartMinute = EQUITY_SESSION_OPEN_MINUTE + bucketIndex * targetMinutes; const expectedMinutes = Math.min(targetMinutes, EQUITY_SESSION_CLOSE_MINUTE - bucketStartMinute); const minuteRemainder = session.minute - bucketStartMinute;
  const startMs = openMs - (minuteRemainder * 60 + (session.second || 0)) * 1_000 - new Date(candle.openTime).getUTCMilliseconds();
  return { key: `${session.id}:${bucketIndex}`, startMs, expectedEndMs: startMs + expectedMinutes * 60_000, expectedMinutes, sessionId: session.id, partialSessionBucket: expectedMinutes < targetMinutes };
}

function sameSeries(candles) {
  for (const field of ["instrumentId", "currency"]) if (new Set(candles.map((candle) => candle[field])).size > 1) return false;
  return new Set(candles.map(adjustmentMode)).size <= 1;
}

function buildDerivedCandle(candles, descriptor, { sourceInterval, targetInterval, instrument }) {
  const sources = [...new Set(candles.map((candle) => candle.source || candle.provenance?.provider || "unknown"))]; const providerSymbols = [...new Set(candles.map((candle) => candle.providerSymbol).filter(Boolean))]; const statuses = candles.map(candleStatus); const dataMode = worstStatus(statuses); const volumeValues = candles.map((candle) => candle.volume); const volume = volumeValues.every((value) => value == null) ? null : volumeValues.reduce((total, value) => total + (finite(value) ? Number(value) : 0), 0); const first = candles[0]; const last = candles.at(-1);
  return {
    schemaVersion: first.schemaVersion,
    instrumentId: first.instrumentId,
    interval: targetInterval,
    openTime: new Date(descriptor.startMs).toISOString(),
    closeTime: new Date(descriptor.expectedEndMs).toISOString(),
    open: Number(first.open),
    high: Math.max(...candles.map((candle) => Number(candle.high))),
    low: Math.min(...candles.map((candle) => Number(candle.low))),
    close: Number(last.close),
    volume,
    currency: first.currency,
    exchange: first.exchange || instrument?.exchange || null,
    session: instrument?.sessionPolicy || first.session || null,
    source: sources.length === 1 ? sources[0] : "mixed",
    providerSymbol: providerSymbols.length === 1 ? providerSymbols[0] : null,
    fetchedAt: candles.map((candle) => iso(candle.fetchedAt)).filter(Boolean).sort().at(-1) || null,
    adjusted: first.adjusted,
    dataMode,
    quality: dataMode === "observed" ? "derived-valid" : `derived-${dataMode}`,
    methodVersion: CANDLE_ROLLUP_METHOD_VERSION,
    provenance: {
      provider: sources.length === 1 ? sources[0] : "mixed",
      providers: sources,
      providerSymbol: providerSymbols.length === 1 ? providerSymbols[0] : null,
      adjustmentMode: adjustmentMode(first),
      derivedFrom: sourceInterval,
      methodVersion: CANDLE_ROLLUP_METHOD_VERSION,
      sourceCandleCount: candles.length,
      sourceOpenTimes: candles.map((candle) => candle.openTime),
      sessionPolicy: instrument?.sessionPolicy || first.session || null,
      sessionId: descriptor.sessionId,
      partialSessionBucket: descriptor.partialSessionBucket,
      gapDetected: false
    }
  };
}

export function aggregateClosedCandles(candles = [], { sourceInterval = "5min", targetInterval = "15min", instrument = null, asOf = new Date().toISOString() } = {}) {
  const ratio = SUPPORTED_ROLLUPS[`${sourceInterval}:${targetInterval}`];
  if (!ratio) throw new TypeError(`unsupported-candle-rollup:${sourceInterval}:${targetInterval}`);
  const asOfIso = iso(asOf); if (!asOfIso) throw new TypeError("invalid-candle-rollup-as-of");
  const normalized = normalizeClosedSeries(candles, { interval: sourceInterval, asOf: asOfIso }); const eligibleValues = normalized.values.filter((candle) => isSessionCandle(candle, instrument)); const outsideSessionCandles = normalized.values.length - eligibleValues.length; const baseGaps = detectCandleGaps(eligibleValues, { interval: sourceInterval, instrument }); const buckets = new Map();
  for (const candle of eligibleValues) {
    const descriptor = bucketDescriptor(candle, { targetInterval, instrument });
    if (!descriptor) continue;
    const current = buckets.get(descriptor.key) || { descriptor, candles: [] }; current.candles.push(candle); buckets.set(descriptor.key, current);
  }
  const derived = []; const incompleteBuckets = [];
  for (const { descriptor, candles: values } of buckets.values()) {
    values.sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime));
    const expectedCount = Math.round(descriptor.expectedMinutes / (candleIntervalMs(sourceInterval) / 60_000)); const expectedOpenTimes = Array.from({ length: expectedCount }, (_, index) => descriptor.startMs + index * candleIntervalMs(sourceInterval)); const actualOpenTimes = new Set(values.map((candle) => Date.parse(candle.openTime))); const missingOpenTimes = expectedOpenTimes.filter((timestamp) => !actualOpenTimes.has(timestamp)); const fullyClosed = descriptor.expectedEndMs <= Date.parse(asOfIso); const compatible = sameSeries(values);
    if (!fullyClosed || values.length !== expectedCount || missingOpenTimes.length || !compatible) {
      incompleteBuckets.push({
        openTime: new Date(descriptor.startMs).toISOString(),
        closeTime: new Date(descriptor.expectedEndMs).toISOString(),
        expectedCandles: expectedCount,
        observedCandles: values.length,
        missingOpenTimes: missingOpenTimes.map((timestamp) => new Date(timestamp).toISOString()),
        reason: !fullyClosed ? "bucket_open" : !compatible ? "incompatible_series" : "missing_candles",
        session: descriptor.sessionId
      });
      continue;
    }
    derived.push(buildDerivedCandle(values, descriptor, { sourceInterval, targetInterval, instrument }));
  }
  derived.sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime)); const gaps = [...baseGaps, ...incompleteBuckets.filter((bucket) => bucket.reason !== "bucket_open").map((bucket) => ({ reason: bucket.reason, after: bucket.openTime, before: bucket.closeTime, missingCandles: Math.max(0, bucket.expectedCandles - bucket.observedCandles), session: bucket.session }))]; const dataStatus = eligibleValues.length ? worstStatus(eligibleValues.map(candleStatus)) : "insufficient_data"; const status = !derived.length ? "insufficient_data" : gaps.length || normalized.rejectedCandles || outsideSessionCandles ? dataStatus === "observed" ? "partial" : dataStatus : dataStatus;
  return {
    methodVersion: CANDLE_ROLLUP_METHOD_VERSION,
    sourceInterval,
    targetInterval,
    asOf: asOfIso,
    candles: derived,
    gaps,
    incompleteBuckets,
    quality: {
      status,
      gapDetected: gaps.length > 0,
      inputCandles: (candles || []).length,
      closedCandles: normalized.values.length,
      outputCandles: derived.length,
      openCandles: normalized.openCandles,
      rejectedCandles: normalized.rejectedCandles,
      duplicateCandles: normalized.duplicateCandles,
      outsideSessionCandles,
      sessionPolicy: instrument?.sessionPolicy || normalized.values[0]?.session || null,
      sessionCalendar: instrument?.sessionPolicy === "24x7" ? "continuous_utc" : "weekday_exchange_hours_approximation",
      limitations: instrument?.sessionPolicy === "24x7" ? [] : ["Exchange holidays and early closes require an explicit calendar."]
    }
  };
}

export function buildMarketConditionSeries(baseCandles = [], { windowMin = 240, instrument = null, asOf = new Date().toISOString() } = {}) {
  const selectedInterval = MARKET_CONDITION_INTERVALS[Number(windowMin)];
  if (!selectedInterval) throw new TypeError(`unsupported-market-condition-window:${windowMin}`);
  const asOfIso = iso(asOf); if (!asOfIso) throw new TypeError("invalid-market-condition-series-as-of");
  const normalized = normalizeClosedSeries(baseCandles, { interval: "5min", asOf: asOfIso }); const eligibleValues = normalized.values.filter((candle) => isSessionCandle(candle, instrument)); const outsideSessionCandles = normalized.values.length - eligibleValues.length; const baseGaps = detectCandleGaps(eligibleValues, { interval: "5min", instrument });
  if (selectedInterval === "5min") {
    const dataStatus = eligibleValues.length ? worstStatus(eligibleValues.map(candleStatus)) : "insufficient_data"; const status = eligibleValues.length && (baseGaps.length || normalized.rejectedCandles || outsideSessionCandles) && dataStatus === "observed" ? "partial" : dataStatus;
    return { methodVersion: CANDLE_ROLLUP_METHOD_VERSION, windowMin: Number(windowMin), interval: "5min", candles: eligibleValues, gaps: baseGaps, quality: { status, gapDetected: baseGaps.length > 0, inputCandles: baseCandles.length, closedCandles: normalized.values.length, outputCandles: eligibleValues.length, openCandles: normalized.openCandles, rejectedCandles: normalized.rejectedCandles, duplicateCandles: normalized.duplicateCandles, outsideSessionCandles, sessionPolicy: instrument?.sessionPolicy || normalized.values[0]?.session || null, sessionCalendar: instrument?.sessionPolicy === "24x7" ? "continuous_utc" : "weekday_exchange_hours_approximation", limitations: instrument?.sessionPolicy === "24x7" ? [] : ["Exchange holidays and early closes require an explicit calendar."] } };
  }
  const fifteenMinute = aggregateClosedCandles(eligibleValues, { sourceInterval: "5min", targetInterval: "15min", instrument, asOf: asOfIso });
  const baseInputQuality = { inputCandles: baseCandles.length, baseClosedCandles: eligibleValues.length, openCandles: normalized.openCandles, rejectedCandles: normalized.rejectedCandles, duplicateCandles: normalized.duplicateCandles, outsideSessionCandles }; const fifteenStatus = outsideSessionCandles && fifteenMinute.quality.status === "observed" ? "partial" : fifteenMinute.quality.status;
  if (selectedInterval === "15min") return { ...fifteenMinute, windowMin: Number(windowMin), interval: "15min", quality: { ...fifteenMinute.quality, ...baseInputQuality, status: fifteenStatus } };
  const hourly = aggregateClosedCandles(fifteenMinute.candles, { sourceInterval: "15min", targetInterval: "1h", instrument, asOf: asOfIso }); const inheritedGaps = [...fifteenMinute.gaps, ...hourly.gaps]; const inheritedStatus = worstStatus([fifteenMinute.quality.status, hourly.quality.status]);
  return { ...hourly, windowMin: Number(windowMin), interval: "1h", gaps: inheritedGaps, quality: { ...hourly.quality, ...baseInputQuality, status: outsideSessionCandles && inheritedStatus === "observed" ? "partial" : inheritedStatus, gapDetected: inheritedGaps.length > 0, fifteenMinuteCandles: fifteenMinute.candles.length } };
}
