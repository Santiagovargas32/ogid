import { fetchIntradayCandles } from "./marketProviderRouter.js";
import { candleIdentity, candleIntervalMs } from "./canonicalCandle.js";
import { isInstrumentSessionEligible, projectDailyCredits } from "./marketCreditScheduler.js";
import { resolveVerifiedInstrumentReferences } from "./instrumentRegistry.js";

const INTRADAY_BOOTSTRAP_OUTPUTSIZE = 500;

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
    this.store = store; this.marketConfig = marketConfig; this.now = now; this.inFlight = null; this.lastRunAt = 0; this.openCandles = new Map(); this.bootstrappedInstruments = new Set();
    this.metrics = { candlesRequested: 0, candlesStored: 0, duplicateCandles: 0, invalidCandles: 0, intradayCredits: 0, deferredByQuota: 0, bootstrapInstruments: 0, lastSuccessfulCandleAt: null, candleLag: null };
    this.projection = this.#project(this.enabledInstruments());
  }
  enabledInstruments() { const values = this.marketConfig.watchlistService?.selectedInstruments?.() || resolveVerifiedInstrumentReferences(this.marketConfig.tickers || []).instruments; const limit = Math.min(6, Math.max(1, Number(this.marketConfig.intradayCandles?.maxInstruments || 6))); return (this.marketConfig.watchlistService?.applySelection?.(values) || values).filter((instrument) => instrument.refreshTier === "hot").slice(0, limit); }
  #project(instruments) { return projectCombinedIntradayBudget({ instruments, policy: this.marketConfig.creditScheduler?.policy || this.marketConfig.creditPolicy, dailyCandlesEnabled: this.marketConfig.dailyCandles?.enabled !== false, interval: this.marketConfig.intradayCandles?.interval || "15min", requestedPollIntervalMs: this.marketConfig.intradayCandles?.pollIntervalMs || 900_000 }); }
  getMetrics() { return { ...structuredClone(this.metrics), projection: structuredClone(this.projection), openCandles: this.openCandles.size }; }
  staleCandles() { const nowMs = this.now().getTime(); return this.enabledInstruments().map((instrument) => this.store.latest(instrument.instrumentId, this.marketConfig.intradayCandles?.adjustmentMode || "splits", this.marketConfig.intradayCandles?.interval || "15min")).filter(Boolean).map((candle) => ({ ...candle, dataMode: "stale", quality: "stale-if-error", staleAgeMs: Math.max(0, nowMs - Date.parse(candle.closeTime)), provenance: { ...candle.provenance, stale: true } })); }
  async runScheduled() { if (this.inFlight) return this.inFlight; this.inFlight = this.#run(); try { return await this.inFlight; } finally { this.inFlight = null; } }
  async #run() {
    if (this.marketConfig.intradayCandles?.enabled !== true || this.store?.enabled === false) return { status: "disabled", metrics: this.getMetrics() };
    const enabledInstruments = this.enabledInstruments(); this.projection = this.#project(enabledInstruments);
    if (!this.projection.fits) { this.metrics.deferredByQuota += enabledInstruments.length; return { status: "deferred-projection", stale: this.staleCandles(), metrics: this.getMetrics() }; }
    const now = this.now(); if (this.lastRunAt && now.getTime() - this.lastRunAt < this.projection.effectivePollIntervalMs) return { status: "cadence", metrics: this.getMetrics() };
    const instruments = enabledInstruments.filter((instrument) => isInstrumentSessionEligible(instrument, now));
    if (!instruments.length) return { status: "market-closed", metrics: this.getMetrics() };
    const scheduler = this.marketConfig.creditScheduler; const interval = this.marketConfig.intradayCandles.interval; const adjustmentMode = this.marketConfig.intradayCandles.adjustmentMode || "splits"; const incrementalOutputsize = Math.min(100, Math.ceil(this.projection.effectivePollIntervalMs / candleIntervalMs(interval)) + 2); const bootstrapInstruments = []; const regularInstruments = [];
    for (const instrument of instruments) {
      const stored = this.store?.latest?.(instrument.instrumentId, adjustmentMode, interval);
      if (stored) this.bootstrappedInstruments.add(instrument.instrumentId);
      (this.bootstrappedInstruments.has(instrument.instrumentId) ? regularInstruments : bootstrapInstruments).push(instrument);
    }
    const groups = [
      { instruments: regularInstruments, outputsize: incrementalOutputsize, bootstrap: false },
      { instruments: bootstrapInstruments, outputsize: INTRADAY_BOOTSTRAP_OUTPUTSIZE, bootstrap: true }
    ].filter((group) => group.instruments.length);
    this.metrics.candlesRequested += instruments.length; this.lastRunAt = now.getTime();
    const fetches = [];
    for (const group of groups) {
      if (scheduler) {
        const cost = group.instruments.length * scheduler.policy.costPerSymbol + scheduler.policy.costPerOperation; const snapshot = scheduler.snapshot();
        if (snapshot.consumedMinute + cost > scheduler.policy.normalMinuteLimit) await scheduler.waitUntil(snapshot.nextMinuteAt);
      }
      const result = await fetchIntradayCandles({ ...this.marketConfig, instrumentIds: group.instruments.map((instrument) => instrument.instrumentId), interval, outputsize: group.outputsize, adjustmentMode, trigger: "scheduled-intraday-candles", timestamp: now.toISOString() }); fetches.push({ ...group, result });
      if (group.bootstrap) {
        const successfulIds = new Set(result.candles.map((candle) => candle.instrumentId));
        for (const instrument of group.instruments) if (successfulIds.has(instrument.instrumentId)) { this.bootstrappedInstruments.add(instrument.instrumentId); this.metrics.bootstrapInstruments += 1; }
      }
    }
    const result = { candles: fetches.flatMap((entry) => entry.result.candles), errors: fetches.flatMap((entry) => entry.result.errors), creditRejections: fetches.flatMap((entry) => entry.result.creditRejections), persistedByProvider: fetches.length > 0 && fetches.every((entry) => entry.result.persistedByProvider === true), persistence: fetches.reduce((total, entry) => ({ inserted: total.inserted + Number(entry.result.persistence?.inserted || 0), updated: total.updated + Number(entry.result.persistence?.updated || 0), duplicates: total.duplicates + Number(entry.result.persistence?.duplicates || 0), rejectedOpen: total.rejectedOpen + Number(entry.result.persistence?.rejectedOpen || 0) }), { inserted: 0, updated: 0, duplicates: 0, rejectedOpen: 0 }) };
    this.metrics.intradayCredits += scheduler ? fetches.reduce((total, entry) => entry.result.creditRejections.length ? total : total + entry.instruments.length * scheduler.policy.costPerSymbol + scheduler.policy.costPerOperation, 0) : 0; this.metrics.deferredByQuota += result.creditRejections.reduce((total, item) => total + (item.cost || 0), 0); this.metrics.invalidCandles += result.errors.filter((error) => error.code === "daily-candle-invalid").length;
    const closed = [];
    for (const candle of result.candles) { if (Date.parse(candle.closeTime) <= now.getTime()) { closed.push(candle); this.openCandles.delete(candleIdentity(candle)); } else this.openCandles.set(candleIdentity(candle), candle); }
    const persistence = result.persistedByProvider ? result.persistence : await this.store.append(closed, { now }); this.metrics.candlesStored += persistence.inserted; this.metrics.duplicateCandles += persistence.duplicates;
    const latest = closed.sort((a, b) => Date.parse(b.closeTime) - Date.parse(a.closeTime))[0]; if (latest) { this.metrics.lastSuccessfulCandleAt = latest.closeTime; this.metrics.candleLag = Math.max(0, now.getTime() - Date.parse(latest.closeTime)); }
    return { status: result.creditRejections.length ? "deferred-quota" : result.errors.length ? "partial" : "ok", stored: persistence.inserted, open: this.openCandles.size, stale: result.errors.length || result.creditRejections.length ? this.staleCandles() : [], errors: result.errors, creditRejections: result.creditRejections, metrics: this.getMetrics() };
  }
}
