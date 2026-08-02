import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { classifyMarketConditionsAvailability } from "../services/market/marketConditionsAvailability.js";

const AS_OF = "2026-08-02T18:00:00.000Z";

const spy = Object.freeze({
  instrumentId: "yahoo-spy-test",
  canonicalSymbol: "SPY",
  assetType: "etf",
  timezone: "America/New_York",
  sessionPolicy: "exchange-hours"
});

const bitcoin = Object.freeze({
  instrumentId: "yahoo-btc-test",
  canonicalSymbol: "BTC-USD",
  assetType: "crypto",
  timezone: "UTC",
  sessionPolicy: "24x7"
});

function candle(instrument, closeTime, dataMode = "observed") {
  const closeMs = Date.parse(closeTime);
  return {
    instrumentId: instrument.instrumentId,
    interval: "5min",
    openTime: new Date(closeMs - 5 * 60_000).toISOString(),
    closeTime: new Date(closeMs).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    currency: "USD",
    source: "fixture",
    adjusted: true,
    dataMode,
    quality: dataMode === "stale" ? "stale-if-error" : "valid",
    provenance: { adjustmentMode: "splits", stale: dataMode === "stale" }
  };
}

test("availability precedence keeps outside_intraday_limit authoritative", () => {
  const result = classifyMarketConditionsAvailability({
    instrument: bitcoin,
    asOf: AS_OF,
    outsideIntradayLimit: true,
    automaticIngestionEnabled: true
  });

  assert.equal(result.analyzable, false);
  assert.equal(result.primaryReason, "outside_intraday_limit");
  assert.deepEqual(result.reasonCodes, ["outside_intraday_limit"]);
  assert.equal(result.sessionState, "continuous");
  assert.equal(result.ingestionState, "not_scheduled");
  assert.equal(result.requiredClosedCandles, 2);
  assert.equal(result.availableClosedCandles, 0);
});

test("SPY stale history reports closed session and rollup gaps without hiding the primary cause", () => {
  const result = classifyMarketConditionsAvailability({
    instrument: spy,
    base5m: {
      count: 233,
      nonSyntheticCount: 233,
      lastCandleAt: "2026-07-21T18:55:00.000Z"
    },
    seriesCandles: [],
    seriesInterval: "1h",
    seriesQuality: { status: "partial", gapDetected: true },
    seriesGaps: [{ reason: "missing_candles" }],
    incompleteBuckets: [{ reason: "missing_candles" }],
    windowMin: 240,
    asOf: AS_OF,
    pollIntervalMs: 15 * 60_000,
    automaticIngestionEnabled: true
  });

  assert.deepEqual(result, {
    analyzable: false,
    primaryReason: "stale_local_data",
    reasonCodes: ["stale_local_data", "market_closed", "rollup_gaps"],
    sessionState: "closed",
    ingestionState: "enabled",
    lastCandleAt: "2026-07-21T18:55:00.000Z",
    expectedLatestCandleAt: "2026-07-31T20:00:00.000Z",
    nextEligibleAt: "2026-08-03T13:30:00.000Z",
    requiredClosedCandles: 2,
    availableClosedCandles: 0
  });
});

test("a complete last exchange session is market_closed rather than stale", () => {
  const result = classifyMarketConditionsAvailability({
    instrument: spy,
    base5m: {
      count: 78,
      nonSyntheticCount: 78,
      lastCandleAt: "2026-07-31T20:00:00.000Z"
    },
    asOf: AS_OF,
    automaticIngestionEnabled: true
  });

  assert.equal(result.primaryReason, "market_closed");
  assert.deepEqual(result.reasonCodes, ["market_closed"]);
  assert.equal(result.expectedLatestCandleAt, "2026-07-31T20:00:00.000Z");
  assert.equal(result.nextEligibleAt, "2026-08-03T13:30:00.000Z");
});

test("exchange availability resolves winter timezone offsets without a provider call", () => {
  const result = classifyMarketConditionsAvailability({
    instrument: spy,
    base5m: {
      count: 78,
      nonSyntheticCount: 78,
      lastCandleAt: "2026-12-04T21:00:00.000Z"
    },
    asOf: "2026-12-06T18:00:00.000Z",
    automaticIngestionEnabled: true
  });

  assert.equal(result.primaryReason, "market_closed");
  assert.equal(result.expectedLatestCandleAt, "2026-12-04T21:00:00.000Z");
  assert.equal(result.nextEligibleAt, "2026-12-07T14:30:00.000Z");
});

test("unsupported futures distinguish missing history from ingestion capability", () => {
  const future = { ...spy, instrumentId: "future", canonicalSymbol: "CL=F", assetType: "future" };
  const result = classifyMarketConditionsAvailability({ instrument: future, asOf: AS_OF, automaticIngestionEnabled: true });

  assert.equal(result.primaryReason, "no_5m_history");
  assert.deepEqual(result.reasonCodes, ["no_5m_history", "automatic_ingestion_unsupported"]);
  assert.equal(result.sessionState, "unsupported");
  assert.equal(result.ingestionState, "unsupported");
  assert.equal(result.expectedLatestCandleAt, null);
  assert.equal(result.nextEligibleAt, null);
});

test("fresh continuous coverage is analyzable and a single close is warming_up", () => {
  const complete = [
    candle(bitcoin, "2026-08-02T17:55:00.000Z"),
    candle(bitcoin, "2026-08-02T18:00:00.000Z")
  ];
  const ready = classifyMarketConditionsAvailability({
    instrument: bitcoin,
    baseCandles: complete,
    seriesCandles: complete,
    seriesInterval: "5min",
    windowMin: 15,
    asOf: AS_OF,
    automaticIngestionEnabled: false
  });
  const warming = classifyMarketConditionsAvailability({
    instrument: bitcoin,
    baseCandles: complete.slice(-1),
    seriesCandles: complete.slice(-1),
    seriesInterval: "5min",
    windowMin: 15,
    asOf: AS_OF
  });

  assert.equal(ready.analyzable, true);
  assert.equal(ready.primaryReason, null);
  assert.deepEqual(ready.reasonCodes, ["automatic_ingestion_disabled"]);
  assert.equal(ready.sessionState, "continuous");
  assert.equal(ready.ingestionState, "disabled");
  assert.equal(ready.expectedLatestCandleAt, AS_OF);
  assert.equal(ready.availableClosedCandles, 2);
  assert.equal(warming.analyzable, false);
  assert.equal(warming.primaryReason, "warming_up");
  assert.deepEqual(warming.reasonCodes, ["warming_up"]);
});

test("freshness tolerance is max of two polls and three five-minute candles", () => {
  const atTolerance = [
    candle(bitcoin, "2026-08-02T17:40:00.000Z"),
    candle(bitcoin, "2026-08-02T17:45:00.000Z")
  ];
  const beyondTolerance = [
    candle(bitcoin, "2026-08-02T17:35:00.000Z"),
    candle(bitcoin, "2026-08-02T17:40:00.000Z")
  ];
  const fresh = classifyMarketConditionsAvailability({ instrument: bitcoin, baseCandles: atTolerance, seriesCandles: atTolerance, windowMin: 60, asOf: AS_OF, pollIntervalMs: 5 * 60_000 });
  const stale = classifyMarketConditionsAvailability({ instrument: bitcoin, baseCandles: beyondTolerance, seriesCandles: beyondTolerance, windowMin: 60, asOf: AS_OF, pollIntervalMs: 5 * 60_000 });

  assert.equal(fresh.primaryReason, null);
  assert.equal(stale.primaryReason, "stale_local_data");
  assert.equal(stale.analyzable, false);
});

test("expected bucket_open is not reported as a rollup gap", () => {
  const values = [candle(bitcoin, "2026-08-02T17:55:00.000Z"), candle(bitcoin, AS_OF)];
  const result = classifyMarketConditionsAvailability({
    instrument: bitcoin,
    baseCandles: values,
    seriesCandles: values,
    incompleteBuckets: [{ reason: "bucket_open" }],
    windowMin: 15,
    asOf: AS_OF
  });

  assert.equal(result.analyzable, true);
  assert.ok(!result.reasonCodes.includes("rollup_gaps"));
});

test("exchange session calculation is bounded and avoids per-five-minute scans", () => {
  const start = performance.now();
  for (let index = 0; index < 100; index += 1) {
    classifyMarketConditionsAvailability({
      instrument: spy,
      base5m: { count: 1, nonSyntheticCount: 1, lastCandleAt: "2026-07-21T18:55:00.000Z" },
      asOf: AS_OF
    });
  }
  assert.ok(performance.now() - start < 2_000);
});
