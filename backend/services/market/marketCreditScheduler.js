import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isMarketOpenEt } from "./marketSessionService.js";

export const TWELVE_BASIC_POLICY = Object.freeze({
  declaredDailyLimit: 800,
  declaredMinuteLimit: 8,
  normalSoftLimit: 600,
  internalHardLimit: 700,
  reservedCapacity: 100,
  normalMinuteLimit: 7,
  absoluteMinuteLimit: 8,
  costPerOperation: 0,
  costPerSymbol: 1,
  documentation: "https://twelvedata.com/docs/advanced/api-usage",
  verifiedAt: "2026-07-11"
});

function positive(value, fallback) { const parsed = Number.parseInt(String(value ?? ""), 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function nonNegative(value, fallback) { const parsed = Number.parseInt(String(value ?? ""), 10); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function utcDayKey(nowMs) { return new Date(nowMs).toISOString().slice(0, 10); }
function minuteKey(nowMs) { return Math.floor(nowMs / 60_000); }
function nextMinuteMs(nowMs) { return (Math.floor(nowMs / 60_000) + 1) * 60_000; }
function nextDayMs(nowMs) { const date = new Date(nowMs); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1); }
function tierRank(tier) { return { hot: 0, normal: 1, background: 2 }[tier] ?? 1; }
export function isInstrumentSessionEligible(instrument, now = new Date()) {
  if (instrument?.assetType === "crypto" || instrument?.sessionPolicy === "24x7") return true;
  if (instrument?.sessionPolicy === "nyse-equities") return isMarketOpenEt(now);
  return false;
}

export function calculateTwelveCost(symbolCount, policy = TWELVE_BASIC_POLICY) {
  return nonNegative(policy.costPerOperation, 0) + Math.max(0, Number(symbolCount) || 0) * positive(policy.costPerSymbol, 1);
}

export function calculateMinimumSafeIntervalMs({ symbolCount = 7, sessionMinutes = 390, dailyBudget = 600, policy = TWELVE_BASIC_POLICY } = {}) {
  const cycles = Math.max(1, Math.floor(dailyBudget / Math.max(1, calculateTwelveCost(symbolCount, policy))));
  return Math.ceil(sessionMinutes / cycles) * 60_000;
}

export function projectDailyCredits(instruments = [], policy = TWELVE_BASIC_POLICY, { equitySessionMinutes = 390 } = {}) {
  const byInstrument = instruments.map((instrument) => {
    const intervalMinutes = Math.max(1, Number(instrument.minRefreshIntervalMs || 60_000) / 60_000);
    const activeMinutes = instrument.assetType === "crypto" || instrument.sessionPolicy === "24x7" ? 1_440 : equitySessionMinutes;
    const cycles = Math.ceil(activeMinutes / intervalMinutes);
    return { instrumentId: instrument.instrumentId, canonicalSymbol: instrument.canonicalSymbol, cycles, credits: cycles * calculateTwelveCost(1, { ...policy, costPerOperation: 0 }) };
  });
  return { instruments: byInstrument, scheduledCredits: byInstrument.reduce((total, item) => total + item.credits, 0), softLimit: policy.normalSoftLimit, hardLimit: policy.internalHardLimit, reservedCapacity: policy.reservedCapacity };
}

export class MarketCreditScheduler {
  constructor({ policy = {}, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), persistencePath = null } = {}) {
    this.policy = { ...TWELVE_BASIC_POLICY, ...policy };
    this.now = now; this.sleep = sleep; this.persistencePath = persistencePath;
    this.inFlight = new Map();
    this.state = { dayKey: utcDayKey(this.now()), minuteKey: minuteKey(this.now()), consumedDay: 0, consumedMinute: 0, leases: [], lastScheduledAt: {}, observed: {}, metrics: { predicted: 0, consumed: 0, reserved: 0, rejected: 0, deduplicated: 0 } };
    this.hydrate(); this.rollover();
  }
  rollover(nowMs = this.now()) {
    const day = utcDayKey(nowMs); const minute = minuteKey(nowMs);
    if (this.state.dayKey !== day) { this.state.dayKey = day; this.state.consumedDay = 0; this.state.leases = []; this.state.metrics = { predicted: 0, consumed: 0, reserved: 0, rejected: 0, deduplicated: 0 }; }
    if (this.state.minuteKey !== minute) { this.state.minuteKey = minute; this.state.consumedMinute = 0; }
  }
  limitsFor(tier = "normal", trigger = "scheduled") {
    const privileged = tier === "hot" || String(trigger).includes("manual");
    return { day: privileged ? this.policy.internalHardLimit : this.policy.normalSoftLimit, minute: privileged ? this.policy.absoluteMinuteLimit : this.policy.normalMinuteLimit };
  }
  snapshot(nowMs = this.now()) {
    this.rollover(nowMs); return { ...structuredClone(this.state), policy: structuredClone(this.policy), reservedRemaining: Math.max(0, this.policy.internalHardLimit - Math.max(this.policy.normalSoftLimit, this.state.consumedDay)), nextMinuteAt: new Date(nextMinuteMs(nowMs)).toISOString(), nextDayAt: new Date(nextDayMs(nowMs)).toISOString() };
  }
  acquireLease({ symbols = [], instrumentIds = [], tier = "normal", trigger = "scheduled", operation = "quote", nowMs = this.now() } = {}) {
    this.rollover(nowMs); const cost = calculateTwelveCost(symbols.length, this.policy); const limits = this.limitsFor(tier, trigger);
    this.state.metrics.predicted += cost;
    if (Number(this.state.blockedUntil || 0) > nowMs) { this.state.metrics.rejected += cost; return { accepted: false, reason: "retry-after", cost, nextEligibleAt: new Date(this.state.blockedUntil).toISOString() }; }
    if (this.state.consumedDay + cost > Math.min(limits.day, this.policy.internalHardLimit) || this.state.consumedMinute + cost > Math.min(limits.minute, this.policy.absoluteMinuteLimit)) {
      this.state.metrics.rejected += cost; this.persist();
      const minuteBlocked = this.state.consumedMinute + cost > limits.minute;
      return { accepted: false, reason: minuteBlocked ? "minute-budget-exhausted" : "daily-budget-exhausted", cost, nextEligibleAt: new Date(minuteBlocked ? nextMinuteMs(nowMs) : nextDayMs(nowMs)).toISOString() };
    }
    const lease = { leaseId: randomUUID(), provider: "twelve", operation, symbols: [...symbols], instrumentIds: [...instrumentIds], tier, trigger, cost, acquiredAt: new Date(nowMs).toISOString(), status: "leased" };
    if (operation === "quote") for (const instrumentId of instrumentIds) this.state.lastScheduledAt[instrumentId] = nowMs;
    this.state.consumedDay += cost; this.state.consumedMinute += cost; this.state.metrics.consumed += cost; this.state.metrics.reserved = Math.max(this.state.metrics.reserved, Math.max(0, this.state.consumedDay - this.policy.normalSoftLimit)); this.state.leases.push(lease); this.persist();
    return { accepted: true, lease: structuredClone(lease), snapshot: this.snapshot(nowMs) };
  }
  commitLease(leaseId, { headers = null, status = "success" } = {}) {
    const lease = this.state.leases.find((entry) => entry.leaseId === leaseId); if (!lease) return null;
    lease.status = status; lease.committedAt = new Date(this.now()).toISOString();
    const get = (name) => headers?.get?.(name) ?? headers?.[name] ?? null;
    const used = nonNegative(get("api-credits-used"), null); const left = nonNegative(get("api-credits-left"), null);
    if (Number.isFinite(used)) this.state.observed.creditsUsed = used;
    if (Number.isFinite(left)) this.state.observed.creditsLeft = left;
    const retryAfter = get("retry-after");
    if (retryAfter != null) { const seconds = Number(retryAfter); const dateMs = Date.parse(String(retryAfter)); this.state.blockedUntil = Number.isFinite(seconds) ? this.now() + Math.max(0, seconds * 1_000) : Number.isFinite(dateMs) ? dateMs : null; }
    this.persist(); return structuredClone(lease);
  }
  plan({ instruments = [], trigger = "scheduled", nowMs = this.now() } = {}) {
    this.rollover(nowMs);
    const automated = /scheduled|interval|startup/.test(String(trigger));
    const sessionOmitted = automated ? instruments.filter((instrument) => !isInstrumentSessionEligible(instrument, new Date(nowMs))) : [];
    this.state.lastScheduledAt ||= {};
    const cadenceOmitted = String(trigger).includes("manual") ? [] : instruments.filter((instrument) => {
      const lastScheduledAt = Number(this.state.lastScheduledAt[instrument.instrumentId] || 0);
      return lastScheduledAt > 0 && nowMs < lastScheduledAt + Math.max(0, Number(instrument.minRefreshIntervalMs || 0));
    });
    const omittedIds = new Set([...sessionOmitted, ...cadenceOmitted].map((instrument) => instrument.instrumentId));
    const ordered = instruments.filter((instrument) => !omittedIds.has(instrument.instrumentId)).sort((left, right) => tierRank(left.refreshTier) - tierRank(right.refreshTier));
    const hot = ordered.filter((item) => item.refreshTier === "hot"); const normal = ordered.filter((item) => item.refreshTier !== "hot" && item.refreshTier !== "background"); const background = ordered.filter((item) => item.refreshTier === "background");
    const privileged = String(trigger).includes("manual"); const hardRemaining = Math.max(0, this.policy.internalHardLimit - this.state.consumedDay); const normalRemaining = Math.max(0, this.policy.normalSoftLimit - this.state.consumedDay);
    let hardAvailable = hardRemaining; let normalAvailable = privileged ? hardRemaining : normalRemaining; const selected = []; const omitted = sessionOmitted.map((instrument) => ({ instrumentId: instrument.instrumentId, reason: "market-closed" }));
    omitted.push(...cadenceOmitted.filter((instrument) => !sessionOmitted.includes(instrument)).map((instrument) => ({ instrumentId: instrument.instrumentId, reason: "cadence", nextEligibleAt: new Date(Number(this.state.lastScheduledAt[instrument.instrumentId]) + Number(instrument.minRefreshIntervalMs || 0)).toISOString() })));
    for (const group of [hot, normal, background]) for (const instrument of group) {
      const cost = calculateTwelveCost(1, this.policy); const mayUseReserve = privileged || group === hot; const available = mayUseReserve ? hardAvailable : normalAvailable;
      if (available >= cost) { selected.push(instrument); hardAvailable -= cost; normalAvailable = Math.max(0, normalAvailable - cost); }
      else omitted.push({ instrumentId: instrument.instrumentId, reason: group === background ? "soft-limit-background-degraded" : group === normal ? "soft-limit-normal-degraded" : "hard-limit" });
    }
    const minuteLimit = privileged ? this.policy.absoluteMinuteLimit : this.policy.normalMinuteLimit; const batches = [];
    for (const instrument of selected) {
      let batch = batches.at(-1); const candidateSize = (batch?.instruments.length || 0) + 1;
      if (!batch || calculateTwelveCost(candidateSize, this.policy) > minuteLimit) {
        batch = { instruments: [], tier: "normal", predictedCredits: 0, scheduledAt: new Date(batches.length === 0 ? nowMs : nextMinuteMs(nowMs) + (batches.length - 1) * 60_000).toISOString() };
        batches.push(batch);
      }
      batch.instruments.push(instrument); batch.tier = batch.instruments.some((item) => item.refreshTier === "hot") ? "hot" : "normal"; batch.predictedCredits = calculateTwelveCost(batch.instruments.length, this.policy);
    }
    const predictedCreditsDay = batches.reduce((total, batch) => total + batch.predictedCredits, 0);
    const cadenceNext = omitted.map((item) => Date.parse(item.nextEligibleAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    return { provider: "twelve", trigger, predictedCreditsMinute: batches[0]?.predictedCredits || 0, predictedCreditsDay, worstCaseCredits: predictedCreditsDay, consumedDay: this.state.consumedDay, consumedMinute: this.state.consumedMinute, nextValidExecutionAt: batches[0]?.scheduledAt || new Date(cadenceNext || nextDayMs(nowMs)).toISOString(), omitted, batches, policy: structuredClone(this.policy) };
  }
  async waitUntil(isoTimestamp) { const delay = new Date(isoTimestamp).getTime() - this.now(); if (delay > 0) await this.sleep(delay); }
  async deduplicate(key, task) { if (this.inFlight.has(key)) { this.state.metrics.deduplicated += 1; return this.inFlight.get(key); } const promise = Promise.resolve().then(task); this.inFlight.set(key, promise); try { return await promise; } finally { this.inFlight.delete(key); } }
  persist() { if (!this.persistencePath) return; mkdirSync(dirname(this.persistencePath), { recursive: true }); const temp = `${this.persistencePath}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify({ version: 1, state: this.state }), { mode: 0o600 }); renameSync(temp, this.persistencePath); }
  hydrate() { if (!this.persistencePath) return false; try { const payload = JSON.parse(readFileSync(this.persistencePath, "utf8")); if (payload?.version === 1 && payload.state) this.state = { ...this.state, ...payload.state, lastScheduledAt: payload.state.lastScheduledAt || {} }; return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
}
