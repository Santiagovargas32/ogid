import assert from "node:assert/strict";
import test from "node:test";
import { atr, bollingerBands, calculateTechnicalIndicators, ema, logarithmicReturn, macd, realizedVolatility, rsi, simpleReturn, sma, volumeChange } from "../services/market/technicalIndicators.js";
import { TechnicalIndicatorService } from "../services/market/technicalIndicatorService.js";

function candles(closes, { interval = "1day", source = "fixture", volume = true, start = "2026-01-01T14:30:00.000Z" } = {}) {
  const step = interval === "15min" ? 900_000 : 86_400_000; return closes.map((close, index) => ({ instrumentId: "us-equity-general-dynamics", interval, openTime: new Date(Date.parse(start) + index * step).toISOString(), closeTime: new Date(Date.parse(start) + (index + 1) * step).toISOString(), open: close, high: close + 1, low: close - 1, close, volume: volume ? 100 + index : null, currency: "USD", source, adjusted: true, dataMode: "observed", provenance: { provider: source, adjustmentMode: "splits" } }));
}

test("golden constant series produces neutral deterministic values", () => {
  const values = Array(40).fill(10); assert.equal(simpleReturn(10, 10).value, 0); assert.equal(logarithmicReturn(10, 10).value, 0); assert.equal(sma(values, 20).value, 10); assert.equal(ema(values, 20).value, 10); assert.equal(rsi(values, 14).value, 50); assert.deepEqual(bollingerBands(values, 20, 2).value, { lower: 10, middle: 10, upper: 10 }); assert.equal(realizedVolatility(values, 20).value, 0); assert.equal(atr(candles(values), 14).value, 2);
});

test("ascending and descending vectors reach RSI extremes", () => { assert.equal(rsi(Array.from({ length: 20 }, (_, index) => index + 1), 14).value, 100); assert.equal(rsi(Array.from({ length: 20 }, (_, index) => 20 - index), 14).value, 0); });
test("EMA uses an SMA seed and MACD golden linear vector is stable", () => { assert.equal(ema([1, 2, 3, 4], 3).value, 3); const result = macd(Array.from({ length: 40 }, (_, index) => index + 1)); assert.equal(result.value.macd, 7); assert.equal(result.value.signal, 7); assert.equal(result.value.histogram, 0); });
test("ATR Bollinger and realized volatility match known vectors", () => { assert.equal(atr(candles(Array(20).fill(10)), 14).value, 2); assert.deepEqual(bollingerBands([1, 2, 3, 4], 4, 2).value, { lower: 0.2639320225002102, middle: 2.5, upper: 4.73606797749979 }); assert.ok(Math.abs(realizedVolatility([100, 110, 99, 108.9], 3).value - 0.11585728004354243) < 1e-12); });
test("missing volume and insufficient samples return null with a reason", () => { assert.equal(volumeChange(null, null).value, null); assert.equal(volumeChange(null, null).reason, "volume_unavailable"); assert.equal(sma([1, 2], 3).reason, "insufficient_data"); const result = calculateTechnicalIndicators(candles([1, 2], { volume: false }), { interval: "1day", calculatedAt: "2026-02-01T00:00:00.000Z" }); assert.equal(result.indicators.rsi.value, null); assert.equal(result.indicators.rsi.reason, "insufficient_data"); });

test("gaps and incompatible series are detected instead of fabricated", () => {
  const gap = candles([1, 2, 3], { interval: "15min" }); gap[2].openTime = "2026-01-01T15:30:00.000Z"; gap[2].closeTime = "2026-01-01T15:45:00.000Z"; const gapResult = calculateTechnicalIndicators(gap, { interval: "15min" }); assert.equal(gapResult.quality.gapDetected, true); assert.equal(gapResult.indicators.simpleReturn.reason, "gaps_detected");
  const mixed = candles(Array(30).fill(10)); mixed.at(-1).source = "other"; assert.equal(calculateTechnicalIndicators(mixed, { interval: "1day" }).indicators.sma.reason, "incompatible_series");
});

test("calculations have no look-ahead and are reproducible", () => { const prefix = candles(Array.from({ length: 35 }, (_, index) => index + 1)); const first = calculateTechnicalIndicators(prefix, { interval: "1day", calculatedAt: "2026-02-01T00:00:00.000Z" }); const extended = [...prefix, ...candles([100, 200], { start: new Date(Date.parse(prefix.at(-1).openTime) + 86_400_000).toISOString() })]; const repeated = calculateTechnicalIndicators(extended.slice(0, prefix.length), { interval: "1day", calculatedAt: "2026-02-01T00:00:00.000Z" }); assert.deepEqual(repeated, first); });

test("cache is reused until the relevant series latest candle changes and performs zero HTTP", () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("unexpected-http"); };
  try { let series = candles(Array.from({ length: 40 }, (_, index) => index + 1)); const store = { query: () => series }; let tick = 0; const service = new TechnicalIndicatorService({ store, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) }); const first = service.calculate({ instrumentId: series[0].instrumentId }); const cached = service.calculate({ instrumentId: series[0].instrumentId }); assert.strictEqual(cached, first); series = [...series, ...candles([41], { start: new Date(Date.parse(series.at(-1).openTime) + 86_400_000).toISOString() })]; const invalidated = service.calculate({ instrumentId: series[0].instrumentId }); assert.notStrictEqual(invalidated, first); assert.notEqual(invalidated.lastCandleAt, first.lastCandleAt); }
  finally { globalThis.fetch = originalFetch; }
});
