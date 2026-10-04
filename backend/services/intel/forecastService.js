import { contentHash } from "./intelligenceStore.js";
import { sessionPolicyResolver } from "../market/sessionPolicyResolver.js";
import { resolveDailyCandleTimes } from "../market/canonicalCandle.js";

const DAY = 86400000;
const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const quantile = (sorted, p) => { const x = (sorted.length - 1) * p; const i = Math.floor(x); return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (x - i); };
const category = (value, epsilon) => value < -epsilon ? "down" : value > epsilon ? "up" : "flat";

export function forecastTarget(instrument, nowMs) {
  const policy = sessionPolicyResolver.canonicalPolicy(instrument);
  if (policy === "24x7") {
    const start = (Math.floor(nowMs / DAY) + 1) * DAY;
    return { horizon: "next_utc_day", referenceAt: new Date(start).toISOString(), resolveAt: new Date(start + DAY).toISOString(), calendarQuality: "continuous" };
  }
  if (!["nyse-equities", "exchange-hours"].includes(policy)) return null;
  // Existing session resolver explicitly labels holiday/early-close approximations.
  // If no candle exists for the target session, the resolver leaves it unresolved.
  for (let offset = 0; offset < 10; offset += 1) {
    const date = new Date(nowMs + offset * DAY).toISOString().slice(0, 10);
    const times = resolveDailyCandleTimes(date, instrument);
    if (!times || Date.parse(times.openTime) <= nowMs + 60000) continue;
    if (!sessionPolicyResolver.resolve(instrument, Date.parse(times.openTime) + 60000).eligible) continue;
    return { horizon: "next_session_open_to_close", referenceAt: times.openTime, resolveAt: times.closeTime,
      calendarQuality: "weekday_approximation", limitations: sessionPolicyResolver.quality(instrument).limitations };
  }
  return null;
}

export function buildForecastBaseline({ instrument, candles = [], asOf = new Date().toISOString(), minSamples = 60 } = {}) {
  const cutoff = Date.parse(asOf);
  const target = forecastTarget(instrument, cutoff);
  const base = { methodVersion: "empirical-session-return-v1", instrumentId: instrument.instrumentId,
    asOf, target, status: "insufficient_data", probabilityStatus: "experimental_uncalibrated", probabilities: null,
    returnQuantilesPct: null, flatThresholdPct: null, sampleSize: 0, limitations: [] };
  if (!target) return { ...base, limitations: ["A verified target session and rollover policy are required for this asset."] };
  const observed = candles.filter((c) => c.interval === "1day" && c.dataMode === "observed" && !c.synthetic
    && !["stale", "invalid", "partial"].includes(c.quality) && Date.parse(c.closeTime) <= cutoff
    && (!c.fetchedAt || Date.parse(c.fetchedAt) <= cutoff) && finite(c.open) && finite(c.close) && Number(c.open) > 0)
    .sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
  const unique = [...new Map(observed.map((c) => [c.openTime, c])).values()].slice(-365);
  const returns = unique.map((c) => (Number(c.close) / Number(c.open) - 1) * 100).sort((a, b) => a - b);
  base.sampleSize = returns.length;
  if (returns.length < minSamples) return { ...base, limitations: [`At least ${minSamples} observed complete daily candles are needed.`, ...(target.limitations || [])] };
  const latestAgeDays = (cutoff - Date.parse(unique.at(-1).closeTime)) / DAY;
  if (latestAgeDays > 7) return { ...base, limitations: ["Daily history is stale."] };
  // Frozen at issuance. It is a descriptive scale, never fitted on future outcomes.
  const epsilon = Math.max(0.1, quantile(returns.map(Math.abs).sort((a, b) => a - b), 0.5) * 0.5);
  const counts = { down: 0, flat: 0, up: 0 };
  returns.forEach((value) => counts[category(value, epsilon)] += 1);
  const probabilities = Object.fromEntries(Object.entries(counts).map(([key, n]) => [key, (n + 1) / (returns.length + 3)]));
  return { ...base, status: "available", probabilities, flatThresholdPct: epsilon,
    returnQuantilesPct: { p10: quantile(returns, 0.1), p50: quantile(returns, 0.5), p90: quantile(returns, 0.9) },
    intervalNominalCoverage: 0.8, trainingFrom: unique[0].openTime, trainingTo: unique.at(-1).closeTime,
    trainingHash: contentHash(unique.map(({ openTime, closeTime, open, close }) => ({ openTime, closeTime, open, close }))),
    limitations: ["Historical frequencies are an uncalibrated baseline, not measured forecast accuracy.",
      "Target return is next-session open to close, not return from the current quote.", ...(target.limitations || [])] };
}

export function scoreForecast(probabilities, outcome) {
  if (!probabilities || !["down", "flat", "up"].includes(outcome)) return null;
  const values = ["down", "flat", "up"].map((key) => probabilities[key]);
  if (values.some((value) => !finite(value) || value < 0 || value > 1) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-6) return null;
  return { brier: ["down", "flat", "up"].reduce((sum, key) => sum + (probabilities[key] - Number(key === outcome)) ** 2, 0),
    logLoss: -Math.log(Math.max(1e-12, probabilities[outcome])) };
}

export class ForecastService {
  constructor({ store, candleStore, now = Date.now } = {}) { this.store = store; this.candleStore = candleStore; this.now = now; }
  baseline(instrument, asOf) {
    const candles = this.candleStore?.query({ instrumentId: instrument.instrumentId, interval: "1day", adjustmentMode: "splits", limit: 1000 }) || [];
    return buildForecastBaseline({ instrument, candles, asOf });
  }
  async issue({ job, result, packetHash }) {
    const baseline = job.input.baseline;
    if (!baseline?.target || baseline.status !== "available") return null;
    const issuedAt = new Date(this.now()).toISOString();
    if (Date.parse(baseline.target.referenceAt) <= this.now()) throw Object.assign(new Error("Target session already began."), { code: "FORECAST_EXPIRED" });
    const identity = [job.subjectId, baseline.target.referenceAt, baseline.target.resolveAt];
    const forecastId = `fc_${contentHash(identity).slice(0, 32)}`;
    // One scored emission per instrument/target. Narrative revisions remain in the
    // AI archive; they do not inflate the effective number of forecasting trials.
    if (this.store.get("forecast", forecastId)) return forecastId;
    await this.store.put("forecast", forecastId, { forecastId, instrumentId: job.subjectId, issuedAt,
      evidenceCutoffAt: job.input.asOf, ...baseline.target, baseline, packetHash,
      model: result.model, provider: result.provider, generation: result.responseMetadata || null,
      probabilities: baseline.probabilities, llmWeight: 0, llmProbabilities: result.output.weights,
      probabilityStatus: "experimental_uncalibrated", methodVersion: "forecast-issuance-v1" }, { immutable: true });
    return forecastId;
  }
  async resolve() {
    for (const forecast of this.store.list("forecast")) {
      if (Date.parse(forecast.resolveAt) > this.now() || this.store.get("resolution", forecast.forecastId)) continue;
      const candles = this.candleStore?.query({ instrumentId: forecast.instrumentId, interval: "1day", adjustmentMode: "splits", limit: 1000 }) || [];
      const candle = candles.find((item) => item.openTime === forecast.referenceAt && item.closeTime === forecast.resolveAt
        && item.dataMode === "observed" && !item.synthetic && !["stale", "invalid", "partial"].includes(item.quality));
      if (!candle || !finite(candle.open) || Number(candle.open) <= 0 || !finite(candle.close)) continue;
      const returnPct = (Number(candle.close) / Number(candle.open) - 1) * 100;
      const outcome = category(returnPct, forecast.baseline.flatThresholdPct);
      const q = forecast.baseline.returnQuantilesPct;
      await this.store.put("resolution", forecast.forecastId, { forecastId: forecast.forecastId, instrumentId: forecast.instrumentId,
        resolvedAt: new Date(this.now()).toISOString(), returnPct, outcome, candle: structuredClone(candle),
        baseline: scoreForecast(forecast.probabilities, outcome), llm: scoreForecast(forecast.llmProbabilities, outcome),
        intervalCovered: returnPct >= q.p10 && returnPct <= q.p90 }, { immutable: true });
    }
  }
  evaluation(instrumentId = null) {
    const forecasts = this.store.list("forecast").filter((item) => !instrumentId || item.instrumentId === instrumentId);
    const resolutions = forecasts.map((item) => this.store.get("resolution", item.forecastId)).filter(Boolean);
    const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const bins = Array.from({ length: 5 }, (_, i) => ({ lower: i / 5, upper: (i + 1) / 5, count: 0, probabilitySum: 0, hits: 0 }));
    for (const result of resolutions) {
      const forecast = forecasts.find((item) => item.forecastId === result.forecastId);
      const p = forecast.probabilities.up;
      const bin = bins[Math.min(4, Math.floor(p * 5))];
      bin.count += 1; bin.probabilitySum += p; bin.hits += Number(result.outcome === "up");
    }
    return { status: "experimental_uncalibrated", issuedCount: forecasts.length, resolvedCount: resolutions.length,
      overdueUnresolvedCount: forecasts.filter((item) => Date.parse(item.resolveAt) < this.now() && !this.store.get("resolution", item.forecastId)).length,
      baselineBrier: average(resolutions.map((item) => item.baseline?.brier).filter(finite)),
      llmBrier: average(resolutions.map((item) => item.llm?.brier).filter(finite)),
      baselineLogLoss: average(resolutions.map((item) => item.baseline?.logLoss).filter(finite)),
      intervalCoverage: average(resolutions.map((item) => Number(item.intervalCovered))),
      reliabilityUp: bins.map(({ probabilitySum, hits, ...bin }) => ({ ...bin, meanProbability: bin.count ? probabilitySum / bin.count : null, observedFrequency: bin.count ? hits / bin.count : null })),
      llmWeight: 0, limitation: "Prospective observations only. No automatic promotion or accuracy claim; correlated instruments are not independent trials." };
  }
}
