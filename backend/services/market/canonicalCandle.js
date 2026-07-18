import { getInstrumentById } from "./instrumentRegistry.js";

export const CANDLE_SCHEMA_VERSION = 1;
export const DAILY_CANDLE_METHOD_VERSION = "daily-candle-v1";
export const INTRADAY_CANDLE_METHOD_VERSION = "intraday-candle-v1";
export const SUPPORTED_CANDLE_INTERVALS = Object.freeze(["5min", "15min", "30min", "1h", "1day"]);
const INTERVAL_MS = Object.freeze({ "5min": 300_000, "15min": 900_000, "30min": 1_800_000, "1h": 3_600_000, "1day": 86_400_000 });

function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function safeIso(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }

function zonedDateTimeToUtc(dateText, timeText, timeZone) {
  const [year, month, day] = String(dateText).split("-").map(Number);
  const [hour, minute, second = 0] = String(timeText).split(":").map(Number);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
  let candidate = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    candidate += Date.UTC(year, month - 1, day, hour, minute, second) - represented;
  }
  return new Date(candidate).toISOString();
}

function addUtcDays(iso, days) { const date = new Date(iso); date.setUTCDate(date.getUTCDate() + days); return date.toISOString(); }

export function resolveDailyCandleTimes(dateText, instrument) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ""))) return null;
  if (instrument?.sessionPolicy === "24x7") {
    const openTime = `${dateText}T00:00:00.000Z`;
    return { openTime, closeTime: addUtcDays(openTime, 1), session: "24x7" };
  }
  const openTime = zonedDateTimeToUtc(dateText, "09:30:00", instrument.timezone);
  const closeTime = zonedDateTimeToUtc(dateText, "16:00:00", instrument.timezone);
  return openTime && closeTime ? { openTime, closeTime, session: instrument.sessionPolicy } : null;
}

export function candleIntervalMs(interval) { return INTERVAL_MS[interval] || null; }

export function resolveIntradayCandleTimes(datetime, interval, instrument) {
  const match = String(datetime || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  const durationMs = candleIntervalMs(interval); if (!match || !durationMs || interval === "1day") return null;
  const openTime = instrument?.sessionPolicy === "24x7" ? safeIso(`${match[1]}T${match[2]}:${match[3] || "00"}Z`) : zonedDateTimeToUtc(match[1], `${match[2]}:${match[3] || "00"}`, instrument.timezone);
  if (!openTime) return null; return { openTime, closeTime: new Date(Date.parse(openTime) + durationMs).toISOString(), session: instrument.sessionPolicy };
}

export function normalizeCanonicalCandle(raw = {}, { instrument = getInstrumentById(raw.instrumentId), fetchedAt = new Date().toISOString(), source = raw.source, providerSymbol = raw.providerSymbol, adjustmentMode = raw.provenance?.adjustmentMode || "splits" } = {}) {
  const errors = [];
  if (!instrument || instrument.verificationStatus !== "verified") errors.push("instrument-not-verified");
  if (!raw.instrumentId) errors.push("instrument-id-missing");
  if (!SUPPORTED_CANDLE_INTERVALS.includes(raw.interval)) errors.push("interval-invalid");
  const times = raw.openTime && raw.closeTime ? { openTime: safeIso(raw.openTime), closeTime: safeIso(raw.closeTime), session: raw.session } : instrument ? raw.interval === "1day" ? resolveDailyCandleTimes(raw.date || String(raw.datetime || "").slice(0, 10), instrument) : resolveIntradayCandleTimes(raw.datetime, raw.interval, instrument) : null;
  if (!times || !Number.isFinite(new Date(times.openTime).getTime()) || !Number.isFinite(new Date(times.closeTime).getTime())) errors.push("timestamp-invalid");
  const open = finite(raw.open); const high = finite(raw.high); const low = finite(raw.low); const close = finite(raw.close); const volume = raw.volume == null || raw.volume === "" ? null : finite(raw.volume);
  if ([open, high, low, close].some((value) => value == null) || (raw.volume != null && raw.volume !== "" && volume == null)) errors.push("values-not-finite");
  if (high != null && [open, close, low].some((value) => value != null && high < value)) errors.push("high-invalid");
  if (low != null && [open, close, high].some((value) => value != null && low > value)) errors.push("low-invalid");
  const currency = raw.currency || instrument?.currency || null;
  if (instrument && currency !== instrument.currency) errors.push("currency-mismatch");
  if (errors.length) return { valid: false, errors: [...new Set(errors)], candle: null };
  const adjusted = adjustmentMode !== "none";
  return { valid: true, errors: [], candle: { schemaVersion: CANDLE_SCHEMA_VERSION, instrumentId: instrument.instrumentId, interval: raw.interval, openTime: times.openTime, closeTime: times.closeTime, open, high, low, close, volume, currency, exchange: instrument.exchange, session: times.session || instrument.sessionPolicy, source: source || "unknown", providerSymbol: providerSymbol || null, fetchedAt, adjusted, dataMode: raw.dataMode || "observed", quality: raw.quality || "valid", methodVersion: raw.interval === "1day" ? DAILY_CANDLE_METHOD_VERSION : INTRADAY_CANDLE_METHOD_VERSION, provenance: { provider: source || "unknown", providerSymbol: providerSymbol || null, adjustmentMode, providerDatetime: raw.datetime || raw.date || null, fetchedAt } } };
}

export function candleIdentity(candle) { return `${candle.instrumentId}|${candle.interval}|${candle.openTime}`; }
export function candleSeriesKey({ instrumentId, interval = "1day", adjustmentMode = "splits" }) { return `${instrumentId}|${interval}|${adjustmentMode}`; }
