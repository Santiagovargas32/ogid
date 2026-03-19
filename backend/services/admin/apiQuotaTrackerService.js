const WINDOW_MS = 24 * 60 * 60 * 1_000;
const MINUTE_WINDOW_MS = 60 * 1_000;
const PROVIDERS = ["newsapi", "gnews", "mediastack", "rss", "gdelt", "twelve", "yahoo", "fmp"];

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

function createProviderState({ configuredDailyLimit = null, configuredMinuteLimit = null } = {}) {
  return {
    configuredDailyLimit,
    configuredMinuteLimit,
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

function deriveEffectiveRemaining({ configuredLimit, usedUnits, headerRemaining }) {
  const configuredRemaining = Number.isFinite(configuredLimit) ? Math.max(0, configuredLimit - usedUnits) : null;

  if (Number.isFinite(configuredRemaining) && Number.isFinite(headerRemaining)) {
    return Math.min(configuredRemaining, headerRemaining);
  }
  if (Number.isFinite(configuredRemaining)) {
    return configuredRemaining;
  }
  if (Number.isFinite(headerRemaining)) {
    return headerRemaining;
  }
  return null;
}

function resolveConfiguredProviderLimits(config = {}) {
  return {
    newsapi: {
      configuredDailyLimit: toPositiveInt(config.newsapiDailyLimit ?? process.env.NEWSAPI_DAILY_LIMIT)
    },
    gnews: {
      configuredDailyLimit: toPositiveInt(config.gnewsDailyLimit ?? process.env.GNEWS_DAILY_LIMIT)
    },
    mediastack: {
      configuredDailyLimit: toPositiveInt(config.mediastackDailyLimit ?? process.env.MEDIASTACK_DAILY_LIMIT)
    },
    rss: {
      configuredDailyLimit: toPositiveInt(config.rssDailyLimit ?? process.env.RSS_DAILY_LIMIT)
    },
    gdelt: {
      configuredDailyLimit: toPositiveInt(config.gdeltDailyLimit ?? process.env.GDELT_DAILY_LIMIT)
    },
    twelve: {
      configuredDailyLimit: toPositiveInt(config.twelveDailyLimit ?? process.env.MARKET_TWELVE_DAILY_LIMIT ?? 800),
      configuredMinuteLimit: toPositiveInt(config.twelveMinuteLimit ?? process.env.MARKET_TWELVE_MINUTE_LIMIT ?? 8)
    },
    yahoo: {
      configuredDailyLimit: toPositiveInt(config.yahooDailyLimit ?? process.env.MARKET_YAHOO_DAILY_LIMIT)
    },
    fmp: {
      configuredDailyLimit: toPositiveInt(config.fmpDailyLimit ?? process.env.FMP_DAILY_LIMIT)
    }
  };
}

class ApiQuotaTrackerService {
  constructor() {
    this.providers = Object.fromEntries(PROVIDERS.map((provider) => [provider, createProviderState()]));
  }

  reset(config = {}) {
    const resolved = resolveConfiguredProviderLimits(config);
    this.providers = Object.fromEntries(
      PROVIDERS.map((provider) => [provider, createProviderState(resolved[provider])])
    );
  }

  ensureProvider(provider) {
    const normalized = String(provider || "").toLowerCase();
    if (!(normalized in this.providers)) {
      this.providers[normalized] = createProviderState();
    }
    return normalized;
  }

  purge(provider, nowMs = Date.now()) {
    const normalized = this.ensureProvider(provider);
    const providerState = this.providers[normalized];
    const minTs = nowMs - WINDOW_MS;

    purgeBucket(providerState.events.calls, minTs);
    purgeBucket(providerState.events.success, minTs);
    purgeBucket(providerState.events.errors, minTs);
    purgeBucket(providerState.events.fallback, minTs);
    return providerState;
  }

  recordCall(provider, { status = "success", fallback = false, headers = null, timestamp = Date.now(), units = 1 } = {}) {
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

    return this.getProviderSnapshot(normalized, timestampMs);
  }

  markFallback(provider, timestamp = Date.now()) {
    const normalized = this.ensureProvider(provider);
    const nowMs = new Date(timestamp).getTime();
    const providerState = this.purge(normalized, Number.isFinite(nowMs) ? nowMs : Date.now());
    const timestampMs = Number.isFinite(nowMs) ? nowMs : Date.now();

    pushEvent(providerState.events.fallback, timestampMs, 1);
    providerState.lastStatus = "fallback";
    if (!providerState.lastCallAt) {
      providerState.lastCallAt = new Date(timestampMs).toISOString();
    }
    return this.getProviderSnapshot(normalized, timestampMs);
  }

  getProviderSnapshot(provider, nowMs = Date.now()) {
    const normalized = this.ensureProvider(provider);
    const providerState = this.purge(normalized, nowMs);
    const minuteMinTs = nowMs - MINUTE_WINDOW_MS;
    const calls24h = providerState.events.calls.length;
    const success24h = providerState.events.success.length;
    const errors24h = providerState.events.errors.length;
    const fallback24h = providerState.events.fallback.length;
    const callsMinute = countEventsSince(providerState.events.calls, minuteMinTs);
    const successMinute = countEventsSince(providerState.events.success, minuteMinTs);
    const errorsMinute = countEventsSince(providerState.events.errors, minuteMinTs);
    const fallbackMinute = countEventsSince(providerState.events.fallback, minuteMinTs);
    const units24h = sumUnitsSince(providerState.events.calls, nowMs - WINDOW_MS);
    const unitsMinute = sumUnitsSince(providerState.events.calls, minuteMinTs);
    const effectiveRemainingDay = deriveEffectiveRemaining({
      configuredLimit: providerState.configuredDailyLimit,
      usedUnits: units24h,
      headerRemaining: null
    });
    const effectiveRemainingMinute = deriveEffectiveRemaining({
      configuredLimit: providerState.configuredMinuteLimit,
      usedUnits: unitsMinute,
      headerRemaining: providerState.headerRemaining
    });
    const remainingCandidates = [effectiveRemainingDay, effectiveRemainingMinute].filter(Number.isFinite);
    const effectiveRemaining = remainingCandidates.length ? Math.min(...remainingCandidates) : null;

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
      configuredLimit: providerState.configuredDailyLimit,
      configuredDailyLimit: providerState.configuredDailyLimit,
      configuredMinuteLimit: providerState.configuredMinuteLimit,
      headerLimit: providerState.headerLimit,
      headerRemaining: providerState.headerRemaining,
      apiCreditsUsed: providerState.apiCreditsUsed,
      apiCreditsLeft: providerState.apiCreditsLeft,
      effectiveRemaining,
      effectiveRemainingDay,
      effectiveRemainingMinute,
      exhaustedDay: Number.isFinite(effectiveRemainingDay) ? effectiveRemainingDay <= 0 : false,
      exhaustedMinute: Number.isFinite(effectiveRemainingMinute) ? effectiveRemainingMinute <= 0 : false,
      exhausted: remainingCandidates.length ? Math.min(...remainingCandidates) <= 0 : false,
      lastCallAt: providerState.lastCallAt,
      lastStatus: providerState.lastStatus,
      nextDailyResetAt: resolveUtcMidnightResetAt(nowMs),
      nextMinuteResetAt: resolveMinuteResetAt(nowMs)
    };
  }

  getSnapshot() {
    const nowMs = Date.now();
    return PROVIDERS.map((provider) => this.getProviderSnapshot(provider, nowMs));
  }
}

const apiQuotaTracker = new ApiQuotaTrackerService();
apiQuotaTracker.reset();

export { WINDOW_MS, MINUTE_WINDOW_MS, parseRateLimitHeaders };
export default apiQuotaTracker;
