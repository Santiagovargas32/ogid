import { candleIntervalMs } from "./canonicalCandle.js";

export const TECHNICAL_INDICATORS_METHOD_VERSION = "technical-indicators-v1";
export const DEFAULT_INDICATOR_PARAMETERS = Object.freeze({ smaPeriod: 20, emaPeriod: 20, rsiPeriod: 14, macdFast: 12, macdSlow: 26, macdSignal: 9, bollingerPeriod: 20, bollingerStdDev: 2, atrPeriod: 14, volatilityPeriod: 20 });

const ok = (value, sampleSize) => ({ value, reason: null, sampleSize });
const unavailable = (reason, sampleSize = 0) => ({ value: null, reason, sampleSize });
const finite = (value) => Number.isFinite(Number(value));
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

export function simpleReturn(previous, current) { return finite(previous) && finite(current) && Number(previous) !== 0 ? ok(Number(current) / Number(previous) - 1, 2) : unavailable("insufficient_data"); }
export function logarithmicReturn(previous, current) { return finite(previous) && finite(current) && Number(previous) > 0 && Number(current) > 0 ? ok(Math.log(Number(current) / Number(previous)), 2) : unavailable("insufficient_data"); }
export function sma(values, period) { const sample = values.slice(-period); return period > 0 && sample.length === period && sample.every(finite) ? ok(mean(sample.map(Number)), period) : unavailable("insufficient_data", sample.length); }
export function emaSeries(values, period) {
  if (!(period > 0) || values.length < period || !values.every(finite)) return [];
  const result = Array(period - 1).fill(null); let current = mean(values.slice(0, period).map(Number)); result.push(current); const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) { current = (Number(values[index]) - current) * multiplier + current; result.push(current); }
  return result;
}
export function ema(values, period) { const series = emaSeries(values, period); return series.length ? ok(series.at(-1), values.length) : unavailable("insufficient_data", values.length); }
export function rsi(values, period = 14) {
  if (values.length < period + 1 || !values.every(finite)) return unavailable("insufficient_data", values.length);
  const changes = values.slice(1).map((value, index) => Number(value) - Number(values[index])); let averageGain = mean(changes.slice(0, period).map((change) => Math.max(change, 0))); let averageLoss = mean(changes.slice(0, period).map((change) => Math.max(-change, 0)));
  for (const change of changes.slice(period)) { averageGain = ((averageGain * (period - 1)) + Math.max(change, 0)) / period; averageLoss = ((averageLoss * (period - 1)) + Math.max(-change, 0)) / period; }
  if (averageLoss === 0) return ok(averageGain === 0 ? 50 : 100, period + 1); if (averageGain === 0) return ok(0, period + 1); return ok(100 - 100 / (1 + averageGain / averageLoss), period + 1);
}
export function macd(values, fast = 12, slow = 26, signal = 9) {
  if (!(fast < slow) || values.length < slow + signal - 1) return unavailable("insufficient_data", values.length);
  const fastSeries = emaSeries(values, fast); const slowSeries = emaSeries(values, slow); const line = values.map((_, index) => fastSeries[index] == null || slowSeries[index] == null ? null : fastSeries[index] - slowSeries[index]).filter((value) => value != null); const signalSeries = emaSeries(line, signal);
  if (!signalSeries.length) return unavailable("insufficient_data", values.length); const macdValue = line.at(-1); const signalValue = signalSeries.at(-1); return ok({ macd: macdValue, signal: signalValue, histogram: macdValue - signalValue }, values.length);
}
export function bollingerBands(values, period = 20, deviations = 2) { const sample = values.slice(-period); if (sample.length !== period || !sample.every(finite)) return unavailable("insufficient_data", sample.length); const middle = mean(sample.map(Number)); const variance = sample.reduce((total, value) => total + (Number(value) - middle) ** 2, 0) / period; const width = Math.sqrt(variance) * deviations; return ok({ lower: middle - width, middle, upper: middle + width }, period); }
export function atr(candles, period = 14) { if (candles.length < period + 1) return unavailable("insufficient_data", candles.length); const ranges = candles.slice(1).map((candle, index) => Math.max(Number(candle.high) - Number(candle.low), Math.abs(Number(candle.high) - Number(candles[index].close)), Math.abs(Number(candle.low) - Number(candles[index].close)))); const sample = ranges.slice(-period); return sample.every(finite) ? ok(mean(sample), period + 1) : unavailable("insufficient_data", candles.length); }
export function realizedVolatility(values, period = 20) { if (values.length < period + 1) return unavailable("insufficient_data", values.length); const returns = values.slice(-(period + 1)).slice(1).map((value, index) => Math.log(Number(value) / Number(values.slice(-(period + 1))[index]))); if (!returns.every(finite)) return unavailable("insufficient_data", values.length); const average = mean(returns); const variance = returns.reduce((total, value) => total + (value - average) ** 2, 0) / Math.max(1, returns.length - 1); return ok(Math.sqrt(variance), period + 1); }
export function volumeChange(previous, current) { return finite(previous) && finite(current) && Number(previous) !== 0 ? ok(Number(current) / Number(previous) - 1, 2) : unavailable("volume_unavailable"); }

function hasGap(candles, interval) { const expected = candleIntervalMs(interval); if (!expected) return true; for (let index = 1; index < candles.length; index += 1) { const delta = Date.parse(candles[index].openTime) - Date.parse(candles[index - 1].openTime); const sameUtcDate = candles[index].openTime.slice(0, 10) === candles[index - 1].openTime.slice(0, 10); if (interval === "1day" ? delta > expected * 4 : sameUtcDate && delta > expected * 1.5) return true; } return false; }
function incompatibleReason(candles, interval) { if (!candles.length) return "insufficient_data"; if (candles.some((candle, index) => candle.interval !== interval || (index && Date.parse(candle.openTime) <= Date.parse(candles[index - 1].openTime)))) return "invalid_series"; for (const field of ["instrumentId", "currency", "source", "adjusted"]) if (new Set(candles.map((candle) => candle[field])).size > 1) return "incompatible_series"; return null; }
function describe(name, result) { if (result.value == null) return { indicator: name, text: `Unavailable: ${result.reason}.`, recommendation: null }; return { indicator: name, text: "Deterministic value calculated from persisted closed candles.", recommendation: null }; }

/** @returns {{methodVersion:string, parameters:object, calculatedAt:string, lastCandleAt:string|null, observed:object|null, indicators:object, interpretations:object[], quality:object}} */
export function calculateTechnicalIndicators(candles, { interval, parameters = {}, calculatedAt = new Date().toISOString() } = {}) {
  const params = { ...DEFAULT_INDICATOR_PARAMETERS, ...parameters }; const reason = incompatibleReason(candles, interval); const gapDetected = !reason && hasGap(candles, interval); const closes = candles.map((candle) => candle.close); const volumes = candles.map((candle) => candle.volume); const blocked = (result) => reason ? unavailable(reason, candles.length) : gapDetected ? unavailable("gaps_detected", candles.length) : result;
  const indicators = {
    simpleReturn: blocked(simpleReturn(closes.at(-2), closes.at(-1))), logarithmicReturn: blocked(logarithmicReturn(closes.at(-2), closes.at(-1))), sma: blocked(sma(closes, params.smaPeriod)), ema: blocked(ema(closes, params.emaPeriod)), rsi: blocked(rsi(closes, params.rsiPeriod)), macd: blocked(macd(closes, params.macdFast, params.macdSlow, params.macdSignal)), bollinger: blocked(bollingerBands(closes, params.bollingerPeriod, params.bollingerStdDev)), atr: blocked(atr(candles, params.atrPeriod)), realizedVolatility: blocked(realizedVolatility(closes, params.volatilityPeriod)), volumeChange: blocked(volumeChange(volumes.at(-2), volumes.at(-1)))
  };
  return { methodVersion: TECHNICAL_INDICATORS_METHOD_VERSION, parameters: params, calculatedAt, lastCandleAt: candles.at(-1)?.closeTime || null, sampleSize: candles.length, observed: candles.length ? { close: candles.at(-1).close, volume: candles.at(-1).volume, asOf: candles.at(-1).closeTime, fetchedAt: candles.at(-1).fetchedAt || null, dataMode: candles.at(-1).dataMode, methodVersion: candles.at(-1).methodVersion || null, provenance: candles.at(-1).provenance } : null, indicators, interpretations: Object.entries(indicators).map(([name, result]) => describe(name, result)), quality: { reason, gapDetected } };
}
