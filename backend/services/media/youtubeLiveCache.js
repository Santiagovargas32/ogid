export const YOUTUBE_CACHE_TTL_MS = Object.freeze({
  manual: 30 * 60_000,
  verifiedLive: 6 * 60 * 60_000,
  channelFallback: 15 * 60_000,
  error: 2 * 60_000,
  quotaLimited: 30 * 60_000,
  videoValidation: 15 * 60_000,
  channelLookup: 24 * 60 * 60_000
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeKey(key = "") {
  return String(key || "").trim();
}

export function streamCacheKey(streamId = "") {
  return `youtube_stream:${normalizeKey(streamId)}`;
}

export function liveCacheKey(channelId = "") {
  return `youtube_live:${normalizeKey(channelId)}`;
}

export function videoValidationCacheKey(videoId = "") {
  return `youtube_video_validation:${normalizeKey(videoId)}`;
}

export function channelHandleCacheKey(handle = "") {
  return `youtube_channel_handle:${normalizeKey(handle).toLowerCase()}`;
}

export class YoutubeLiveCache {
  constructor({ maxEntries = 500 } = {}) {
    this.maxEntries = Math.max(20, Number.parseInt(String(maxEntries || 500), 10) || 500);
    this.cache = new Map();
    this.inFlight = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0
    };
  }

  prune() {
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }

  getEntry(key = "") {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
      return null;
    }
    return this.cache.get(normalizedKey) || null;
  }

  getFresh(key = "", nowMs = Date.now()) {
    const entry = this.getEntry(key);
    if (!entry || (entry.expiresAt > 0 && entry.expiresAt <= nowMs)) {
      this.stats.misses += 1;
      return null;
    }

    this.stats.hits += 1;
    return {
      value: clone(entry.value),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      ageMs: Math.max(0, nowMs - entry.createdAt)
    };
  }

  getStale(key = "", nowMs = Date.now()) {
    const entry = this.getEntry(key);
    if (!entry) {
      return null;
    }

    return {
      value: clone(entry.value),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      ageMs: Math.max(0, nowMs - entry.createdAt),
      stale: entry.expiresAt > 0 && entry.expiresAt <= nowMs
    };
  }

  set(key = "", value = null, ttlMs = 60_000, nowMs = Date.now()) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
      return null;
    }

    if (this.cache.has(normalizedKey)) {
      this.cache.delete(normalizedKey);
    }
    this.cache.set(normalizedKey, {
      value: clone(value),
      createdAt: nowMs,
      expiresAt: ttlMs > 0 ? nowMs + ttlMs : 0
    });
    this.stats.sets += 1;
    this.prune();
    return this.getFresh(normalizedKey, nowMs);
  }

  async withInFlight(key = "", task) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey || typeof task !== "function") {
      return task?.();
    }
    if (this.inFlight.has(normalizedKey)) {
      return this.inFlight.get(normalizedKey);
    }

    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        this.inFlight.delete(normalizedKey);
      });
    this.inFlight.set(normalizedKey, promise);
    return promise;
  }

  clear() {
    this.cache.clear();
    this.inFlight.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0
    };
  }

  entries(nowMs = Date.now()) {
    return [...this.cache.entries()].map(([key, entry]) => ({
      key,
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: entry.expiresAt > 0 ? new Date(entry.expiresAt).toISOString() : null,
      ageSec: Math.max(0, Math.round((nowMs - entry.createdAt) / 1_000))
    }));
  }

  getDiagnostics() {
    const totalLookups = this.stats.hits + this.stats.misses;
    return {
      cacheSize: this.cache.size,
      inFlightCount: this.inFlight.size,
      cacheHits: this.stats.hits,
      cacheMisses: this.stats.misses,
      cacheSets: this.stats.sets,
      cacheHitRatio: totalLookups > 0 ? Number((this.stats.hits / totalLookups).toFixed(3)) : null
    };
  }
}

const defaultYoutubeLiveCache = new YoutubeLiveCache();

export default defaultYoutubeLiveCache;
