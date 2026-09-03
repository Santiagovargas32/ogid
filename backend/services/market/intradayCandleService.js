import { fetchIntradayCandles } from "./marketProviderRouter.js";
import { candleIdentity, candleIntervalMs } from "./canonicalCandle.js";
import { isInstrumentSessionEligible, projectDailyCredits } from "./marketCreditScheduler.js";
import { resolveVerifiedInstrumentReferences } from "./instrumentRegistry.js";
import { sessionPolicyResolver } from "./sessionPolicyResolver.js";

const INTRADAY_BOOTSTRAP_OUTPUTSIZE = 500;
const INTRADAY_BOOTSTRAP_MIN_CANDLES = 420;
const INTRADAY_INCREMENTAL_OVERLAP_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const MAX_SHORT_INTRADAY_RANGE_MS = 30 * DAY_MS;
const MAX_HOURLY_RANGE_MS = 365 * DAY_MS;

function isYahooProvider(marketConfig = {}) {
  return String(marketConfig.provider || "twelve").trim().toLowerCase() === "yahoo";
}

function resolveBootstrapStart({ instrument, intervalMs, nowMs, targetBars, maximumMs }) {
  const lowerBound = nowMs - maximumMs;
  let cursor = Math.floor(nowMs / intervalMs) * intervalMs;
  let eligibleBars = 0;
  while (cursor > lowerBound && eligibleBars < targetBars) {
    cursor -= intervalMs;
    if (sessionPolicyResolver.resolve(instrument, cursor, { intervalMs }).eligible) eligibleBars += 1;
  }
  return cursor;
}

export function resolveIntradayFetchRange({ instrument, interval = "5min", latestCandle = null, now = new Date() } = {}) {
  const nowDate = now instanceof Date ? new Date(now) : new Date(now);
  const nowMs = nowDate.getTime();
  const intervalMs = candleIntervalMs(interval);
  if (!Number.isFinite(nowMs) || !intervalMs || interval === "1day") throw new TypeError("A valid intraday interval and clock are required");
  const maximumMs = intervalMs <= 1_800_000 ? MAX_SHORT_INTRADAY_RANGE_MS : MAX_HOURLY_RANGE_MS;
  const latestMs = Date.parse(latestCandle?.openTime || latestCandle?.closeTime || "");
  if (Number.isFinite(latestMs)) {
    return {
      phase: "incremental",
      from: new Date(Math.max(nowMs - maximumMs, Math.min(nowMs - intervalMs, latestMs - INTRADAY_INCREMENTAL_OVERLAP_MS))).toISOString(),
      to: nowDate.toISOString(),
      targetBars: null,
    };
  }
  const fromMs = resolveBootstrapStart({
    instrument,
    intervalMs,
    nowMs,
    targetBars: INTRADAY_BOOTSTRAP_OUTPUTSIZE,
    maximumMs
  });
  return {
    phase: "bootstrap",
    from: new Date(fromMs).toISOString(),
    to: nowDate.toISOString(),
    targetBars: INTRADAY_BOOTSTRAP_OUTPUTSIZE,
  };
}

function emptyPersistence() {
  return { inserted: 0, updated: 0, duplicates: 0, rejectedOpen: 0 };
}

function combinePersistence(total, value = {}) {
  return {
    inserted: total.inserted + Number(value.inserted || 0),
    updated: total.updated + Number(value.updated || 0),
    duplicates: total.duplicates + Number(value.duplicates || 0),
    rejectedOpen: total.rejectedOpen + Number(value.rejectedOpen || 0),
  };
}

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
  while (pollMinutes <= 1_440) { intradayCredits = hot.reduce((total, instrument) => total + Math.ceil(sessionPolicyResolver.projectedActiveMinutes(instrument, { cashSessionMinutes: equitySessionMinutes }) / pollMinutes) * policy.costPerSymbol, 0); if (intradayCredits <= available) break; pollMinutes += intervalMinutes; }
  const fits = intradayCredits <= available;
  return { quoteCredits: quoteProjection.scheduledCredits, dailyCredits, intradayCredits: fits ? intradayCredits : 0, combinedCredits: quoteProjection.scheduledCredits + dailyCredits + (fits ? intradayCredits : 0), availableIntradayCredits: available, interval, requestedPollIntervalMs, effectivePollIntervalMs: fits ? pollMinutes * 60_000 : null, hotInstrumentCount: hot.length, softLimit: policy.normalSoftLimit, hardLimit: policy.internalHardLimit, fits };
}

export class IntradayCandleService {
  constructor({ store, marketConfig = {}, now = () => new Date() } = {}) {
    this.store = store; this.marketConfig = marketConfig; this.now = now; this.inFlight = null; this.lastRunAt = 0; this.openCandles = new Map(); this.bootstrappedInstruments = new Set();
    this.fairnessCursor = 0; this.instrumentStates = new Map(); this.stateRevision = 0;
    this.metrics = { candlesRequested: 0, candlesStored: 0, duplicateCandles: 0, invalidCandles: 0, intradayCredits: 0, deferredByQuota: 0, bootstrapInstruments: 0, lastSuccessfulCandleAt: null, candleLag: null };
    this.projection = this.#project(this.enabledInstruments());
  }
  enabledInstruments() { const values = this.marketConfig.watchlistService?.selectedInstruments?.() || resolveVerifiedInstrumentReferences(this.marketConfig.tickers || []).instruments; return (this.marketConfig.watchlistService?.applySelection?.(values) || values).filter((instrument) => instrument.refreshTier === "hot"); }
  #project(instruments) { return projectCombinedIntradayBudget({ instruments, policy: isYahooProvider(this.marketConfig) ? null : this.marketConfig.creditScheduler?.policy || this.marketConfig.creditPolicy, dailyCandlesEnabled: this.marketConfig.dailyCandles?.enabled !== false, interval: this.marketConfig.intradayCandles?.interval || "15min", requestedPollIntervalMs: this.marketConfig.intradayCandles?.pollIntervalMs || 900_000 }); }
  getMetrics() { const selectedIds = new Set(this.enabledInstruments().map((instrument) => instrument.instrumentId)); return { ...structuredClone(this.metrics), projection: structuredClone(this.projection), openCandles: this.openCandles.size, stateRevision: this.stateRevision, instrumentStates: [...this.instrumentStates.values()].filter((value) => selectedIds.has(value.instrumentId)).map((value) => structuredClone(value)) }; }
  staleCandles() { const nowMs = this.now().getTime(); return this.enabledInstruments().map((instrument) => this.store.latest(instrument.instrumentId, this.marketConfig.intradayCandles?.adjustmentMode || "splits", this.marketConfig.intradayCandles?.interval || "15min")).filter(Boolean).map((candle) => ({ ...candle, dataMode: "stale", quality: "stale-if-error", staleAgeMs: Math.max(0, nowMs - Date.parse(candle.closeTime)), provenance: { ...candle.provenance, stale: true } })); }
  async runScheduled() { if (this.inFlight) return this.inFlight; this.inFlight = this.#run(); try { return await this.inFlight; } finally { this.inFlight = null; } }
  async #run() {
    if (this.marketConfig.intradayCandles?.enabled !== true || this.store?.enabled === false) return { status: "disabled", metrics: this.getMetrics() };
    const enabledInstruments = this.enabledInstruments(); this.#syncUniverse(enabledInstruments); this.projection = this.#project(enabledInstruments);
    if (!this.projection.fits) { this.metrics.deferredByQuota += enabledInstruments.length; return { status: "deferred-projection", stale: this.staleCandles(), metrics: this.getMetrics() }; }
    const now = this.now(); if (this.lastRunAt && now.getTime() - this.lastRunAt < this.projection.effectivePollIntervalMs) return { status: "cadence", metrics: this.getMetrics() };
    const instruments = enabledInstruments.filter((instrument) => {
      const eligible = isInstrumentSessionEligible(instrument, now);
      if (!eligible) this.#setInstrumentState(instrument, { state: "session_closed" });
      return eligible;
    });
    if (!instruments.length) return { status: "market-closed", metrics: this.getMetrics() };
    if (isYahooProvider(this.marketConfig)) return this.#runYahoo(instruments, now);
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

  async #runYahoo(instruments, now) {
    const interval = this.marketConfig.intradayCandles.interval;
    const adjustmentMode = this.marketConfig.intradayCandles.adjustmentMode || "splits";
    const ordered = this.#fairOrder(instruments);
    const plans = ordered.map((instrument) => {
      const latestCandle = this.store?.latest?.(instrument.instrumentId, adjustmentMode, interval) || null;
      const localCoverage = this.store?.query?.({ instrumentId: instrument.instrumentId, adjustmentMode, interval, limit: INTRADAY_BOOTSTRAP_OUTPUTSIZE })?.length || 0;
      const bootstrapComplete = localCoverage >= INTRADAY_BOOTSTRAP_MIN_CANDLES;
      if (bootstrapComplete) this.bootstrappedInstruments.add(instrument.instrumentId);
      const bootstrapPreviouslyAttempted = this.bootstrappedInstruments.has(instrument.instrumentId);
      const range = resolveIntradayFetchRange({ instrument, interval, latestCandle: bootstrapPreviouslyAttempted ? latestCandle : null, now });
      this.#setInstrumentState(instrument, {
        state: range.phase === "bootstrap" ? "pending_bootstrap" : "queued",
        phase: range.phase,
        localCandleCount: localCoverage,
        lastClosedCandleAt: latestCandle?.closeTime || null,
        from: range.from,
        to: range.to,
        lastAttemptAt: now.toISOString(),
        retryAfterMs: null,
      });
      return { instrument, range };
    });

    this.metrics.candlesRequested += plans.length;
    this.lastRunAt = now.getTime();
    const settled = await Promise.allSettled(plans.map(async ({ instrument, range }) => ({
      instrument,
      range,
      result: await fetchIntradayCandles({
        ...this.marketConfig,
        instrumentIds: [instrument.instrumentId],
        interval,
        outputsize: range.targetBars || undefined,
        from: range.from,
        to: range.to,
        force: true,
        adjustmentMode,
        trigger: range.phase === "bootstrap" ? "intraday-bootstrap" : "scheduled-intraday-candles",
        timestamp: now.toISOString(),
      }),
    })));
    const fetches = settled.map((entry, index) => entry.status === "fulfilled" ? entry.value : {
      instrument: plans[index].instrument,
      range: plans[index].range,
      result: {
        candles: [],
        errors: [{ code: "yahoo-request-failed", instrumentId: plans[index].instrument.instrumentId, message: "Yahoo intraday request failed." }],
        creditRejections: [],
        persistedByProvider: true,
        persistence: emptyPersistence(),
      },
    });
    const result = {
      candles: fetches.flatMap((entry) => entry.result.candles || []),
      errors: fetches.flatMap((entry) => entry.result.errors || []),
      creditRejections: [],
      persistedByProvider: fetches.length > 0 && fetches.every((entry) => entry.result.persistedByProvider === true),
      persistence: fetches.reduce((total, entry) => combinePersistence(total, entry.result.persistence), emptyPersistence()),
    };

    for (const entry of fetches) {
      const instrumentId = entry.instrument.instrumentId;
      const instrumentCandles = (entry.result.candles || []).filter((candle) => candle.instrumentId === instrumentId && Date.parse(candle.closeTime) <= now.getTime());
      const errors = entry.result.errors || [];
      const retryAfterMs = Math.max(0, ...errors.map((error) => Number(error.retryAfterMs || 0)).filter(Number.isFinite));
      if (instrumentCandles.length > 0 && errors.length === 0) {
        const latest = instrumentCandles.sort((left, right) => Date.parse(right.closeTime) - Date.parse(left.closeTime))[0];
        const localCoverage = this.store?.query?.({ instrumentId, adjustmentMode, interval, limit: INTRADAY_BOOTSTRAP_OUTPUTSIZE })?.length || 0;
        const bootstrapComplete = localCoverage >= INTRADAY_BOOTSTRAP_MIN_CANDLES;
        if (entry.range.phase === "bootstrap" && !this.bootstrappedInstruments.has(instrumentId)) this.metrics.bootstrapInstruments += 1;
        this.bootstrappedInstruments.add(instrumentId);
        this.#setInstrumentState(entry.instrument, { state: bootstrapComplete ? "ready" : "pending_bootstrap", localCandleCount: localCoverage, lastClosedCandleAt: latest.closeTime, lastSuccessAt: now.toISOString(), retryAfterMs: null });
      } else if (retryAfterMs > 0 || errors.some((error) => error.code === "YAHOO_RATE_LIMITED" || Number(error.status) === 429)) {
        this.#setInstrumentState(entry.instrument, { state: "provider_cooldown", retryAfterMs: retryAfterMs || null });
      } else if (errors.length > 0) {
        this.#setInstrumentState(entry.instrument, { state: "fetch_error", retryAfterMs: null });
      }
    }

    this.metrics.invalidCandles += result.errors.filter((error) => error.code === "daily-candle-invalid").length;
    const closed = [];
    for (const candle of result.candles) {
      if (Date.parse(candle.closeTime) <= now.getTime()) { closed.push(candle); this.openCandles.delete(candleIdentity(candle)); }
      else this.openCandles.set(candleIdentity(candle), candle);
    }
    const persistence = result.persistedByProvider ? result.persistence : await this.store.upsert(closed, { now });
    this.metrics.candlesStored += persistence.inserted;
    this.metrics.duplicateCandles += persistence.duplicates;
    const latest = closed.sort((left, right) => Date.parse(right.closeTime) - Date.parse(left.closeTime))[0];
    if (latest) {
      this.metrics.lastSuccessfulCandleAt = latest.closeTime;
      this.metrics.candleLag = Math.max(0, now.getTime() - Date.parse(latest.closeTime));
    }
    const providerDeferred = result.errors.some((error) => error.code === "YAHOO_RATE_LIMITED" || Number(error.status) === 429 || Number(error.retryAfterMs) > 0);
    return {
      status: providerDeferred ? "provider-cooldown" : result.errors.length ? "partial" : "ok",
      stored: persistence.inserted,
      open: this.openCandles.size,
      stale: result.errors.length ? this.staleCandles() : [],
      errors: result.errors,
      creditRejections: [],
      metrics: this.getMetrics(),
    };
  }

  #fairOrder(instruments) {
    if (instruments.length < 2) return instruments;
    const start = this.fairnessCursor % instruments.length;
    this.fairnessCursor = (start + 1) % instruments.length;
    return [...instruments.slice(start), ...instruments.slice(0, start)];
  }

  #setInstrumentState(instrument, patch) {
    const previous = this.instrumentStates.get(instrument.instrumentId) || {
      instrumentId: instrument.instrumentId,
      state: "pending_bootstrap",
      phase: "bootstrap",
      localCandleCount: 0,
      lastClosedCandleAt: null,
      from: null,
      to: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      retryAfterMs: null,
    };
    this.instrumentStates.set(instrument.instrumentId, { ...previous, ...patch });
    this.stateRevision += 1;
  }

  #syncUniverse(instruments) {
    const selectedIds = new Set(instruments.map((instrument) => instrument.instrumentId));
    for (const instrumentId of [...this.instrumentStates.keys()]) {
      if (!selectedIds.has(instrumentId)) {
        this.instrumentStates.delete(instrumentId);
        this.stateRevision += 1;
      }
    }
    for (const instrumentId of [...this.bootstrappedInstruments]) {
      if (!selectedIds.has(instrumentId)) this.bootstrappedInstruments.delete(instrumentId);
    }
  }
}
