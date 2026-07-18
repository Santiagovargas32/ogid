import { fetchIntradayCandles } from "./marketProviderRouter.js";
import { candleIdentity, candleIntervalMs } from "./canonicalCandle.js";
import { isInstrumentSessionEligible, projectDailyCredits } from "./marketCreditScheduler.js";
import { resolveVerifiedInstrumentReferences } from "./instrumentRegistry.js";

export function projectCombinedIntradayBudget({ instruments = [], policy, dailyCandlesEnabled = true, interval = "15min", requestedPollIntervalMs = 900_000, equitySessionMinutes = 390 } = {}) {
  if (!policy) {
    const intervalMs = candleIntervalMs(interval);
    const effectivePollIntervalMs = intervalMs
      ? Math.max(intervalMs, Number(requestedPollIntervalMs) || intervalMs)
      : null;
    return {
      quoteCredits: 0,
      dailyCredits: 0,
      intradayCredits: 0,
      combinedCredits: 0,
      availableIntradayCredits: null,
      interval,
      requestedPollIntervalMs,
      effectivePollIntervalMs,
      hotInstrumentCount: instruments.filter((instrument) => instrument.refreshTier === "hot").length,
      softLimit: null,
      hardLimit: null,
      fits: Boolean(effectivePollIntervalMs),
      metered: false
    };
  }
  const quoteProjection = projectDailyCredits(instruments, policy, { equitySessionMinutes }); const hot = instruments.filter((instrument) => instrument.refreshTier === "hot"); const dailyCredits = dailyCandlesEnabled ? instruments.length * policy.costPerSymbol : 0; const available = Math.max(0, policy.normalSoftLimit - quoteProjection.scheduledCredits - dailyCredits); const intervalMinutes = candleIntervalMs(interval) / 60_000;
  let pollMinutes = Math.max(intervalMinutes, Number(requestedPollIntervalMs) / 60_000); let intradayCredits = Infinity;
  while (pollMinutes <= 1_440) { intradayCredits = hot.reduce((total, instrument) => total + Math.ceil((instrument.sessionPolicy === "24x7" ? 1_440 : equitySessionMinutes) / pollMinutes) * policy.costPerSymbol, 0); if (intradayCredits <= available) break; pollMinutes += intervalMinutes; }
  const fits = intradayCredits <= available;
  return { quoteCredits: quoteProjection.scheduledCredits, dailyCredits, intradayCredits: fits ? intradayCredits : 0, combinedCredits: quoteProjection.scheduledCredits + dailyCredits + (fits ? intradayCredits : 0), availableIntradayCredits: available, interval, requestedPollIntervalMs, effectivePollIntervalMs: fits ? pollMinutes * 60_000 : null, hotInstrumentCount: hot.length, softLimit: policy.normalSoftLimit, hardLimit: policy.internalHardLimit, fits };
}

export class IntradayCandleService {
  constructor({ store, marketConfig = {}, now = () => new Date() } = {}) {
    this.store = store; this.marketConfig = marketConfig; this.now = now; this.inFlight = null; this.lastRunAt = 0; this.openCandles = new Map();
    this.metrics = { candlesRequested: 0, candlesStored: 0, duplicateCandles: 0, invalidCandles: 0, intradayCredits: 0, deferredByQuota: 0, lastSuccessfulCandleAt: null, candleLag: null };
    this.projection = projectCombinedIntradayBudget({ instruments: this.enabledInstruments(), policy: marketConfig.creditScheduler?.policy || marketConfig.creditPolicy, dailyCandlesEnabled: marketConfig.dailyCandles?.enabled !== false, interval: marketConfig.intradayCandles?.interval || "15min", requestedPollIntervalMs: marketConfig.intradayCandles?.pollIntervalMs || 900_000 });
  }
  enabledInstruments() { const values = this.marketConfig.watchlistService?.selectedInstruments?.() || resolveVerifiedInstrumentReferences(this.marketConfig.tickers || []).instruments; return (this.marketConfig.watchlistService?.applySelection?.(values) || values).filter((instrument) => instrument.refreshTier === "hot"); }
  getMetrics() { return { ...structuredClone(this.metrics), projection: structuredClone(this.projection), openCandles: this.openCandles.size }; }
  staleCandles() { const nowMs = this.now().getTime(); return this.enabledInstruments().map((instrument) => this.store.latest(instrument.instrumentId, this.marketConfig.intradayCandles?.adjustmentMode || "splits", this.marketConfig.intradayCandles?.interval || "15min")).filter(Boolean).map((candle) => ({ ...candle, dataMode: "stale", quality: "stale-if-error", staleAgeMs: Math.max(0, nowMs - Date.parse(candle.closeTime)), provenance: { ...candle.provenance, stale: true } })); }
  async runScheduled() { if (this.inFlight) return this.inFlight; this.inFlight = this.#run(); try { return await this.inFlight; } finally { this.inFlight = null; } }
  async #run() {
    if (this.marketConfig.intradayCandles?.enabled !== true || this.store?.enabled === false) return { status: "disabled", metrics: this.getMetrics() };
    if (!this.projection.fits) { this.metrics.deferredByQuota += this.enabledInstruments().length; return { status: "deferred-projection", stale: this.staleCandles(), metrics: this.getMetrics() }; }
    const now = this.now(); if (this.lastRunAt && now.getTime() - this.lastRunAt < this.projection.effectivePollIntervalMs) return { status: "cadence", metrics: this.getMetrics() };
    const instruments = this.enabledInstruments().filter((instrument) => isInstrumentSessionEligible(instrument, now));
    if (!instruments.length) return { status: "market-closed", metrics: this.getMetrics() };
    const scheduler = this.marketConfig.creditScheduler;
    if (scheduler) {
      const cost = instruments.length * scheduler.policy.costPerSymbol + scheduler.policy.costPerOperation;
      const snapshot = scheduler.snapshot();
      if (snapshot.consumedMinute + cost > scheduler.policy.normalMinuteLimit) await scheduler.waitUntil(snapshot.nextMinuteAt);
    }
    const interval = this.marketConfig.intradayCandles.interval; const outputsize = Math.min(100, Math.ceil(this.projection.effectivePollIntervalMs / candleIntervalMs(interval)) + 2);
    this.metrics.candlesRequested += instruments.length; this.lastRunAt = now.getTime();
    const result = await fetchIntradayCandles({ ...this.marketConfig, instrumentIds: instruments.map((instrument) => instrument.instrumentId), interval, outputsize, adjustmentMode: this.marketConfig.intradayCandles.adjustmentMode || "splits", trigger: "scheduled-intraday-candles", timestamp: now.toISOString() });
    this.metrics.intradayCredits += scheduler && !result.creditRejections.length ? instruments.length : 0; this.metrics.deferredByQuota += result.creditRejections.reduce((total, item) => total + (item.cost || 0), 0); this.metrics.invalidCandles += result.errors.filter((error) => error.code === "daily-candle-invalid").length;
    const closed = [];
    for (const candle of result.candles) { if (Date.parse(candle.closeTime) <= now.getTime()) { closed.push(candle); this.openCandles.delete(candleIdentity(candle)); } else this.openCandles.set(candleIdentity(candle), candle); }
    const persistence = result.persistedByProvider ? result.persistence : await this.store.append(closed, { now }); this.metrics.candlesStored += persistence.inserted; this.metrics.duplicateCandles += persistence.duplicates;
    const latest = closed.sort((a, b) => Date.parse(b.closeTime) - Date.parse(a.closeTime))[0]; if (latest) { this.metrics.lastSuccessfulCandleAt = latest.closeTime; this.metrics.candleLag = Math.max(0, now.getTime() - Date.parse(latest.closeTime)); }
    return { status: result.creditRejections.length ? "deferred-quota" : result.errors.length ? "partial" : "ok", stored: persistence.inserted, open: this.openCandles.size, stale: result.errors.length || result.creditRejections.length ? this.staleCandles() : [], errors: result.errors, creditRejections: result.creditRejections, metrics: this.getMetrics() };
  }
}
