const WINDOW_MS = 24 * 60 * 60 * 1_000;
const PROVIDERS = ["newsapi", "gnews", "mediastack", "rss", "gdelt", "fmp", "alphavantage"];

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

function createProviderState(configuredLimit = null) {
  return {
    configuredLimit,
    headerLimit: null,
    headerRemaining: null,
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

function pushEvent(bucket, timestampMs) {
  bucket.push(timestampMs);
}

function purgeBucket(bucket, minTs) {
  while (bucket.length && bucket[0] < minTs) {
    bucket.shift();
  }
}

function parseRateLimitHeaders(headers = {}) {
  if (headers && typeof headers === "object" && ("headerLimit" in headers || "headerRemaining" in headers)) {
    return {
      headerLimit: toPositiveInt(headers.headerLimit),
      headerRemaining: toNonNegativeInt(headers.headerRemaining)
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

  const limit = toPositiveInt(getHeader("x-ratelimit-limit")) ?? toPositiveInt(getHeader("ratelimit-limit")) ?? toPositiveInt(getHeader("x-rate-limit-limit"));
  const remaining = toNonNegativeInt(getHeader("x-ratelimit-remaining")) ?? toNonNegativeInt(getHeader("ratelimit-remaining")) ?? toNonNegativeInt(getHeader("x-rate-limit-remaining"));

  return {
    headerLimit: limit,
    headerRemaining: remaining
  };
}

function deriveEffectiveRemaining({ configuredLimit, calls24h, headerRemaining }) {
  const envRemaining = Number.isFinite(configuredLimit) ? Math.max(0, configuredLimit - calls24h) : null;

  if (Number.isFinite(envRemaining) && Number.isFinite(headerRemaining)) {
    return Math.min(envRemaining, headerRemaining);
  }
  if (Number.isFinite(envRemaining)) {
    return envRemaining;
  }
  if (Number.isFinite(headerRemaining)) {
    return headerRemaining;
  }
  return null;
}

class ApiQuotaTrackerService {
  constructor() {
    this.providers = Object.fromEntries(PROVIDERS.map((provider) => [provider, createProviderState(null)]));
  }

  reset(config = {}) {
    const resolved = {
      newsapi: toPositiveInt(config.newsapiDailyLimit ?? process.env.NEWSAPI_DAILY_LIMIT),
      gnews: toPositiveInt(config.gnewsDailyLimit ?? process.env.GNEWS_DAILY_LIMIT),
      mediastack: toPositiveInt(config.mediastackDailyLimit ?? process.env.MEDIASTACK_DAILY_LIMIT),
      rss: toPositiveInt(config.rssDailyLimit ?? process.env.RSS_DAILY_LIMIT),
      gdelt: toPositiveInt(config.gdeltDailyLimit ?? process.env.GDELT_DAILY_LIMIT),
      fmp: toPositiveInt(config.fmpDailyLimit ?? process.env.FMP_DAILY_LIMIT),
      alphavantage: toPositiveInt(config.alphavantageDailyLimit ?? process.env.ALPHAVANTAGE_DAILY_LIMIT)
    };

    this.providers = Object.fromEntries(
      PROVIDERS.map((provider) => [provider, createProviderState(resolved[provider])])
    );
  }

  ensureProvider(provider) {
    const normalized = String(provider || "").toLowerCase();
    if (!(normalized in this.providers)) {
      this.providers[normalized] = createProviderState(null);
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

  recordCall(provider, { status = "success", fallback = false, headers = null, timestamp = Date.now() } = {}) {
    const normalized = this.ensureProvider(provider);
    const nowMs = new Date(timestamp).getTime();
    const providerState = this.purge(normalized, Number.isFinite(nowMs) ? nowMs : Date.now());
    const timestampMs = Number.isFinite(nowMs) ? nowMs : Date.now();

    pushEvent(providerState.events.calls, timestampMs);
    providerState.lastCallAt = new Date(timestampMs).toISOString();
    providerState.lastStatus = status;

    if (status === "success" || status === "empty") {
      pushEvent(providerState.events.success, timestampMs);
    } else if (status === "error") {
      pushEvent(providerState.events.errors, timestampMs);
    }

    if (fallback) {
      pushEvent(providerState.events.fallback, timestampMs);
    }

    const rateLimit = parseRateLimitHeaders(headers);
    if (Number.isFinite(rateLimit.headerLimit)) {
      providerState.headerLimit = rateLimit.headerLimit;
    }
    if (Number.isFinite(rateLimit.headerRemaining)) {
      providerState.headerRemaining = rateLimit.headerRemaining;
    }

    return this.getProviderSnapshot(normalized, timestampMs);
  }

  markFallback(provider, timestamp = Date.now()) {
    const normalized = this.ensureProvider(provider);
    const nowMs = new Date(timestamp).getTime();
    const providerState = this.purge(normalized, Number.isFinite(nowMs) ? nowMs : Date.now());
    const timestampMs = Number.isFinite(nowMs) ? nowMs : Date.now();

    pushEvent(providerState.events.fallback, timestampMs);
    providerState.lastStatus = "fallback";
    if (!providerState.lastCallAt) {
      providerState.lastCallAt = new Date(timestampMs).toISOString();
    }
    return this.getProviderSnapshot(normalized, timestampMs);
  }

  getProviderSnapshot(provider, nowMs = Date.now()) {
    const normalized = this.ensureProvider(provider);
    const providerState = this.purge(normalized, nowMs);
    const calls24h = providerState.events.calls.length;
    const success24h = providerState.events.success.length;
    const errors24h = providerState.events.errors.length;
    const fallback24h = providerState.events.fallback.length;
    const effectiveRemaining = deriveEffectiveRemaining({
      configuredLimit: providerState.configuredLimit,
      calls24h,
      headerRemaining: providerState.headerRemaining
    });

    return {
      provider: normalized,
      calls24h,
      success24h,
      errors24h,
      fallback24h,
      configuredLimit: providerState.configuredLimit,
      headerLimit: providerState.headerLimit,
      headerRemaining: providerState.headerRemaining,
      effectiveRemaining,
      exhausted: Number.isFinite(effectiveRemaining) ? effectiveRemaining <= 0 : false,
      lastCallAt: providerState.lastCallAt,
      lastStatus: providerState.lastStatus
    };
  }

  getSnapshot() {
    const nowMs = Date.now();
    return PROVIDERS.map((provider) => this.getProviderSnapshot(provider, nowMs));
  }
}

const apiQuotaTracker = new ApiQuotaTrackerService();
apiQuotaTracker.reset();

export { WINDOW_MS, parseRateLimitHeaders };
export default apiQuotaTracker;
