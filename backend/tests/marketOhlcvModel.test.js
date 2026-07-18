import assert from "node:assert/strict";
import test from "node:test";
import { buildOhlcvChartSeries, normalizeOhlcvCandles } from "../../frontend/js/marketOhlcvModel.js";

test("OHLCV model sorts, deduplicates and rejects malformed candles", () => {
  const candles = normalizeOhlcvCandles([
    { openTime: "2026-07-15T00:00:00Z", open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { openTime: "invalid", open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { openTime: "2026-07-14T00:00:00Z", open: 8, high: 10, low: 7, close: 9, volume: null },
    { openTime: "2026-07-15T00:00:00Z", open: 11, high: 13, low: 10, close: 12, volume: 125 },
    { openTime: "2026-07-16T00:00:00Z", open: 10, high: 9, low: 8, close: 10, volume: 50 }
  ]);

  assert.equal(candles.length, 2);
  assert.equal(candles[0].close, 9);
  assert.equal(candles[1].close, 12);
  assert.equal(candles[1].volume, 125);
});
test("OHLCV model builds aligned chart series", () => {
  const series = buildOhlcvChartSeries([
    { openTime: "2026-07-14T00:00:00Z", open: 8, high: 10, low: 7, close: 9, volume: 80 }
  ]);
  assert.deepEqual(series.closes, [9]);
  assert.deepEqual(series.volumes, [80]);
  assert.equal(series.labels[0], "2026-07-14T00:00:00.000Z");
});
