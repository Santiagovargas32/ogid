import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getProviderPolicy } from "../providers/providerPolicies.js";

const WINDOW_MS = 24 * 60 * 60 * 1_000;
const RETENTION_MS = 32 * WINDOW_MS;
const MINUTE_WINDOW_MS = 60 * 1_000;
const PROVIDERS = ["newsapi", "gnews", "mediastack", "rss", "gdelt", "twelve", "yahoo"];
const PROVIDER_LIMIT_FIELDS = Object.freeze({
  newsapi: {
    hardDaily: "newsapiDailyLimit",
    budgetDaily: "newsapiDailyBudget"
  },
  gnews: {
    hardDaily: "gnewsDailyLimit",
    budgetDaily: "gnewsDailyBudget"
  },
  mediastack: {
    hardMonthly: "mediastackMonthlyLimit",
    budgetMonthly: "mediastackMonthlyBudget"
  },
  rss: {
    hardDaily: "rssDailyLimit",
    budgetDaily: "rssDailyBudget"
  },
  gdelt: {
    hardDaily: "gdeltDailyLimit",
    budgetDaily: "gdeltDailyBudget"
  },
  twelve: {
    hardDaily: "twelveDailyLimit",
    budgetDaily: "twelveDailyBudget",
    hardMinute: "twelveMinuteLimit",
    budgetMinute: "twelveMinuteBudget"
  },
  yahoo: {
    hardDaily: "yahooDailyLimit",
    budgetDaily: "yahooDailyBudget"
  }
});

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toNonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function createEventBucket() {
  return [];
}

function createProviderState({
  hardDailyLimit = null,
  hardMonthlyLimit = null,
  hardMinuteLimit = null,
  budgetDailyLimit = null,
  budgetMonthlyLimit = null,
  budgetMinuteLimit = null
} = {}) {
  return {
    hardDailyLimit,
    hardMonthlyLimit,
    hardMinuteLimit,
    budgetDailyLimit,
    budgetMonthlyLimit,
    budgetMinuteLimit,
    headerLimit: null,
    headerRemaining: null,
    apiCreditsUsed: null,
    apiCreditsLeft: null,
    lastCallAt: null,
    lastStatus: "idle",
    events: {
      calls: createEventBucket(),
      success: createEventBucket(),
      errors: createEventBucket(),
      fallback: createEventBucket()
    }
  };
}

function pushEvent(bucket, timestampMs, units = 1) {
  bucket.push({
    timestampMs,
    units: Math.max(0, Number.parseInt(String(units ?? 1), 10) || 1)
  });
}

function purgeBucket(bucket, minTs) {
  while (bucket.length && bucket[0].timestampMs < minTs) {
    bucket.shift();
  }
}

function countEventsSince(bucket = [], minTs = 0) {
  return bucket.reduce((total, entry) => total + (entry.timestampMs >= minTs ? 1 : 0), 0);
}

function sumUnitsSince(bucket = [], minTs = 0) {
  return bucket.reduce((total, entry) => total + (entry.timestampMs >= minTs ? Number(entry.units || 0) : 0), 0);
}

function resolveMinuteResetAt(nowMs = Date.now()) {
  return new Date(Math.floor(nowMs / MINUTE_WINDOW_MS) * MINUTE_WINDOW_MS + MINUTE_WINDOW_MS).toISOString();
}

function resolveUtcMidnightResetAt(nowMs = Date.now()) {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)).toISOString();
}

function parseRateLimitHeaders(headers = {}) {
  if (headers && typeof headers === "object" && ("headerLimit" in headers || "headerRemaining" in headers)) {
    return {
      headerLimit: toPositiveInt(headers.headerLimit),
      headerRemaining: toNonNegativeInt(headers.headerRemaining),
      apiCreditsUsed: toNonNegativeInt(headers.apiCreditsUsed),
      apiCreditsLeft: toNonNegativeInt(headers.apiCreditsLeft)
    };
  }

  const getHeader = (name) => {
    if (!headers) {
      return null;
    }
    if (typeof headers.get === "function") {
      return headers.get(name);
    }

    const normalized = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value])
    );
    return normalized[String(name).toLowerCase()] ?? null;
  };

  const headerLimit =
    toPositiveInt(getHeader("x-ratelimit-limit")) ??
    toPositiveInt(getHeader("ratelimit-limit")) ??
    toPositiveInt(getHeader("x-rate-limit-limit"));
  const headerRemaining =
    toNonNegativeInt(getHeader("x-ratelimit-remaining")) ??
    toNonNegativeInt(getHeader("ratelimit-remaining")) ??
    toNonNegativeInt(getHeader("x-rate-limit-remaining"));
  const apiCreditsUsed = toNonNegativeInt(getHeader("api-credits-used"));
  const apiCreditsLeft = toNonNegativeInt(getHeader("api-credits-left"));

  return {
    headerLimit:
      headerLimit ??
      (Number.isFinite(apiCreditsUsed) && Number.isFinite(apiCreditsLeft) ? apiCreditsUsed + apiCreditsLeft : null),
    headerRemaining: headerRemaining ?? apiCreditsLeft,
    apiCreditsUsed,
    apiCreditsLeft
  };
}

function minFinite(...values) {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length ? Math.min(...finiteValues) : null;
}

function resolveConfiguredProviderLimits(config = {}) {
  return Object.fromEntries(
    PROVIDERS.map((provider) => {
      const fieldMap = PROVIDER_LIMIT_FIELDS[provider] || {};
      return [
        provider,
        {
          hardDailyLimit: toPositiveInt(config[fieldMap.hardDaily]),
          hardMonthlyLimit: toPositiveInt(config[fieldMap.hardMonthly]),
          hardMinuteLimit: toPositiveInt(config[fieldMap.hardMinute]),
          budgetDailyLimit: toPositiveInt(config[fieldMap.budgetDaily]),
          budgetMonthlyLimit: toPositiveInt(config[fieldMap.budgetMonthly]),
          budgetMinuteLimit: toPositiveInt(config[fieldMap.budgetMinute])
        }
      ];
    })
  );
}

function deriveRemainingState({ hardLimit = null, budgetLimit = null, usedUnits = 0, headerRemaining = null } = {}) {
  const hardRemaining = Number.isFinite(hardLimit) ? Math.max(0, hardLimit - usedUnits) : null;
  const budgetRemaining = Number.isFinite(budgetLimit) ? Math.max(0, budgetLimit - usedUnits) : null;
  const effectiveRemaining = minFinite(hardRemaining, budgetRemaining, headerRemaining);
  const operationalLimit = minFinite(hardLimit, budgetLimit);

  return {
    hardRemaining,
    budgetRemaining,
    effectiveRemaining,
    operationalLimit
  };
}

function resolveOperationalStatus({
  effectiveRemainingDay = null,
  effectiveRemainingMinute = null,
  operationalDailyLimit = null,
  operationalMinuteLimit = null
} = {}) {
  const effectiveRemaining = minFinite(effectiveRemainingDay, effectiveRemainingMinute);
  if (Number.isFinite(effectiveRemaining) && effectiveRemaining <= 0) {
    return "budget-exhausted";
  }

  const ratios = [];
  if (Number.isFinite(effectiveRemainingDay) && Number.isFinite(operationalDailyLimit) && operationalDailyLimit > 0) {
    ratios.push(effectiveRemainingDay / operationalDailyLimit);
  }
  if (Number.isFinite(effectiveRemainingMinute) && Number.isFinite(operationalMinuteLimit) && operationalMinuteLimit > 0) {
    ratios.push(effectiveRemainingMinute / operationalMinuteLimit);
  }

  return ratios.length && Math.min(...ratios) <= 0.15 ? "budget-near-limit" : "within-budget";
}

class ApiQuotaTrackerService {
  constructor({ now = Date.now, persistencePath = null } = {}) {
    this.now = now;
    this.persistencePath = persistencePath;
    this.providers = Object.fromEntries(PROVIDERS.map((provider) => [provider, createProviderState()]));
  }

  reset(config = {}, { hydrate = false } = {}) {
    const resolved = resolveConfiguredProviderLimits(config);
    this.providers = Object.fromEntries(
      PROVIDERS.map((provider) => [provider, createProviderState(resolved[provider])])
    );
    if (hydrate) this.hydrate();
  }

  configurePersistence(persistencePath, { hydrate = true } = {}) {
    this.persistencePath = persistencePath || null;
    if (hydrate) this.hydrate();
  }

  hydrate() {
    if (!this.persistencePath) return false;
    try {
      const payload = JSON.parse(readFileSync(this.persistencePath, "utf8"));
      for (const [provider, saved] of Object.entries(payload.providers || {})) {
        const state = this.providers[this.ensureProvider(provider)];
        state.events = saved.events || state.events;
        for (const field of ["headerLimit", "headerRemaining", "apiCreditsUsed", "apiCreditsLeft", "lastCallAt", "lastStatus"]) {
          if (saved[field] !== undefined) state[field] = saved[field];
        }
      }
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  persist() {
    if (!this.persistencePath) return;
    mkdirSync(dirname(this.persistencePath), { recursive: true });
    const temporaryPath = `${this.persistencePath}.${process.pid}.tmp`;
    const providers = Object.fromEntries(Object.entries(this.providers).map(([provider, state]) => [provider, {
      events: state.events, headerLimit: state.headerLimit, headerRemaining: state.headerRemaining,
      apiCreditsUsed: state.apiCreditsUsed, apiCreditsLeft: state.apiCreditsLeft,
      lastCallAt: state.lastCallAt, lastStatus: state.lastStatus
    }]));
    writeFileSync(temporaryPath, JSON.stringify({ version: 1, savedAt: new Date(this.now()).toISOString(), providers }), { mode: 0o600 });
    renameSync(temporaryPath, this.persistencePath);
  }

  ensureProvider(provider) {
    const normalized = String(provider || "").toLowerCase();
    if (!(normalized in this.providers)) {
      this.providers[normalized] = createProviderState();
    }
    return normalized;
  }

  purge(provider, nowMs = this.now()) {
    const normalized = this.ensureProvider(provider);
    const providerState = this.providers[normalized];
    const minTs = nowMs - RETENTION_MS;

    purgeBucket(providerState.events.calls, minTs);
    purgeBucket(providerState.events.success, minTs);
    purgeBucket(providerState.events.errors, minTs);
    purgeBucket(providerState.events.fallback, minTs);
    return providerState;
  }

  recordCall(provider, { status = "success", fallback = false, headers = null, timestamp = this.now(), units = 1 } = {}) {
    const normalized = this.ensureProvider(provider);
    const nowMs = new Date(timestamp).getTime();
    const providerState = this.purge(normalized, Number.isFinite(nowMs) ? nowMs : Date.now());
    const timestampMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const resolvedUnits = Math.max(0, Number.parseInt(String(units ?? 1), 10) || 1);

    pushEvent(providerState.events.calls, timestampMs, resolvedUnits);
    providerState.lastCallAt = new Date(timestampMs).toISOString();
    providerState.lastStatus = status;

    if (status === "success" || status === "empty") {
      pushEvent(providerState.events.success, timestampMs, resolvedUnits);
    } else if (status === "error") {
      pushEvent(providerState.events.errors, timestampMs, resolvedUnits);
    }

    if (fallback) {
      pushEvent(providerState.events.fallback, timestampMs, resolvedUnits);
    }

    const rateLimit = parseRateLimitHeaders(headers);
    if (Number.isFinite(rateLimit.headerLimit)) {
      providerState.headerLimit = rateLimit.headerLimit;
    }
    if (Number.isFinite(rateLimit.headerRemaining)) {
      providerState.headerRemaining = rateLimit.headerRemaining;
    }
    if (Number.isFinite(rateLimit.apiCreditsUsed)) {
      providerState.apiCreditsUsed = rateLimit.apiCreditsUsed;
    }
    if (Number.isFinite(rateLimit.apiCreditsLeft)) {
      providerState.apiCreditsLeft = rateLimit.apiCreditsLeft;
    }

    const snapshot = this.getProviderSnapshot(normalized, timestampMs);
    this.persist();
    return snapshot;
  }

  markFallback(provider, timestamp = this.now()) {
    const normalized = this.ensureProvider(provider);
    const nowMs = new Date(timestamp).getTime();
    const providerState = this.purge(normalized, Number.isFinite(nowMs) ? nowMs : Date.now());
    const timestampMs = Number.isFinite(nowMs) ? nowMs : Date.now();

    pushEvent(providerState.events.fallback, timestampMs, 1);
    providerState.lastStatus = "fallback";
    if (!providerState.lastCallAt) {
      providerState.lastCallAt = new Date(timestampMs).toISOString();
    }
    const snapshot = this.getProviderSnapshot(normalized, timestampMs);
    this.persist();
    return snapshot;
  }

  getProviderSnapshot(provider, nowMs = this.now()) {
    const normalized = this.ensureProvider(provider);
    const providerState = this.purge(normalized, nowMs);
    const minuteMinTs = nowMs - MINUTE_WINDOW_MS;
    const nowDate = new Date(nowMs);
    const monthMinTs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
    const dayMinTs = nowMs - WINDOW_MS;
    const calls24h = countEventsSince(providerState.events.calls, dayMinTs);
    const success24h = countEventsSince(providerState.events.success, dayMinTs);
    const errors24h = countEventsSince(providerState.events.errors, dayMinTs);
    const fallback24h = countEventsSince(providerState.events.fallback, dayMinTs);
    const callsMinute = countEventsSince(providerState.events.calls, minuteMinTs);
    const successMinute = countEventsSince(providerState.events.success, minuteMinTs);
    const errorsMinute = countEventsSince(providerState.events.errors, minuteMinTs);
    const fallbackMinute = countEventsSince(providerState.events.fallback, minuteMinTs);
    const units24h = sumUnitsSince(providerState.events.calls, nowMs - WINDOW_MS);
    const unitsMinute = sumUnitsSince(providerState.events.calls, minuteMinTs);
    const unitsMonth = sumUnitsSince(providerState.events.calls, monthMinTs);
    const hasMinuteQuota =
      Number.isFinite(providerState.hardMinuteLimit) || Number.isFinite(providerState.budgetMinuteLimit);
    const dailyRemaining = deriveRemainingState({
      hardLimit: providerState.hardDailyLimit,
      budgetLimit: providerState.budgetDailyLimit,
      usedUnits: units24h,
      // For providers with explicit minute quotas, the upstream remaining header is minute-scoped.
      headerRemaining: hasMinuteQuota ? null : providerState.headerRemaining
    });
    const minuteRemaining = hasMinuteQuota
      ? deriveRemainingState({
          hardLimit: providerState.hardMinuteLimit,
          budgetLimit: providerState.budgetMinuteLimit,
          usedUnits: unitsMinute,
          headerRemaining: providerState.headerRemaining
        })
      : {
          hardRemaining: null,
          budgetRemaining: null,
          effectiveRemaining: null,
          operationalLimit: null
        };
    const effectiveRemainingDay = dailyRemaining.effectiveRemaining;
    const monthlyRemaining = deriveRemainingState({ hardLimit: providerState.hardMonthlyLimit, budgetLimit: providerState.budgetMonthlyLimit, usedUnits: unitsMonth });
    const effectiveRemainingMinute = minuteRemaining.effectiveRemaining;
    const effectiveRemainingMonth = monthlyRemaining.effectiveRemaining;
    const remainingCandidates = [effectiveRemainingDay, effectiveRemainingMinute, effectiveRemainingMonth].filter(Number.isFinite);
    const effectiveRemaining = remainingCandidates.length ? Math.min(...remainingCandidates) : null;
    const operationalDailyLimit = hasMinuteQuota
      ? minFinite(providerState.hardDailyLimit, providerState.budgetDailyLimit)
      : minFinite(providerState.hardDailyLimit, providerState.budgetDailyLimit, providerState.headerLimit);
    const operationalMinuteLimit = hasMinuteQuota
      ? minFinite(providerState.hardMinuteLimit, providerState.budgetMinuteLimit, providerState.headerLimit)
      : null;

    const policy = getProviderPolicy(normalized);
    return {
      provider: normalized,
      calls24h,
      success24h,
      errors24h,
      fallback24h,
      callsMinute,
      successMinute,
      errorsMinute,
      fallbackMinute,
      units24h,
      unitsMinute,
      unitsMonth,
      configuredLimit: providerState.hardDailyLimit,
      configuredDailyLimit: providerState.hardDailyLimit,
      configuredMinuteLimit: providerState.hardMinuteLimit,
      hardDailyLimit: providerState.hardDailyLimit,
      hardMinuteLimit: providerState.hardMinuteLimit,
      hardMonthlyLimit: providerState.hardMonthlyLimit,
      budgetDailyLimit: providerState.budgetDailyLimit,
      budgetMinuteLimit: providerState.budgetMinuteLimit,
      budgetMonthlyLimit: providerState.budgetMonthlyLimit,
      hardRemainingDay: dailyRemaining.hardRemaining,
      hardRemainingMinute: minuteRemaining.hardRemaining,
      budgetRemainingDay: dailyRemaining.budgetRemaining,
      budgetRemainingMinute: minuteRemaining.budgetRemaining,
      operationalDailyLimit,
      operationalMinuteLimit,
      headerLimit: providerState.headerLimit,
      headerRemaining: providerState.headerRemaining,
      apiCreditsUsed: providerState.apiCreditsUsed,
      apiCreditsLeft: providerState.apiCreditsLeft,
      effectiveRemaining,
      effectiveRemainingDay,
      effectiveRemainingMinute,
      effectiveRemainingMonth,
      operationalStatus: resolveOperationalStatus({
        effectiveRemainingDay,
        effectiveRemainingMinute,
        operationalDailyLimit,
        operationalMinuteLimit
      }),
      exhaustedDay: Number.isFinite(effectiveRemainingDay) ? effectiveRemainingDay <= 0 : false,
      exhaustedMinute: Number.isFinite(effectiveRemainingMinute) ? effectiveRemainingMinute <= 0 : false,
      exhaustedMonth: Number.isFinite(effectiveRemainingMonth) ? effectiveRemainingMonth <= 0 : false,
      exhausted: remainingCandidates.length ? Math.min(...remainingCandidates) <= 0 : false,
      lastCallAt: providerState.lastCallAt,
      lastStatus: providerState.lastStatus,
      nextDailyResetAt: resolveUtcMidnightResetAt(nowMs),
      nextMinuteResetAt: resolveMinuteResetAt(nowMs),
      policy,
      observedConsumption: { minute: unitsMinute, dayRolling: units24h, headers: { limit: providerState.headerLimit, remaining: providerState.headerRemaining } }
    };
  }

  getSnapshot() {
    const nowMs = this.now();
    return PROVIDERS.map((provider) => this.getProviderSnapshot(provider, nowMs));
  }
}

const apiQuotaTracker = new ApiQuotaTrackerService();
apiQuotaTracker.reset();

export { ApiQuotaTrackerService, WINDOW_MS, MINUTE_WINDOW_MS, parseRateLimitHeaders };
export default apiQuotaTracker;
