const DEFAULT_SEARCH_DAILY_BUDGET = 100;
const DEFAULT_SEARCH_RESERVE = 40;
const DEFAULT_POLICY = "lazy";
const HOUR_MS = 60 * 60_000;

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function normalizePriority(value = "normal") {
  const normalized = String(value || "normal").toLowerCase();
  return ["critical", "normal", "lazy"].includes(normalized) ? normalized : "normal";
}

export class YoutubeQuotaGuard {
  constructor({
    apiKey = process.env.YOUTUBE_API_KEY || "",
    searchDailyBudget = process.env.YOUTUBE_SEARCH_DAILY_BUDGET,
    searchReserve = process.env.YOUTUBE_SEARCH_RESERVE,
    streamResolvePolicy = process.env.YOUTUBE_STREAM_RESOLVE_POLICY,
    criticalRefreshHours = process.env.YOUTUBE_CRITICAL_STREAM_REFRESH_HOURS,
    normalRefreshHours = process.env.YOUTUBE_NORMAL_STREAM_REFRESH_HOURS,
    lazyRefreshHours = process.env.YOUTUBE_LAZY_STREAM_REFRESH_HOURS
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.searchDailyBudget = toNonNegativeInt(searchDailyBudget, DEFAULT_SEARCH_DAILY_BUDGET);
    this.searchReserve = toNonNegativeInt(searchReserve, DEFAULT_SEARCH_RESERVE);
    this.streamResolvePolicy = String(streamResolvePolicy || DEFAULT_POLICY).trim().toLowerCase() || DEFAULT_POLICY;
    this.refreshHoursByPriority = {
      critical: toPositiveInt(criticalRefreshHours, 6),
      normal: toPositiveInt(normalRefreshHours, 12),
      lazy: toPositiveInt(lazyRefreshHours, 24)
    };
    this.dayKey = utcDayKey();
    this.searchCallsUsedToday = 0;
    this.validationCallsUsedToday = 0;
    this.channelLookupCallsUsedToday = 0;
    this.lastSearchByChannel = new Map();
    this.lastValidationAt = null;
    this.lastChannelLookupAt = null;
  }

  hasApiKey() {
    return Boolean(this.apiKey);
  }

  resetIfNeeded(nowMs = Date.now()) {
    const nextDayKey = utcDayKey(new Date(nowMs));
    if (nextDayKey === this.dayKey) {
      return;
    }
    this.dayKey = nextDayKey;
    this.searchCallsUsedToday = 0;
    this.validationCallsUsedToday = 0;
    this.channelLookupCallsUsedToday = 0;
    this.lastSearchByChannel.clear();
    this.lastValidationAt = null;
    this.lastChannelLookupAt = null;
  }

  getEffectiveSearchLimit() {
    return Math.max(0, this.searchDailyBudget - this.searchReserve);
  }

  getPriorityCooldownMs(priority = "normal") {
    return (this.refreshHoursByPriority[normalizePriority(priority)] || 12) * HOUR_MS;
  }

  canUseSearch({ channelId = "", priority = "normal", force = false, nowMs = Date.now() } = {}) {
    this.resetIfNeeded(nowMs);
    if (!this.hasApiKey()) {
      return {
        allowed: false,
        reason: "missing_youtube_api_key"
      };
    }

    const effectiveLimit = this.getEffectiveSearchLimit();
    if (this.searchCallsUsedToday >= effectiveLimit) {
      return {
        allowed: false,
        reason: "youtube_search_budget_exhausted",
        searchCallsUsedToday: this.searchCallsUsedToday,
        searchDailyBudget: this.searchDailyBudget,
        searchReserve: this.searchReserve
      };
    }

    const normalizedChannelId = String(channelId || "").trim();
    if (!force && normalizedChannelId) {
      const lastSearch = this.lastSearchByChannel.get(normalizedChannelId);
      const cooldownMs = this.getPriorityCooldownMs(priority);
      if (lastSearch && nowMs - lastSearch.atMs < cooldownMs) {
        return {
          allowed: false,
          reason: "youtube_channel_search_cooldown",
          nextAllowedAt: new Date(lastSearch.atMs + cooldownMs).toISOString()
        };
      }
    }

    return {
      allowed: true,
      reason: null,
      searchCallsUsedToday: this.searchCallsUsedToday,
      searchDailyBudget: this.searchDailyBudget,
      searchReserve: this.searchReserve
    };
  }

  recordSearch({ channelId = "", priority = "normal", status = "ok", latencyMs = null, nowMs = Date.now() } = {}) {
    this.resetIfNeeded(nowMs);
    this.searchCallsUsedToday += 1;
    const normalizedChannelId = String(channelId || "").trim();
    if (normalizedChannelId) {
      this.lastSearchByChannel.set(normalizedChannelId, {
        atMs: nowMs,
        at: new Date(nowMs).toISOString(),
        priority: normalizePriority(priority),
        status,
        latencyMs: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null
      });
    }
  }

  recordValidation({ ids = [], status = "ok", latencyMs = null, nowMs = Date.now() } = {}) {
    this.resetIfNeeded(nowMs);
    this.validationCallsUsedToday += 1;
    this.lastValidationAt = {
      atMs: nowMs,
      at: new Date(nowMs).toISOString(),
      ids: Array.isArray(ids) ? ids.slice(0, 50) : [],
      status,
      latencyMs: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null
    };
  }

  recordChannelLookup({ handle = "", status = "ok", latencyMs = null, nowMs = Date.now() } = {}) {
    this.resetIfNeeded(nowMs);
    this.channelLookupCallsUsedToday += 1;
    this.lastChannelLookupAt = {
      atMs: nowMs,
      at: new Date(nowMs).toISOString(),
      handle: String(handle || "").trim(),
      status,
      latencyMs: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null
    };
  }

  getNextSearchAt(channelId = "", priority = "normal", nowMs = Date.now()) {
    this.resetIfNeeded(nowMs);
    const normalizedChannelId = String(channelId || "").trim();
    const lastSearch = normalizedChannelId ? this.lastSearchByChannel.get(normalizedChannelId) : null;
    if (!lastSearch) {
      return null;
    }
    return new Date(lastSearch.atMs + this.getPriorityCooldownMs(priority)).toISOString();
  }

  getStatus(nowMs = Date.now()) {
    this.resetIfNeeded(nowMs);
    return {
      hasApiKey: this.hasApiKey(),
      dayKey: this.dayKey,
      searchDailyBudget: this.searchDailyBudget,
      searchReserve: this.searchReserve,
      effectiveSearchLimit: this.getEffectiveSearchLimit(),
      searchCallsUsedToday: this.searchCallsUsedToday,
      searchCallsRemainingToday: Math.max(0, this.getEffectiveSearchLimit() - this.searchCallsUsedToday),
      validationCallsUsedToday: this.validationCallsUsedToday,
      channelLookupCallsUsedToday: this.channelLookupCallsUsedToday,
      streamResolvePolicy: this.streamResolvePolicy,
      refreshHoursByPriority: { ...this.refreshHoursByPriority },
      lastValidationAt: this.lastValidationAt?.at || null,
      lastChannelLookupAt: this.lastChannelLookupAt?.at || null,
      channelsWithCooldown: this.lastSearchByChannel.size
    };
  }
}

const defaultYoutubeQuotaGuard = new YoutubeQuotaGuard();

export default defaultYoutubeQuotaGuard;
