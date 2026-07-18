import { CANDLE_SCHEMA_VERSION, normalizeCanonicalCandle } from "../market/canonicalCandle.js";
import { DailyCandleStore } from "../market/dailyCandleStore.js";
import { getInstrumentByProviderSymbol } from "../market/instrumentRegistry.js";
import { normalizeYahooInstrument, normalizeYahooSymbol } from "./normalizer.js";

const CANONICAL_INTERVAL = Object.freeze({ "1d": "1day", "1h": "1h", "30m": "30min", "15m": "15min", "5m": "5min", "1wk": "1wk", "1mo": "1mo" });

function instant(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function closeTime(timestamp, interval) {
  const value = new Date(timestamp);
  if (interval === "5m") value.setUTCMinutes(value.getUTCMinutes() + 5);
  else if (interval === "15m") value.setUTCMinutes(value.getUTCMinutes() + 15);
  else if (interval === "30m") value.setUTCMinutes(value.getUTCMinutes() + 30);
  else if (interval === "1h") value.setUTCHours(value.getUTCHours() + 1);
  else if (interval === "1d") value.setUTCDate(value.getUTCDate() + 1);
  else if (interval === "1wk") value.setUTCDate(value.getUTCDate() + 7);
  else value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString();
}

function dynamicInstrument(symbol) {
  const known = getInstrumentByProviderSymbol("yahoo", symbol);
  if (known) return known;
  return normalizeYahooInstrument({ symbol, assetType: "unknown", timezone: "UTC" });
}

function equivalentBar(left, right) {
  return left.open === right.open && left.high === right.high && left.low === right.low
    && left.close === right.close && left.volume === right.volume && left.source === right.source;
}

export class MarketDataStoreAdapter {
  constructor({ candleStore = null, now = () => new Date(), maxCacheEntries = 256 } = {}) {
    this.candleStore = candleStore || new DailyCandleStore({ intervals: ["1day", "1h", "30min", "15min", "5min", "1wk", "1mo"] });
    this.now = now;
    this.maxCacheEntries = Math.max(1, Number(maxCacheEntries) || 256);
    this.cache = new Map();
    this.writeChains = new Map();
  }

  hydrate() {
    return this.candleStore.hydrate();
  }

  cacheKey(symbol, interval, period, range = null) {
    const absoluteWindow = range?.explicit
      ? `|${instant(range.period1).toISOString()}|${instant(range.period2).toISOString()}`
      : "|rolling";
    return `${normalizeYahooSymbol(symbol)}|${interval}|${period}${absoluteWindow}`;
  }

  async upsertBars(bars = [], { symbol, period = "1y", interval = "1d", ttlMs, range = null, complete = true } = {}) {
    const normalizedSymbol = normalizeYahooSymbol(symbol || bars[0]?.symbol);
    const key = this.cacheKey(normalizedSymbol, interval, period, range);
    const priorWrite = this.writeChains.get(key) || Promise.resolve();
    let releaseWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const tail = priorWrite.then(() => gate, () => gate);
    this.writeChains.set(key, tail);
    await priorWrite.catch(() => undefined);

    try {
      const previous = this.#cachedEntry(key);
      const byTimestamp = new Map((previous?.bars || []).map((bar) => [bar.timestamp, bar]));
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      for (const bar of bars) {
        if (bar?.symbol !== normalizedSymbol || bar?.source !== "yahoo") continue;
        const existing = byTimestamp.get(bar.timestamp);
        if (!existing) inserted += 1;
        else if (equivalentBar(existing, bar)) unchanged += 1;
        else updated += 1;
        byTimestamp.set(bar.timestamp, bar);
      }
      const refreshedAt = instant(this.now()).toISOString();
      const merged = [...byTimestamp.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
      const boundedTtl = Math.max(1, Number(ttlMs) || 1);
      const storedAt = complete ? refreshedAt : previous?.storedAt || refreshedAt;
      const nextEntry = {
        bars: merged,
        storedAt,
        expiresAt: complete
          ? new Date(Date.parse(refreshedAt) + boundedTtl).toISOString()
          : previous?.expiresAt || refreshedAt,
        from: merged[0]?.timestamp || previous?.from || null,
        to: merged.at(-1)?.timestamp || previous?.to || null,
      };

      const incomingTimestamps = new Set(bars.map((bar) => bar?.timestamp).filter(Boolean));
      const candles = merged.filter((bar) => incomingTimestamps.has(bar.timestamp)).map((bar) => this.toCanonicalCandle(bar, interval)).filter(Boolean);
      const persistence = typeof this.candleStore.upsert === "function"
        ? await this.candleStore.upsert(candles, { now: instant(this.now()) })
        : await this.candleStore.append(candles, { now: instant(this.now()) });
      const relatedPrefix = `${normalizedSymbol}|${interval}|`;
      for (const cachedKey of this.cache.keys()) if (cachedKey.startsWith(relatedPrefix)) this.cache.delete(cachedKey);
      this.#setCachedEntry(key, nextEntry);
      return { inserted, updated, unchanged, persistence, bars: merged };
    } finally {
      releaseWrite();
      if (this.writeChains.get(key) === tail) this.writeChains.delete(key);
    }
  }

  getBars({ symbol, period = "1y", interval = "1d", from = null, to = null, ttlMs = 1, limit = 10_000, range = null } = {}) {
    const normalizedSymbol = normalizeYahooSymbol(symbol);
    const key = this.cacheKey(normalizedSymbol, interval, period, range);
    let entry = this.#cachedEntry(key);
    if (!entry) {
      const instrument = dynamicInstrument(normalizedSymbol);
      const records = this.candleStore.query({
        instrumentId: instrument.instrumentId,
        interval: CANONICAL_INTERVAL[interval] || interval,
        adjustmentMode: "splits",
        from,
        to,
        limit,
      });
      if (records.length > 0) {
        const bars = records.map((record) => this.fromCanonicalCandle(record, normalizedSymbol));
        const storedAt = records.map((record) => record.fetchedAt).filter(Boolean).sort().at(-1) || bars.at(-1).timestamp;
        entry = { bars, storedAt, expiresAt: new Date(Date.parse(storedAt) + Math.max(1, Number(ttlMs) || 1)).toISOString(), from: bars[0]?.timestamp || null, to: bars.at(-1)?.timestamp || null };
        this.#setCachedEntry(key, entry);
      }
    }
    if (!entry) return { bars: [], cached: false, stale: true, storedAt: null, from: null, to: null };
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const bars = entry.bars.filter((bar) => Date.parse(bar.timestamp) >= fromMs && Date.parse(bar.timestamp) <= toMs).slice(-Math.max(1, Number(limit) || 10_000));
    return {
      bars,
      cached: true,
      stale: Date.parse(entry.expiresAt) <= instant(this.now()).getTime(),
      storedAt: entry.storedAt,
      from: bars[0]?.timestamp || null,
      to: bars.at(-1)?.timestamp || null,
    };
  }

  toCanonicalCandle(bar, interval) {
    const instrument = dynamicInstrument(bar.symbol);
    const canonicalInterval = CANONICAL_INTERVAL[interval] || interval;
    const isDaily = canonicalInterval === "1day";
    const raw = {
      instrumentId: instrument.instrumentId,
      interval: canonicalInterval,
      ...(isDaily
        ? { date: String(bar.timestamp).slice(0, 10), datetime: bar.timestamp }
        : { openTime: bar.timestamp, closeTime: closeTime(bar.timestamp, interval) }),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      source: "yahoo",
      providerSymbol: bar.symbol,
      dataMode: "observed",
      session: instrument.sessionPolicy,
    };
    if (["1day", "1h", "30min", "15min", "5min"].includes(canonicalInterval)) {
      return normalizeCanonicalCandle(raw, {
        instrument,
        fetchedAt: instant(this.now()).toISOString(),
        source: "yahoo",
        providerSymbol: bar.symbol,
        adjustmentMode: "splits",
      }).candle;
    }
    return {
      schemaVersion: CANDLE_SCHEMA_VERSION,
      ...raw,
      currency: instrument.currency || null,
      exchange: instrument.exchange || null,
      fetchedAt: instant(this.now()).toISOString(),
      adjusted: true,
      quality: "valid",
      methodVersion: "market-data-chart-v1",
      provenance: { provider: "yahoo", providerSymbol: bar.symbol, adjustmentMode: "splits", fetchedAt: instant(this.now()).toISOString() },
    };
  }

  fromCanonicalCandle(candle, symbol = candle.providerSymbol) {
    const providerTimestamp = candle.provenance?.providerDatetime;
    const timestamp = instant(providerTimestamp || candle.openTime).toISOString();
    return {
      symbol: normalizeYahooSymbol(symbol),
      source: "yahoo",
      timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };
  }

  #cachedEntry(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  #setCachedEntry(key, entry) {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
  }
}
