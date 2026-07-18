import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { candleIdentity, candleSeriesKey, CANDLE_SCHEMA_VERSION } from "./canonicalCandle.js";
import { listEnabledInstruments } from "./instrumentRegistry.js";
import { sanitizeSensitiveData } from "../../utils/sanitize.js";

function safe(value) { return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_"); }
function parse(line) { try { return JSON.parse(line); } catch { return null; } }
function sameMarketValues(left, right) { return ["open", "high", "low", "close", "volume", "source", "providerSymbol", "dataMode"].every((field) => left?.[field] === right?.[field]); }

export class DailyCandleStore {
  constructor({ enabled = true, rootDir, retentionDays = 3650, rolloutBatch = 1, intervals = ["1day"] } = {}) { this.enabled = enabled !== false; this.rootDir = path.resolve(rootDir || path.resolve(process.cwd(), "data/market")); this.candleDir = path.join(this.rootDir, "candles"); this.retentionDays = Math.max(30, Number(retentionDays) || 3650); this.rolloutBatch = rolloutBatch; this.intervals = [...new Set(["1day", ...intervals])]; this.series = new Map(); this.identities = new Set(); this.hydratedSeries = new Set(); this.writeChain = Promise.resolve(); }
  seriesPath(instrumentId, interval = "1day", adjustmentMode = "splits") { return path.join(this.candleDir, safe(instrumentId), safe(interval), `${safe(adjustmentMode)}.jsonl`); }
  hydrate() {
    return this.#enqueueWrite(() => this.#hydrate());
  }
  async #hydrate() {
    if (!this.enabled) return 0; let count = 0;
    for (const instrument of listEnabledInstruments(this.rolloutBatch)) for (const interval of this.intervals) for (const adjustmentMode of ["splits", "none"]) {
      const key = candleSeriesKey({ instrumentId: instrument.instrumentId, interval, adjustmentMode });
      try { const text = await readFile(this.seriesPath(instrument.instrumentId, interval, adjustmentMode), "utf8"); count += this.#hydrateSeriesText(key, text, instrument.instrumentId, interval, adjustmentMode); } catch (error) { if (error?.code !== "ENOENT") throw error; } finally { this.hydratedSeries.add(key); }
    }
    return count;
  }
  has(instrumentId, openTime, adjustmentMode = "splits") { return this.identities.has(`${instrumentId}|1day|${openTime}|${adjustmentMode}`); }
  hasCandle(instrumentId, interval, openTime, adjustmentMode = "splits") { return this.identities.has(`${instrumentId}|${interval}|${openTime}|${adjustmentMode}`); }
  append(candles = [], options = {}) {
    return this.#enqueueWrite(() => this.#append(candles, options));
  }
  async #append(candles = [], { now = new Date() } = {}) {
    if (!this.enabled) return { inserted: 0, duplicates: candles.length, rejectedOpen: 0 }; let inserted = 0; let duplicates = 0; let rejectedOpen = 0;
    for (const candle of candles) {
      const adjustmentMode = candle.provenance?.adjustmentMode || (candle.adjusted ? "splits" : "none"); const identity = `${candleIdentity(candle)}|${adjustmentMode}`;
      if (new Date(candle.closeTime).getTime() > now.getTime()) { rejectedOpen += 1; continue; }
      this.#ensureSeriesHydrated(candle.instrumentId, candle.interval, adjustmentMode);
      if (this.identities.has(identity)) { duplicates += 1; continue; }
      const target = this.seriesPath(candle.instrumentId, candle.interval, adjustmentMode); await mkdir(path.dirname(target), { recursive: true }); await appendFile(target, `${JSON.stringify(sanitizeSensitiveData(candle))}\n`, "utf8");
      const key = candleSeriesKey({ instrumentId: candle.instrumentId, interval: candle.interval, adjustmentMode }); const values = this.series.get(key) || []; values.push(candle); values.sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime)); this.series.set(key, values); this.identities.add(identity); inserted += 1;
    }
    return { inserted, duplicates, rejectedOpen };
  }
  upsert(candles = [], options = {}) {
    return this.#enqueueWrite(() => this.#upsert(candles, options));
  }
  async #upsert(candles = [], { now = new Date() } = {}) {
    if (!this.enabled) return { inserted: 0, updated: 0, duplicates: candles.length, rejectedOpen: 0 };
    let inserted = 0; let updated = 0; let duplicates = 0; let rejectedOpen = 0;
    const dirtySeries = new Map();
    for (const candle of candles) {
      const adjustmentMode = candle.provenance?.adjustmentMode || (candle.adjusted ? "splits" : "none");
      if (new Date(candle.closeTime).getTime() > now.getTime()) { rejectedOpen += 1; continue; }
      const key = candleSeriesKey({ instrumentId: candle.instrumentId, interval: candle.interval, adjustmentMode });
      this.#ensureSeriesHydrated(candle.instrumentId, candle.interval, adjustmentMode);
      const identity = `${candleIdentity(candle)}|${adjustmentMode}`;
      const values = dirtySeries.get(key)?.values || [...(this.series.get(key) || [])];
      const index = values.findIndex((item) => candleIdentity(item) === candleIdentity(candle));
      if (index < 0) { values.push(candle); inserted += 1; }
      else if (sameMarketValues(values[index], candle)) { duplicates += 1; }
      else { values[index] = candle; updated += 1; }
      values.sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
      dirtySeries.set(key, { values, candle, adjustmentMode });
      this.identities.add(identity);
    }
    for (const [key, entry] of dirtySeries) {
      const target = this.seriesPath(entry.candle.instrumentId, entry.candle.interval, entry.adjustmentMode);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      const payload = entry.values.map((candle) => JSON.stringify(sanitizeSensitiveData(candle))).join("\n");
      await writeFile(temporary, payload ? `${payload}\n` : "", "utf8");
      await rename(temporary, target);
      this.series.set(key, entry.values);
    }
    return { inserted, updated, duplicates, rejectedOpen };
  }
  query({ instrumentId, interval = "1day", adjustmentMode = "splits", from = null, to = null, limit = 100 } = {}) { const key = this.#ensureSeriesHydrated(instrumentId, interval, adjustmentMode); const fromMs = from ? Date.parse(from) : -Infinity; const toMs = to ? Date.parse(to) : Infinity; return (this.series.get(key) || []).filter((candle) => Date.parse(candle.openTime) >= fromMs && Date.parse(candle.openTime) <= toMs).slice(-Math.min(10_000, Math.max(1, Number(limit) || 100))); }
  latest(instrumentId, adjustmentMode = "splits", interval = "1day") { return this.query({ instrumentId, interval, adjustmentMode, limit: 1 }).at(-1) || null; }
  #enqueueWrite(operation) { const pending = this.writeChain.then(operation, operation); this.writeChain = pending.catch(() => {}); return pending; }
  #ensureSeriesHydrated(instrumentId, interval, adjustmentMode) { const key = candleSeriesKey({ instrumentId, interval, adjustmentMode }); if (!this.enabled || this.hydratedSeries.has(key)) return key; try { const text = readFileSync(this.seriesPath(instrumentId, interval, adjustmentMode), "utf8"); this.#hydrateSeriesText(key, text, instrumentId, interval, adjustmentMode); } catch (error) { if (error?.code !== "ENOENT") throw error; } finally { this.hydratedSeries.add(key); } return key; }
  #hydrateSeriesText(key, text, instrumentId, interval, adjustmentMode) { const cutoff = Date.now() - this.retentionDays * 86_400_000; const byIdentity = new Map(); for (const item of text.split(/\r?\n/).map(parse)) { if (item?.schemaVersion === CANDLE_SCHEMA_VERSION && item.instrumentId === instrumentId && item.interval === interval) byIdentity.set(candleIdentity(item), item); } const recognized = [...byIdentity.values()].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime)); for (const candle of recognized) this.identities.add(`${candleIdentity(candle)}|${adjustmentMode}`); const records = recognized.filter((candle) => Date.parse(candle.openTime) >= cutoff); this.series.set(key, records); return records.length; }
}
