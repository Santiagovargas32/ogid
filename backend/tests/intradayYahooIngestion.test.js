import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DailyCandleStore } from "../services/market/dailyCandleStore.js";
import { IntradayCandleService, resolveIntradayFetchRange } from "../services/market/intradayCandleService.js";
import { getInstrumentById, registerInstrument } from "../services/market/instrumentRegistry.js";
import { sessionPolicyResolver } from "../services/market/sessionPolicyResolver.js";
import { MarketDataService } from "../services/marketData/marketDataService.js";
import { MarketDataStoreAdapter } from "../services/marketData/marketDataStore.js";
import { YahooClient } from "../services/marketData/yahooClient.js";
import { YahooRequestQueue } from "../services/marketData/rateLimit.js";

const START_MS = Date.parse("2026-08-03T15:00:00.000Z");
const STEP_MS = 5 * 60_000;

const spy = registerInstrument({
  instrumentId: "us-etf-spy",
  canonicalSymbol: "SPY",
  displayName: "SPDR S&P 500 ETF Trust",
  assetType: "etf",
  exchange: "NYSE Arca",
  mic: "ARCX",
  currency: "USD",
  timezone: "America/New_York",
  country: "US",
  rolloutBatch: 1,
  refreshTier: "hot",
  sessionPolicy: "nyse-equities",
  providerSymbols: { yahoo: "SPY" },
  aliases: ["SPY"],
  verificationStatus: "verified",
  metadataSource: { provider: "test-fixture", verifiedAt: "2026-08-03" },
  dynamic: false,
});
const crude = registerInstrument({
  instrumentId: "us-future-crude-oil",
  canonicalSymbol: "CL=F",
  displayName: "Crude Oil Futures",
  assetType: "future",
  exchange: "NYMEX",
  mic: "XNYM",
  currency: "USD",
  timezone: "America/Chicago",
  country: "US",
  rolloutBatch: 1,
  refreshTier: "hot",
  sessionPolicy: "provider-futures-hours",
  providerSymbols: { yahoo: "CL=F" },
  aliases: ["CL=F"],
  verificationStatus: "verified",
  metadataSource: { provider: "test-fixture", verifiedAt: "2026-08-03" },
  dynamic: false,
});
const bitcoin = getInstrumentById("crypto-bitcoin-us-dollar");
const selected = [bitcoin, spy, crude].map((instrument) => ({ ...instrument, refreshTier: "hot" }));

function barsForRange(symbol, period1, period2) {
  const first = Math.ceil(period1.getTime() / STEP_MS) * STEP_MS;
  const instrument = selected.find((entry) => entry.providerSymbols.yahoo === symbol);
  assert.ok(instrument, `missing fixture instrument for ${symbol}`);
  const eligibleSlots = [];
  for (let timestamp = first; timestamp < period2.getTime(); timestamp += STEP_MS) {
    if (sessionPolicyResolver.resolve(instrument, timestamp, { intervalMs: STEP_MS }).eligible) {
      eligibleSlots.push(timestamp);
    }
  }
  return {
    quotes: eligibleSlots.slice(-500).map((timestamp, index) => {
      const offset = index / 100;
      return { date: new Date(timestamp), open: 100 + offset, high: 102 + offset, low: 99 + offset, close: 101 + offset, volume: 1_000 + index, symbol };
    })
  };
}

function yahooConfig(marketDataService) {
  return {
    provider: "yahoo",
    marketDataService,
    tickers: selected.map((instrument) => instrument.canonicalSymbol),
    watchlistService: { selectedInstruments: () => selected, applySelection: (values) => values },
    dailyCandles: { enabled: true },
    intradayCandles: { enabled: true, interval: "5min", pollIntervalMs: 900_000, adjustmentMode: "splits" },
  };
}

test("Yahoo bootstrap ranges are asset-aware and incremental polling overlaps the latest local candle", () => {
  const now = new Date(START_MS);
  const cryptoRange = resolveIntradayFetchRange({ instrument: bitcoin, interval: "5min", now });
  const futureRange = resolveIntradayFetchRange({ instrument: crude, interval: "5min", now });
  const equityRange = resolveIntradayFetchRange({ instrument: spy, interval: "5min", now });
  const duration = (range) => Date.parse(range.to) - Date.parse(range.from);
  assert.equal(cryptoRange.phase, "bootstrap");
  assert.equal(cryptoRange.targetBars, 500);
  assert.ok(duration(cryptoRange) < duration(futureRange));
  assert.ok(duration(futureRange) < duration(equityRange));

  const incremental = resolveIntradayFetchRange({
    instrument: bitcoin,
    interval: "5min",
    latestCandle: { openTime: "2026-08-03T14:55:00.000Z", closeTime: "2026-08-03T15:00:00.000Z" },
    now: new Date("2026-08-03T15:15:00.000Z"),
  });
  assert.deepEqual(incremental, {
    phase: "incremental",
    from: "2026-08-03T14:40:00.000Z",
    to: "2026-08-03T15:15:00.000Z",
    targetBars: null,
  });

  const boundedGap = resolveIntradayFetchRange({
    instrument: bitcoin,
    interval: "5min",
    latestCandle: { openTime: "2026-05-01T00:00:00.000Z" },
    now
  });
  assert.equal(Date.parse(boundedGap.to) - Date.parse(boundedGap.from), 30 * 86_400_000);
});

test("Yahoo ingests the three selected universes with one chart request per due symbol and no Twelve projection", async () => {
  let currentMs = START_MS;
  let active = 0;
  let maximumActive = 0;
  const chartCalls = [];
  const client = new YahooClient({
    client: {
      chart: async (symbol, options) => {
        chartCalls.push({ symbol, period1: options.period1, period2: options.period2, interval: options.interval });
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return barsForRange(symbol, options.period1, options.period2);
      },
    },
    timeoutMs: 5_000,
    retries: 0,
  });
  const store = new DailyCandleStore({ rootDir: mkdtempSync(join(tmpdir(), "intraday-yahoo-three-")), rolloutBatch: 3, intervals: ["5min"] });
  await store.hydrate();
  const adapter = new MarketDataStoreAdapter({ candleStore: store, now: () => new Date(currentMs) });
  const marketDataService = new MarketDataService({ yahooClient: client, store: adapter, now: () => new Date(currentMs) });
  const service = new IntradayCandleService({ store, marketConfig: yahooConfig(marketDataService), now: () => new Date(currentMs) });

  const first = service.runScheduled();
  const duplicateSweep = service.runScheduled();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicateSweep]);
  assert.equal(firstResult.status, "ok");
  assert.equal(duplicateResult.status, "ok");
  assert.equal(chartCalls.length, 3);
  assert.deepEqual(chartCalls.map((call) => call.symbol), ["BTC-USD", "SPY", "CL=F"]);
  assert.ok(maximumActive <= 3);
  assert.equal(firstResult.metrics.projection.metered, false);
  assert.equal(firstResult.metrics.projection.hotInstrumentCount, 3);
  assert.equal(firstResult.metrics.instrumentStates.length, 3);
  assert.ok(firstResult.metrics.instrumentStates.every((entry) => entry.state === "ready"));
  assert.ok(selected.every((instrument) => store.latest(instrument.instrumentId, "splits", "5min")));
  assert.ok(selected.every((instrument) => store.query({ instrumentId: instrument.instrumentId, adjustmentMode: "splits", interval: "5min" }).length <= 500));

  currentMs += 900_000;
  const secondResult = await service.runScheduled();
  assert.equal(secondResult.status, "ok");
  assert.equal(chartCalls.length, 6);
  assert.deepEqual(chartCalls.slice(3).map((call) => call.symbol), ["SPY", "CL=F", "BTC-USD"]);
  for (const call of chartCalls.slice(3)) {
    assert.equal(call.interval, "5m");
    assert.ok(call.period2.getTime() - call.period1.getTime() <= 35 * 60_000);
  }
});

test("a Yahoo 429 stops the pending candle queue and marks all three universes for provider cooldown", async () => {
  let physicalCalls = 0;
  const queue = new YahooRequestQueue({ concurrency: 1, retries: 0, now: () => START_MS, rateLimitCooldownMs: 60_000 });
  const client = new YahooClient({
    client: {
      chart: async () => {
        physicalCalls += 1;
        throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 2_500 });
      },
    },
    requestQueue: queue,
    timeoutMs: 1_000,
    retries: 0,
  });
  const store = new DailyCandleStore({ rootDir: mkdtempSync(join(tmpdir(), "intraday-yahoo-cooldown-")), rolloutBatch: 3, intervals: ["5min"] });
  await store.hydrate();
  const adapter = new MarketDataStoreAdapter({ candleStore: store, now: () => new Date(START_MS) });
  const marketDataService = new MarketDataService({ yahooClient: client, store: adapter, now: () => new Date(START_MS) });
  const service = new IntradayCandleService({ store, marketConfig: yahooConfig(marketDataService), now: () => new Date(START_MS) });

  const result = await service.runScheduled();
  assert.equal(result.status, "provider-cooldown");
  assert.equal(physicalCalls, 1);
  assert.ok(result.errors.some((error) => Number(error.retryAfterMs) === 60_000));
  assert.ok(result.metrics.instrumentStates.every((entry) => entry.state === "provider_cooldown"));
  assert.ok(result.metrics.instrumentStates.every((entry) => entry.retryAfterMs === 60_000));
  assert.equal(result.metrics.intradayCredits, 0);
});
