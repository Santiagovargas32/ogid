import assert from "node:assert/strict";
import test from "node:test";
import { aggregateClosedCandles, buildMarketConditionSeries, CANDLE_ROLLUP_METHOD_VERSION, detectCandleGaps } from "../services/market/candleAggregationService.js";

const continuous = { instrumentId: "crypto-test", sessionPolicy: "24x7", timezone: "UTC", exchange: "CCC" };
const equity = { instrumentId: "equity-test", sessionPolicy: "nyse-equities", timezone: "America/New_York", exchange: "NYSE" };

function candle(openTime, { interval = "5min", instrument = continuous, open = 100, high = 102, low = 99, close = 101, volume = 10, source = "fixture", dataMode = "observed" } = {}) {
  const duration = { "5min": 300_000, "15min": 900_000 }[interval];
  return {
    schemaVersion: 1,
    instrumentId: instrument.instrumentId,
    interval,
    openTime,
    closeTime: new Date(Date.parse(openTime) + duration).toISOString(),
    open,
    high,
    low,
    close,
    volume,
    currency: "USD",
    exchange: instrument.exchange,
    session: instrument.sessionPolicy,
    source,
    providerSymbol: "TEST",
    fetchedAt: "2026-07-13T21:00:00.000Z",
    adjusted: true,
    dataMode,
    quality: dataMode === "observed" ? "valid" : dataMode,
    provenance: { provider: source, providerSymbol: "TEST", adjustmentMode: "splits" }
  };
}

function sequence({ start, count, interval = "5min", instrument = continuous } = {}) {
  const duration = { "5min": 300_000, "15min": 900_000 }[interval];
  return Array.from({ length: count }, (_, index) => candle(new Date(Date.parse(start) + index * duration).toISOString(), {
    interval,
    instrument,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index
  }));
}

test("5m to 15m rollup preserves OHLCV and provenance using only closed candles", () => {
  const base = sequence({ start: "2026-07-13T00:00:00.000Z", count: 4 });
  const result = aggregateClosedCandles(base, { sourceInterval: "5min", targetInterval: "15min", instrument: continuous, asOf: "2026-07-13T00:17:00.000Z" });
  assert.equal(result.candles.length, 1);
  assert.deepEqual({ open: result.candles[0].open, high: result.candles[0].high, low: result.candles[0].low, close: result.candles[0].close, volume: result.candles[0].volume }, { open: 100, high: 104, low: 99, close: 103, volume: 33 });
  assert.equal(result.candles[0].methodVersion, CANDLE_ROLLUP_METHOD_VERSION);
  assert.equal(result.candles[0].provenance.derivedFrom, "5min");
  assert.deepEqual(result.candles[0].provenance.sourceOpenTimes, base.slice(0, 3).map((item) => item.openTime));
  assert.equal(result.quality.openCandles, 1);
});

test("an incomplete source bucket is excluded and reported as a gap", () => {
  const base = sequence({ start: "2026-07-13T00:00:00.000Z", count: 12 }).filter((_, index) => index !== 5);
  const result = aggregateClosedCandles(base, { sourceInterval: "5min", targetInterval: "15min", instrument: continuous, asOf: "2026-07-13T01:00:00.000Z" });
  assert.equal(result.candles.length, 3);
  assert.equal(result.quality.status, "partial");
  assert.equal(result.quality.gapDetected, true);
  assert.ok(result.incompleteBuckets.some((bucket) => bucket.openTime === "2026-07-13T00:15:00.000Z" && bucket.reason === "missing_candles"));
});

test("market condition windows select 5m, 15m and locally derived 1h series", () => {
  const base = sequence({ start: "2026-07-13T00:00:00.000Z", count: 24 });
  const options = { instrument: continuous, asOf: "2026-07-13T02:00:00.000Z" };
  assert.equal(buildMarketConditionSeries(base, { ...options, windowMin: 15 }).interval, "5min");
  assert.equal(buildMarketConditionSeries(base, { ...options, windowMin: 60 }).candles.length, 8);
  assert.equal(buildMarketConditionSeries(base, { ...options, windowMin: 240 }).candles.length, 2);
  assert.equal(buildMarketConditionSeries(base, { ...options, windowMin: 1440 }).candles.length, 2);
  assert.equal(buildMarketConditionSeries(base, { ...options, windowMin: 240 }).candles[0].provenance.derivedFrom, "15min");
});

test("exchange rollups anchor to the session and accept the shortened closing hour", () => {
  const base = sequence({ start: "2026-07-13T13:30:00.000Z", count: 26, interval: "15min", instrument: equity });
  const result = aggregateClosedCandles(base, { sourceInterval: "15min", targetInterval: "1h", instrument: equity, asOf: "2026-07-13T20:00:00.000Z" });
  assert.equal(result.candles.length, 7);
  assert.equal(result.candles[0].openTime, "2026-07-13T13:30:00.000Z");
  assert.equal(result.candles.at(-1).openTime, "2026-07-13T19:30:00.000Z");
  assert.equal(result.candles.at(-1).closeTime, "2026-07-13T20:00:00.000Z");
  assert.equal(result.candles.at(-1).provenance.partialSessionBucket, true);
  assert.equal(result.candles.at(-1).provenance.sourceCandleCount, 2);
  assert.equal(result.quality.gapDetected, false);
});

test("overnight exchange closures are not gaps while continuous instruments remain continuous", () => {
  const exchangeSeries = [candle("2026-07-13T19:55:00.000Z", { instrument: equity }), candle("2026-07-14T13:30:00.000Z", { instrument: equity })];
  assert.deepEqual(detectCandleGaps(exchangeSeries, { interval: "5min", instrument: equity }), []);
  const continuousSeries = [candle("2026-07-13T23:55:00.000Z"), candle("2026-07-14T00:05:00.000Z")];
  assert.equal(detectCandleGaps(continuousSeries, { interval: "5min", instrument: continuous })[0].missingCandles, 1);
});

test("weekend exchange candles are excluded with an explicit calendar limitation", () => {
  const weekend = sequence({ start: "2026-07-11T13:30:00.000Z", count: 3, instrument: equity });
  const result = aggregateClosedCandles(weekend, { sourceInterval: "5min", targetInterval: "15min", instrument: equity, asOf: "2026-07-11T14:00:00.000Z" });
  assert.equal(result.candles.length, 0);
  assert.equal(result.quality.status, "insufficient_data");
  assert.equal(result.quality.outsideSessionCandles, 3);
  assert.match(result.quality.limitations[0], /holidays and early closes/i);
  assert.equal(buildMarketConditionSeries(weekend, { windowMin: 15, instrument: equity, asOf: "2026-07-11T14:00:00.000Z" }).candles.length, 0);
});

test("synthetic and stale inputs propagate quality instead of becoming observed", () => {
  const synthetic = sequence({ start: "2026-07-13T00:00:00.000Z", count: 3 }).map((item) => ({ ...item, dataMode: "synthetic", quality: "synthetic" }));
  const stale = sequence({ start: "2026-07-13T00:15:00.000Z", count: 3 }).map((item) => ({ ...item, dataMode: "stale", quality: "stale-if-error" }));
  const result = aggregateClosedCandles([...synthetic, ...stale], { sourceInterval: "5min", targetInterval: "15min", instrument: continuous, asOf: "2026-07-13T00:30:00.000Z" });
  assert.equal(result.candles[0].dataMode, "synthetic");
  assert.equal(result.candles[1].dataMode, "stale");
  assert.equal(result.quality.status, "synthetic");
});
