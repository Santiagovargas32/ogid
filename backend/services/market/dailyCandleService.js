import { fetchDailyCandles } from "./marketProviderRouter.js";
import { getInstrumentById, resolveVerifiedInstrumentReferences } from "./instrumentRegistry.js";
import { resolveDailyCandleTimes } from "./canonicalCandle.js";

function dateInZone(now, timeZone) { const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now).map((part) => [part.type, part.value])); return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) }; }
function previousUtcDate(now) { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10); }
function previousWeekday(dateText) { const date = new Date(`${dateText}T12:00:00Z`); do { date.setUTCDate(date.getUTCDate() - 1); } while ([0, 6].includes(date.getUTCDay())); return date.toISOString().slice(0, 10); }

export function resolveExpectedClosedDailyCandle(instrument, now = new Date(), { equityDelayMinutes = 15, cryptoCloseDelayMinutes = 5 } = {}) {
  if (instrument.sessionPolicy === "24x7") {
    if (now.getUTCHours() * 60 + now.getUTCMinutes() < cryptoCloseDelayMinutes) return null;
    return resolveDailyCandleTimes(previousUtcDate(now), instrument);
  }
  const local = dateInZone(now, instrument.timezone); let date = local.date;
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(local.weekday) || local.minutes < 16 * 60 + equityDelayMinutes) date = previousWeekday(date);
  return resolveDailyCandleTimes(date, instrument);
}

export class DailyCandleService {
  constructor({ store, marketConfig = {}, now = () => new Date() } = {}) { this.store = store; this.marketConfig = marketConfig; this.now = now; this.inFlight = null; this.attemptedExpected = new Set(); }
  enabledInstruments() { return this.marketConfig.watchlistService?.selectedInstruments?.() || resolveVerifiedInstrumentReferences(this.marketConfig.tickers || []).instruments; }
  async runScheduled() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#runScheduled(); try { return await this.inFlight; } finally { this.inFlight = null; }
  }
  async #runScheduled() {
    if (this.store?.enabled === false) return { status: "disabled", requested: 0, inserted: 0, stale: [] };
    const now = this.now(); const adjustmentMode = this.marketConfig.dailyCandles?.adjustmentMode || "splits"; const due = this.enabledInstruments().filter((instrument) => { const expected = resolveExpectedClosedDailyCandle(instrument, now, this.marketConfig.dailyCandles); const attemptKey = expected ? `${instrument.instrumentId}|${expected.openTime}|${adjustmentMode}` : null; return expected && !this.attemptedExpected.has(attemptKey) && !this.store.has(instrument.instrumentId, expected.openTime, adjustmentMode); });
    if (!due.length) return { status: "up-to-date", requested: 0, inserted: 0, stale: [] };
    const result = await fetchDailyCandles({ ...this.marketConfig, instrumentIds: due.map((instrument) => instrument.instrumentId), outputsize: 2, adjustmentMode: this.marketConfig.dailyCandles?.adjustmentMode || "splits", trigger: "scheduled-daily-candles", timestamp: now.toISOString() });
    if (!result.creditRejections.length) for (const instrument of due) { const expected = resolveExpectedClosedDailyCandle(instrument, now, this.marketConfig.dailyCandles); if (expected) this.attemptedExpected.add(`${instrument.instrumentId}|${expected.openTime}|${adjustmentMode}`); }
    const persistence = result.persistedByProvider ? result.persistence : await this.store.append(result.candles, { now });
    return { status: result.creditRejections.length ? "postponed-quota" : result.errors.length ? "partial" : "ok", requested: due.length, ...persistence, errors: result.errors, creditRejections: result.creditRejections, stale: due.map((instrument) => this.store.latest(instrument.instrumentId)).filter(Boolean).map((candle) => ({ ...candle, dataMode: "stale", quality: "stale-if-error", provenance: { ...candle.provenance, stale: true } })) };
  }
  async backfill({ instrumentIds = [], days = 30, adjustmentMode = null } = {}) {
    if (this.store?.enabled === false) return { requested: 0, days: 0, inserted: 0, errors: [{ code: "daily-candles-disabled" }], creditRejections: [] };
    const maxDays = this.marketConfig.dailyCandles?.backfillMaxDays || 30; const boundedDays = Math.min(maxDays, Math.max(1, Number(days) || 1));
    const allowed = new Set(this.enabledInstruments().map((instrument) => instrument.instrumentId)); const resolved = [...new Set(instrumentIds)].map(getInstrumentById).filter((instrument) => instrument?.verificationStatus === "verified" && allowed.has(instrument.instrumentId));
    const now = this.now(); const result = await fetchDailyCandles({ ...this.marketConfig, instrumentIds: resolved.map((instrument) => instrument.instrumentId), outputsize: boundedDays + 2, adjustmentMode: adjustmentMode || this.marketConfig.dailyCandles?.adjustmentMode || "splits", trigger: "daily-backfill", timestamp: now.toISOString() });
    const persistence = result.persistedByProvider ? result.persistence : await this.store.append(result.candles, { now }); return { requested: resolved.length, days: boundedDays, ...persistence, errors: result.errors, creditRejections: result.creditRejections };
  }
  query(options) { return this.store.query(options); }
}
