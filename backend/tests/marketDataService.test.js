import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DailyCandleStore } from "../services/market/dailyCandleStore.js";
import { MarketDataService } from "../services/marketData/marketDataService.js";
import { MarketDataStoreAdapter } from "../services/marketData/marketDataStore.js";

function chartBar({ date = "2026-07-14T00:00:00Z", close = 105, volume = 1_000 } = {}) {
  return { date: new Date(date), open: 100, high: Math.max(110, close), low: 90, close, volume };
}

function completeMonthBars(close = 105) {
  const bars = [];
  for (let timestamp = Date.parse("2026-06-17T00:00:00Z"); timestamp <= Date.parse("2026-07-14T00:00:00Z"); timestamp += 86_400_000) {
    const day = new Date(timestamp).getUTCDay();
    if (day !== 0 && day !== 6) bars.push(chartBar({ date: new Date(timestamp).toISOString(), close }));
  }
  return bars;
}

function completeDailyRange(period1, period2) {
  const bars = [];
  for (let timestamp = period1.getTime(); timestamp < period2.getTime(); timestamp += 86_400_000) {
    const day = new Date(timestamp).getUTCDay();
    if (day !== 0 && day !== 6) bars.push(chartBar({ date: new Date(timestamp).toISOString() }));
  }
  return bars;
}

async function createStore(now) {
  const rootDir = mkdtempSync(join(tmpdir(), "market-data-"));
  const candleStore = new DailyCandleStore({ rootDir, intervals: ["1day", "1h", "1wk", "1mo"] });
  await candleStore.hydrate();
  return { rootDir, adapter: new MarketDataStoreAdapter({ candleStore, now }) };
}

test("MarketDataService fetches Yahoo bars, caches them and upserts revisions in memory", async () => {
  let nowMs = Date.parse("2026-07-16T12:00:00Z");
  let close = 105;
  let calls = 0;
  const yahooClient = { chart: async () => { calls += 1; return { quotes: completeMonthBars(close) }; } };
  const { adapter } = await createStore(() => new Date(nowMs));
  const service = new MarketDataService({ yahooClient, store: adapter, now: () => new Date(nowMs), ttlByInterval: { "1d": 60_000 } });

  const first = await service.fetchYahooBars("gd", { period: "1mo", interval: "1d" });
  assert.equal(first.cached, false);
  assert.equal(first.stale, false);
  assert.deepEqual(first.bars.at(-1), { symbol: "GD", source: "yahoo", timestamp: "2026-07-14T00:00:00.000Z", open: 100, high: 110, low: 90, close: 105, volume: 1_000 });
  assert.equal(first.complete, true);
  const cached = await service.fetchYahooBars("GD", { period: "1mo", interval: "1d" });
  assert.equal(cached.cached, true);
  assert.equal(calls, 1);

  close = 107;
  const revised = await service.fetchYahooBars("GD", { period: "1mo", interval: "1d", force: true });
  assert.equal(revised.bars.length, completeMonthBars().length);
  assert.equal(revised.bars.at(-1).close, 107);
  assert.equal(calls, 2);
  assert.equal(adapter.getBars({ symbol: "GD", period: "1mo", interval: "1d", ttlMs: 60_000 }).bars.at(-1).close, 107);
  nowMs += 1;
});

test("stored Yahoo bars survive through the DailyCandleStore adapter", async () => {
  const now = () => new Date("2026-07-16T12:00:00Z");
  const { rootDir, adapter } = await createStore(now);
  await adapter.upsertBars([
    { symbol: "GD", source: "yahoo", timestamp: "2026-07-14T00:00:00.000Z", open: 100, high: 110, low: 90, close: 105, volume: 1_000 },
  ], { symbol: "GD", period: "1mo", interval: "1d", ttlMs: 60_000 });
  await adapter.upsertBars([
    { symbol: "GD", source: "yahoo", timestamp: "2026-07-14T00:00:00.000Z", open: 100, high: 112, low: 90, close: 107, volume: 1_100 },
  ], { symbol: "GD", period: "1mo", interval: "1d", ttlMs: 60_000 });

  const restartedStore = new DailyCandleStore({ rootDir, intervals: ["1day", "1h", "1wk", "1mo"] });
  await restartedStore.hydrate();
  const restarted = new MarketDataStoreAdapter({ candleStore: restartedStore, now });
  const result = restarted.getBars({ symbol: "GD", period: "1mo", interval: "1d", ttlMs: 60_000 });
  assert.equal(result.bars.length, 1);
  assert.equal(result.bars[0].close, 107);
  assert.equal(result.bars[0].source, "yahoo");
  assert.equal(result.bars[0].timestamp, "2026-07-14T00:00:00.000Z");
  const persisted = restartedStore.query({ instrumentId: "us-equity-general-dynamics", interval: "1day", limit: 1 })[0];
  assert.equal(persisted.openTime, "2026-07-14T13:30:00.000Z");
  assert.equal(persisted.closeTime, "2026-07-14T20:00:00.000Z");
});

test("a fresh but incomplete persisted range is refreshed from Yahoo", async () => {
  const now = () => new Date("2026-07-16T12:00:00Z");
  const { rootDir, adapter } = await createStore(now);
  await adapter.upsertBars([
    { symbol: "GD", source: "yahoo", timestamp: "2026-07-14T00:00:00.000Z", open: 100, high: 110, low: 90, close: 105, volume: 1_000 },
  ], { symbol: "GD", period: "1d", interval: "1d", ttlMs: 86_400_000 });
  const restartedStore = new DailyCandleStore({ rootDir, intervals: ["1day"] });
  await restartedStore.hydrate();
  let calls = 0;
  const service = new MarketDataService({
    yahooClient: { chart: async () => { calls += 1; return { quotes: [chartBar({ date: "2025-07-17T00:00:00Z" }), chartBar()] }; } },
    store: new MarketDataStoreAdapter({ candleStore: restartedStore, now }),
    now,
  });
  const result = await service.fetchYahooBars("GD", { period: "1y", interval: "1d" });
  assert.equal(calls, 1);
  assert.equal(result.cached, false);
});

test("partial Yahoo coverage is persisted but never promoted to a fresh cache hit", async () => {
  const now = () => new Date("2026-07-16T12:00:00Z");
  let calls = 0;
  const { adapter } = await createStore(now);
  const service = new MarketDataService({
    yahooClient: { chart: async () => {
      calls += 1;
      return { quotes: calls <= 2 ? [chartBar()] : completeMonthBars() };
    } },
    store: adapter,
    now,
  });

  const partial = await service.fetchYahooBars("GD", { period: "1mo", interval: "1d" });
  assert.equal(partial.complete, false);
  assert.equal(partial.error.code, "YAHOO_INCOMPLETE_DATA");
  const partialBatch = await service.ensureMarketData(["GD"], { period: "1mo", interval: "1d" });
  assert.equal(partialBatch.errors[0].stale, false);
  assert.equal(partialBatch.errors[0].complete, false);
  const refreshed = await service.fetchYahooBars("GD", { period: "1mo", interval: "1d" });
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.complete, true);
  const cached = await service.fetchYahooBars("GD", { period: "1mo", interval: "1d" });
  assert.equal(cached.cached, true);
  assert.equal(calls, 3);
});

test("Yahoo coverage with enough endpoints but a large interior gap is incomplete", async () => {
  const now = () => new Date("2026-07-16T12:00:00Z");
  let calls = 0;
  const gapped = [
    ...Array.from({ length: 16 }, (_value, index) => new Date(Date.parse("2026-06-17T00:00:00Z") + index * 86_400_000).toISOString()),
    "2026-07-14T00:00:00Z",
  ].map((date) => chartBar({ date }));
  const { adapter } = await createStore(now);
  const service = new MarketDataService({
    yahooClient: { chart: async () => { calls += 1; return { quotes: calls === 1 ? gapped : completeMonthBars() }; } },
    store: adapter,
    now,
  });

  assert.equal((await service.fetchYahooBars("GD", { period: "1mo", interval: "1d" })).complete, false);
  assert.equal((await service.fetchYahooBars("GD", { period: "1mo", interval: "1d" })).complete, true);
  assert.equal(calls, 2);
});

test("a persistence failure cannot publish an uncommitted fresh cache entry", async () => {
  const now = () => new Date("2026-07-16T12:00:00Z");
  let calls = 0;
  let writes = 0;
  const candleStore = {
    query: () => [],
    upsert: async () => {
      writes += 1;
      if (writes === 1) throw new Error("disk unavailable");
      return { inserted: completeMonthBars().length, updated: 0, duplicates: 0, rejectedOpen: 0 };
    },
  };
  const service = new MarketDataService({
    yahooClient: { chart: async () => { calls += 1; return { quotes: completeMonthBars() }; } },
    store: new MarketDataStoreAdapter({ candleStore, now }),
    now,
  });

  await assert.rejects(service.fetchYahooBars("GD", { period: "1mo", interval: "1d", allowStale: false }), (error) => error.code === "YAHOO_REQUEST_FAILED");
  const recovered = await service.fetchYahooBars("GD", { period: "1mo", interval: "1d", allowStale: false });
  assert.equal(recovered.complete, true);
  assert.equal(calls, 2);
  assert.equal(writes, 2);
});

test("absolute cache windows keep independent freshness timestamps", async () => {
  let nowMs = Date.parse("2026-07-16T12:00:00Z");
  let calls = 0;
  const { adapter } = await createStore(() => new Date(nowMs));
  const service = new MarketDataService({
    yahooClient: { chart: async (_symbol, options) => {
      calls += 1;
      return { quotes: completeDailyRange(options.period1, options.period2) };
    } },
    store: adapter,
    now: () => new Date(nowMs),
    ttlByInterval: { "1d": 60 },
  });
  const january = { period: "1mo", interval: "1d", from: "2024-01-01T00:00:00Z", to: "2024-02-01T00:00:00Z" };
  const february = { period: "1mo", interval: "1d", from: "2024-02-01T00:00:00Z", to: "2024-03-01T00:00:00Z" };

  assert.equal((await service.fetchYahooBars("GD", january)).complete, true);
  nowMs += 61;
  assert.equal((await service.fetchYahooBars("GD", february)).complete, true);
  assert.equal((await service.fetchYahooBars("GD", january)).cached, false);
  assert.equal(calls, 3);
});

test("market data cache does not truncate valid series at the legacy 5000-bar boundary", async () => {
  const start = Date.parse("2026-06-01T00:00:00Z");
  const bars = Array.from({ length: 6_001 }, (_value, index) => ({
    symbol: "BTC-USD",
    source: "yahoo",
    timestamp: new Date(start + index * 300_000).toISOString(),
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1_000,
  }));
  const candleStore = { query: () => [], upsert: async () => ({ inserted: bars.length, updated: 0, duplicates: 0, rejectedOpen: 0 }) };
  const adapter = new MarketDataStoreAdapter({ candleStore, now: () => new Date("2026-07-16T12:00:00Z") });
  await adapter.upsertBars(bars, { symbol: "BTC-USD", period: "1mo", interval: "5m", ttlMs: 60_000 });
  assert.equal(adapter.getBars({ symbol: "BTC-USD", period: "1mo", interval: "5m", ttlMs: 60_000 }).bars.length, 6_001);
});

test("a revision committed through one period invalidates overlapping cache keys", async () => {
  const now = () => new Date("2026-07-16T12:00:00Z");
  const { adapter } = await createStore(now);
  const initial = { symbol: "GD", source: "yahoo", timestamp: "2026-07-14T00:00:00.000Z", open: 100, high: 110, low: 90, close: 105, volume: 1_000 };
  await adapter.upsertBars([initial], { symbol: "GD", period: "1mo", interval: "1d", ttlMs: 60_000 });
  assert.equal(adapter.getBars({ symbol: "GD", period: "1mo", interval: "1d", ttlMs: 60_000 }).bars[0].close, 105);
  await adapter.upsertBars([{ ...initial, high: 112, close: 107 }], { symbol: "GD", period: "1y", interval: "1d", ttlMs: 60_000 });
  assert.equal(adapter.getBars({ symbol: "GD", period: "1mo", interval: "1d", ttlMs: 60_000 }).bars[0].close, 107);
});

test("rolling daily history includes the latest closed session timestamp", async () => {
  const now = () => new Date("2026-07-16T12:00:00Z");
  const { adapter } = await createStore(now);
  const service = new MarketDataService({
    yahooClient: { chart: async () => ({ quotes: [chartBar({ date: "2026-07-15T00:00:00Z" })] }) },
    store: adapter,
    now,
  });
  const result = await service.fetchYahooBars("GD", { period: "1d", interval: "1d", allowStale: false });
  assert.equal(result.bars[0].timestamp, "2026-07-15T00:00:00.000Z");
  assert.equal(result.complete, true);
});

test("historical from/to boundaries are sent unchanged to Yahoo instead of ending at now", async () => {
  const now = () => new Date("2026-07-16T12:00:00Z");
  let chartOptions = null;
  const yahooClient = {
    chart: async (_symbol, options) => {
      chartOptions = options;
      return { quotes: [chartBar({ date: "2024-01-15T00:00:00Z" })] };
    },
  };
  const { adapter } = await createStore(now);
  const service = new MarketDataService({ yahooClient, store: adapter, now });
  const result = await service.fetchYahooBars("GD", {
    period: "1mo",
    interval: "1d",
    from: "2024-01-01T00:00:00Z",
    to: "2024-02-01T00:00:00Z",
  });

  assert.equal(chartOptions.period1.toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(chartOptions.period2.toISOString(), "2024-02-01T00:00:00.000Z");
  assert.equal(result.cached, false);
  assert.equal(result.bars[0].timestamp, "2024-01-15T00:00:00.000Z");
});

test("Yahoo data outside an absolute range cannot produce a fresh empty dataset", async () => {
  const now = () => new Date("2026-07-16T12:00:00Z");
  const { adapter } = await createStore(now);
  const service = new MarketDataService({
    yahooClient: { chart: async () => ({ quotes: [chartBar({ date: "2026-07-14T00:00:00Z" })] }) },
    store: adapter,
    now,
  });
  await assert.rejects(service.fetchYahooBars("GD", {
    period: "1mo",
    interval: "1d",
    from: "2024-01-01T00:00:00Z",
    to: "2024-02-01T00:00:00Z",
    allowStale: false,
  }), (error) => error.code === "YAHOO_NO_DATA");
});

test("expired stored bars are returned as stale when Yahoo fails", async () => {
  let nowMs = Date.parse("2026-07-16T12:00:00Z");
  let fail = false;
  const yahooClient = { chart: async () => {
    if (fail) throw Object.assign(new Error("upstream unavailable https://query2.finance.yahoo.com/quote?crumb=stale-secret"), { status: 503 });
    return { quotes: [chartBar()] };
  } };
  const { adapter } = await createStore(() => new Date(nowMs));
  const service = new MarketDataService({ yahooClient, store: adapter, now: () => new Date(nowMs), ttlByInterval: { "1d": 100 } });
  await service.fetchYahooBars("GD", { period: "1mo", interval: "1d" });
  nowMs += 101;
  fail = true;
  const stale = await service.fetchYahooBars("GD", { period: "1mo", interval: "1d" });
  assert.equal(stale.stale, true);
  assert.equal(stale.cached, true);
  assert.equal(stale.bars.length, 1);
  assert.equal(stale.error.retryable, true);
  assert.equal(stale.error.message.includes("stale-secret"), false);
  assert.equal(stale.error.message.includes("***"), true);
  const ensured = await service.ensureMarketData(["GD"], { period: "1mo", interval: "1d" });
  assert.equal(ensured.errors[0].stale, true);
});

test("invalid symbol and unsupported intraday range fail before Yahoo is called", async () => {
  let calls = 0;
  const yahooClient = { chart: async () => { calls += 1; return { quotes: [] }; } };
  const { adapter } = await createStore(() => new Date("2026-07-16T12:00:00Z"));
  const service = new MarketDataService({ yahooClient, store: adapter, now: () => new Date("2026-07-16T12:00:00Z") });
  await assert.rejects(service.fetchYahooBars("../AAPL"), (error) => error.code === "INVALID_SYMBOL");
  await assert.rejects(service.fetchYahooBars("AAPL", { period: "5y", interval: "1h" }), (error) => error.code === "INVALID_RANGE");
  assert.equal(calls, 0);
});

test("search, quote resolution and batch ensure use normalized Yahoo contracts", async () => {
  let searchCalls = 0;
  let quoteCalls = 0;
  const yahooClient = {
    chart: async (symbol) => ({ quotes: [
      chartBar({ date: "2026-07-12T00:00:00Z" }),
      chartBar({ date: "2026-07-13T00:00:00Z" }),
      chartBar({ date: symbol === "AAPL" ? "2026-07-14T00:00:00Z" : "2026-07-15T00:00:00Z" }),
    ] }),
    search: async (query) => { searchCalls += 1; return { quotes: [{ symbol: query === "TSLA" ? "TSLA" : "AAPL", isYahooFinance: true, quoteType: "EQUITY", longname: query === "TSLA" ? "Tesla, Inc." : "Apple Inc.", exchange: "NMS" }] }; },
    quote: async () => { quoteCalls += 1; return { AAPL: { symbol: "AAPL", regularMarketPrice: 201, regularMarketTime: new Date("2026-07-15T20:00:00Z"), quoteType: "EQUITY", longName: "Apple Inc.", currency: "USD", exchange: "NMS", exchangeTimezoneName: "America/New_York" } }; },
  };
  const { adapter } = await createStore(() => new Date("2026-07-16T12:00:00Z"));
  const service = new MarketDataService({ yahooClient, store: adapter, now: () => new Date("2026-07-16T12:00:00Z") });
  assert.equal((await service.searchSymbols("Apple"))[0].symbol, "AAPL");
  assert.equal((await service.searchSymbols("Apple"))[0].name, "Apple Inc.");
  assert.equal(searchCalls, 1);
  assert.equal(quoteCalls, 0);
  assert.equal((await service.searchSymbols("TSLA"))[0].symbol, "TSLA");
  assert.equal(searchCalls, 2);
  assert.equal(quoteCalls, 0);
  assert.equal((await service.fetchQuotes(["aapl"]))[0].price, 201);
  assert.equal(quoteCalls, 1);
  const instrument = await service.resolveInstrument("AAPL");
  assert.equal(instrument.providerSymbols.yahoo, "AAPL");
  assert.equal(instrument.verificationStatus, "verified");
  assert.equal(quoteCalls, 2);

  const ensured = await service.ensureMarketData(["AAPL", "MSFT", "bad symbol"], { period: "5d", interval: "1d" });
  assert.deepEqual(Object.keys(ensured.data).sort(), ["AAPL", "MSFT"]);
  assert.equal(ensured.errors.length, 1);
  assert.equal(ensured.errors[0].code, "INVALID_SYMBOL");
});
