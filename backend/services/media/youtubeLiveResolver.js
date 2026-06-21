import defaultYoutubeLiveCache, {
  channelHandleCacheKey,
  liveCacheKey,
  streamCacheKey,
  videoValidationCacheKey,
  YOUTUBE_CACHE_TTL_MS
} from "./youtubeLiveCache.js";
import defaultYoutubeQuotaGuard from "./youtubeQuotaGuard.js";

const YOUTUBE_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CONCURRENCY = 2;
const YOUTUBE_VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeId(value = "") {
  return String(value || "").trim();
}

function normalizeProvider(streamConfig = {}) {
  return String(streamConfig.provider || streamConfig.kind || "external").toLowerCase();
}

function normalizePriority(value = "normal") {
  const normalized = String(value || "normal").toLowerCase();
  return ["critical", "normal", "lazy"].includes(normalized) ? normalized : "normal";
}

function normalizeMode(value = "external") {
  const normalized = String(value || "").toLowerCase();
  if (["embed", "hls", "external"].includes(normalized)) {
    return normalized;
  }
  if (normalized === "link") {
    return "external";
  }
  return "external";
}

function normalizeVideoId(value = "") {
  const normalized = normalizeId(value);
  return YOUTUBE_VIDEO_ID_PATTERN.test(normalized) ? normalized : "";
}

function getHandle(streamConfig = {}) {
  const handle = normalizeId(streamConfig.handle || streamConfig.channelHandle || "");
  if (!handle) {
    return null;
  }
  return handle.startsWith("@") ? handle : `@${handle}`;
}

function getApiKey(options = {}) {
  return normalizeId(options.apiKey || options.youtubeApiKey || options.quotaGuard?.apiKey || "");
}

function safeErrorReason(error, fallback = "youtube_request_failed") {
  const raw = typeof error === "string" ? error : error?.code || error?.message || fallback;
  return String(raw || fallback)
    .replace(/key=([^&\s]+)/gi, "key=redacted")
    .replace(/[^\w:.-]+/g, "_")
    .slice(0, 120);
}

function buildWatchUrl(videoId = "") {
  const normalizedVideoId = normalizeVideoId(videoId);
  return normalizedVideoId ? `https://www.youtube.com/watch?v=${normalizedVideoId}` : null;
}

export function buildYoutubeEmbedUrl(videoId = "") {
  const normalizedVideoId = normalizeVideoId(videoId);
  if (!normalizedVideoId) {
    return null;
  }

  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    playsinline: "1"
  });
  return `https://www.youtube.com/embed/${normalizedVideoId}?${params.toString()}`;
}

export function buildYoutubeChannelEmbedUrl(channelId = "") {
  const normalizedChannelId = normalizeId(channelId);
  if (!normalizedChannelId) {
    return null;
  }

  const params = new URLSearchParams({
    channel: normalizedChannelId,
    autoplay: "1",
    mute: "1",
    playsinline: "1"
  });
  return `https://www.youtube.com/embed/live_stream?${params.toString()}`;
}

function resolveFallbackUrl(streamConfig = {}) {
  if (streamConfig.fallbackUrl) {
    return String(streamConfig.fallbackUrl);
  }
  const handle = getHandle(streamConfig);
  if (handle) {
    return `https://www.youtube.com/${handle}/streams`;
  }
  if (streamConfig.channelId) {
    return `https://www.youtube.com/channel/${streamConfig.channelId}/streams`;
  }
  return "#";
}

function baseNormalizedStream(streamConfig = {}) {
  const provider = normalizeProvider(streamConfig);
  const channelId = normalizeId(streamConfig.channelId);
  const mode = normalizeMode(streamConfig.mode || (streamConfig.embedUrl || streamConfig.staticEmbedUrl ? "embed" : "external"));

  return {
    id: normalizeId(streamConfig.id),
    name: String(streamConfig.name || streamConfig.id || "Unknown Stream"),
    region: String(streamConfig.region || "Global"),
    provider,
    mode,
    channelId: channelId || undefined,
    handle: getHandle(streamConfig) || undefined,
    videoId: undefined,
    embedUrl: undefined,
    channelEmbedUrl: channelId ? buildYoutubeChannelEmbedUrl(channelId) : undefined,
    fallbackUrl: resolveFallbackUrl(streamConfig),
    priority: normalizePriority(streamConfig.priority),
    enabled: streamConfig.enabled !== false,
    availability: "unavailable",
    resolvedAt: undefined,
    cacheAgeSec: undefined,
    nextResolveAt: undefined,
    errorReason: undefined,
    metadata: undefined
  };
}

function compactStream(stream = {}) {
  return Object.fromEntries(Object.entries(stream).filter(([, value]) => value !== undefined));
}

function withResolutionMeta(stream = {}, { availability, ttlMs, nowMs = Date.now(), cacheAgeSec, errorReason, metadata } = {}) {
  const resolvedAt = new Date(nowMs).toISOString();
  return compactStream({
    ...stream,
    availability,
    resolvedAt,
    cacheAgeSec,
    nextResolveAt: ttlMs > 0 ? new Date(nowMs + ttlMs).toISOString() : undefined,
    errorReason,
    metadata
  });
}

function buildVideoResult(streamConfig = {}, videoId = "", availability = "live_verified", options = {}) {
  const normalizedVideoId = normalizeVideoId(videoId);
  const base = baseNormalizedStream(streamConfig);
  const embedUrl = buildYoutubeEmbedUrl(normalizedVideoId);
  return withResolutionMeta(
    {
      ...base,
      mode: embedUrl ? "embed" : base.mode,
      videoId: normalizedVideoId || undefined,
      embedUrl: embedUrl || undefined,
      fallbackUrl: buildWatchUrl(normalizedVideoId) || base.fallbackUrl,
      metadata: {
        ...(options.metadata || {}),
        watchUrl: buildWatchUrl(normalizedVideoId) || undefined,
        source: options.source || availability
      }
    },
    {
      availability,
      ttlMs: options.ttlMs ?? YOUTUBE_CACHE_TTL_MS.verifiedLive,
      nowMs: options.nowMs,
      cacheAgeSec: options.cacheAgeSec,
      errorReason: options.errorReason,
      metadata: {
        ...(options.metadata || {}),
        watchUrl: buildWatchUrl(normalizedVideoId) || undefined,
        source: options.source || availability
      }
    }
  );
}

function buildFallbackResult(streamConfig = {}, availability = "channel_fallback", options = {}) {
  const base = baseNormalizedStream(streamConfig);
  const channelEmbedUrl = base.channelEmbedUrl || null;
  const mode = channelEmbedUrl ? "embed" : "external";
  return withResolutionMeta(
    {
      ...base,
      mode,
      embedUrl: channelEmbedUrl || base.embedUrl || streamConfig.staticEmbedUrl || streamConfig.embedUrl || undefined,
      channelEmbedUrl: channelEmbedUrl || undefined
    },
    {
      availability,
      ttlMs:
        availability === "quota_limited"
          ? YOUTUBE_CACHE_TTL_MS.quotaLimited
          : availability === "error"
            ? YOUTUBE_CACHE_TTL_MS.error
            : YOUTUBE_CACHE_TTL_MS.channelFallback,
      nowMs: options.nowMs,
      cacheAgeSec: options.cacheAgeSec,
      errorReason: options.errorReason,
      metadata: options.metadata
    }
  );
}

function toCachedResult(cachedValue = {}, ageMs = 0, nowMs = Date.now()) {
  const result = clone(cachedValue);
  if (!result) {
    return null;
  }
  const cacheAgeSec = Math.max(0, Math.round(ageMs / 1_000));
  if (result.availability === "live_verified") {
    result.availability = "cached_verified";
  }
  result.cacheAgeSec = cacheAgeSec;
  if (!result.resolvedAt) {
    result.resolvedAt = new Date(nowMs).toISOString();
  }
  return result;
}

function isValidationItemLive(item = {}) {
  const liveBroadcastContent = String(item.snippet?.liveBroadcastContent || "").toLowerCase();
  const actualStartTime = item.liveStreamingDetails?.actualStartTime || null;
  const actualEndTime = item.liveStreamingDetails?.actualEndTime || null;
  const embeddable = item.status?.embeddable !== false;
  const live = liveBroadcastContent === "live" || Boolean(actualStartTime && !actualEndTime);

  return {
    valid: Boolean(live && embeddable && normalizeVideoId(item.id)),
    live,
    embeddable,
    videoId: normalizeVideoId(item.id),
    liveBroadcastContent,
    actualStartTime,
    actualEndTime
  };
}

async function fetchJsonWithTimeout(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs || DEFAULT_TIMEOUT_MS)));
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`youtube_api_${response.status}`);
      error.code = `youtube_api_${response.status}`;
      error.payload = payload;
      error.latencyMs = latencyMs;
      throw error;
    }
    return {
      payload,
      latencyMs
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("youtube_api_timeout");
      timeoutError.code = "youtube_api_timeout";
      timeoutError.latencyMs = Date.now() - startedAt;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function runWithConcurrency(items = [], limit = DEFAULT_CONCURRENCY, task) {
  const results = new Array(items.length);
  const concurrency = Math.max(1, Number.parseInt(String(limit || DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function knownVideoIdForStream(streamConfig = {}, staleEntry = null) {
  return (
    normalizeVideoId(streamConfig.lastKnownVideoId) ||
    normalizeVideoId(staleEntry?.value?.videoId) ||
    normalizeVideoId(streamConfig.videoId)
  );
}

function apiUnavailableFallback(streamConfig = {}, errorReason = "missing_youtube_api_key", nowMs = Date.now()) {
  return buildFallbackResult(streamConfig, "channel_fallback", {
    nowMs,
    errorReason
  });
}

export async function validateKnownVideoIds(streamConfigs = [], options = {}) {
  const cache = options.cache || defaultYoutubeLiveCache;
  const quotaGuard = options.quotaGuard || defaultYoutubeQuotaGuard;
  const apiKey = getApiKey({ ...options, quotaGuard });
  const nowMs = options.nowMs || Date.now();
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const resultsByStreamId = new Map();
  const uniqueVideoIds = new Map();

  for (const streamConfig of streamConfigs || []) {
    const streamId = normalizeId(streamConfig.id);
    const staleEntry = cache.getStale(streamCacheKey(streamId), nowMs);
    const videoId = knownVideoIdForStream(streamConfig, staleEntry);
    if (!streamId || !videoId) {
      continue;
    }

    const cachedValidation = cache.getFresh(videoValidationCacheKey(videoId), nowMs);
    if (cachedValidation) {
      resultsByStreamId.set(streamId, {
        ...cachedValidation.value,
        cacheAgeSec: Math.max(0, Math.round(cachedValidation.ageMs / 1_000))
      });
      continue;
    }

    if (!uniqueVideoIds.has(videoId)) {
      uniqueVideoIds.set(videoId, []);
    }
    uniqueVideoIds.get(videoId).push(streamConfig);
  }

  const idsToValidate = [...uniqueVideoIds.keys()];
  if (!idsToValidate.length || !apiKey) {
    return resultsByStreamId;
  }

  for (let index = 0; index < idsToValidate.length; index += 50) {
    const ids = idsToValidate.slice(index, index + 50);
    const url = new URL(YOUTUBE_VIDEOS_URL);
    url.searchParams.set("part", "snippet,liveStreamingDetails,status");
    url.searchParams.set("id", ids.join(","));
    url.searchParams.set("key", apiKey);
    const startedAt = Date.now();

    try {
      const { payload, latencyMs } = await fetchJsonWithTimeout(url, { fetchImpl, timeoutMs });
      quotaGuard.recordValidation({ ids, status: "ok", latencyMs, nowMs });
      const itemsById = new Map((payload?.items || []).map((item) => [normalizeVideoId(item.id), item]));

      for (const videoId of ids) {
        const item = itemsById.get(videoId) || null;
        const validation = item ? isValidationItemLive(item) : { valid: false, videoId };
        cache.set(videoValidationCacheKey(videoId), validation, YOUTUBE_CACHE_TTL_MS.videoValidation, nowMs);
        for (const streamConfig of uniqueVideoIds.get(videoId) || []) {
          resultsByStreamId.set(normalizeId(streamConfig.id), validation);
        }
      }
    } catch (error) {
      quotaGuard.recordValidation({
        ids,
        status: "error",
        latencyMs: Date.now() - startedAt,
        nowMs
      });
      throw error;
    }
  }

  return resultsByStreamId;
}

export async function resolveChannelIdByHandle(handle, options = {}) {
  const normalizedHandle = getHandle({ handle });
  const cache = options.cache || defaultYoutubeLiveCache;
  const quotaGuard = options.quotaGuard || defaultYoutubeQuotaGuard;
  const apiKey = getApiKey({ ...options, quotaGuard });
  const nowMs = options.nowMs || Date.now();
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!normalizedHandle) {
    return {
      status: "skipped",
      reason: "missing_handle",
      channelId: null
    };
  }

  const cacheKey = channelHandleCacheKey(normalizedHandle);
  const fresh = cache.getFresh(cacheKey, nowMs);
  if (fresh?.value) {
    return {
      ...fresh.value,
      cached: true,
      cacheAgeSec: Math.max(0, Math.round(fresh.ageMs / 1_000))
    };
  }

  if (!apiKey) {
    return {
      status: "skipped",
      reason: "missing_youtube_api_key",
      channelId: null,
      handle: normalizedHandle
    };
  }

  return cache.withInFlight(`youtube_channel_handle_lookup:${normalizedHandle.toLowerCase()}`, async () => {
    const url = new URL(YOUTUBE_CHANNELS_URL);
    url.searchParams.set("part", "id,snippet");
    url.searchParams.set("forHandle", normalizedHandle);
    url.searchParams.set("key", apiKey);
    const startedAt = Date.now();

    try {
      const { payload, latencyMs } = await fetchJsonWithTimeout(url, { fetchImpl, timeoutMs });
      quotaGuard.recordChannelLookup?.({
        handle: normalizedHandle,
        status: "ok",
        latencyMs,
        nowMs
      });
      const item = payload?.items?.[0] || null;
      const channelId = normalizeId(item?.id);
      const result = {
        status: channelId ? "resolved" : "not_found",
        reason: channelId ? null : "channel_handle_not_found",
        handle: normalizedHandle,
        channelId: channelId || null,
        title: item?.snippet?.title ? String(item.snippet.title) : null,
        latencyMs
      };
      cache.set(cacheKey, result, YOUTUBE_CACHE_TTL_MS.channelLookup, nowMs);
      return result;
    } catch (error) {
      quotaGuard.recordChannelLookup?.({
        handle: normalizedHandle,
        status: "error",
        latencyMs: Date.now() - startedAt,
        nowMs
      });
      throw error;
    }
  });
}

export async function discoverLiveVideoIdBySearch(channelId, options = {}) {
  const normalizedChannelId = normalizeId(channelId);
  const quotaGuard = options.quotaGuard || defaultYoutubeQuotaGuard;
  const cache = options.cache || defaultYoutubeLiveCache;
  const apiKey = getApiKey({ ...options, quotaGuard });
  const nowMs = options.nowMs || Date.now();
  const priority = normalizePriority(options.priority);
  const force = options.force === true;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!normalizedChannelId) {
    return {
      status: "skipped",
      reason: "missing_channel_id",
      videoId: null
    };
  }

  const allowance = quotaGuard.canUseSearch({
    channelId: normalizedChannelId,
    priority,
    force,
    nowMs
  });
  if (!allowance.allowed) {
    return {
      status: "quota_limited",
      reason: allowance.reason,
      nextAllowedAt: allowance.nextAllowedAt || null,
      videoId: null
    };
  }

  if (!apiKey) {
    return {
      status: "quota_limited",
      reason: "missing_youtube_api_key",
      videoId: null
    };
  }

  return cache.withInFlight(`youtube_live_search:${normalizedChannelId}`, async () => {
    const url = new URL(YOUTUBE_SEARCH_URL);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("channelId", normalizedChannelId);
    url.searchParams.set("eventType", "live");
    url.searchParams.set("type", "video");
    url.searchParams.set("videoEmbeddable", "true");
    url.searchParams.set("maxResults", "1");
    url.searchParams.set("key", apiKey);
    const startedAt = Date.now();

    try {
      const { payload, latencyMs } = await fetchJsonWithTimeout(url, { fetchImpl, timeoutMs });
      quotaGuard.recordSearch({
        channelId: normalizedChannelId,
        priority,
        status: "ok",
        latencyMs,
        nowMs
      });
      const videoId = normalizeVideoId(payload?.items?.[0]?.id?.videoId);
      return {
        status: videoId ? "live" : "not_found",
        reason: videoId ? null : "no_live_video_found",
        videoId: videoId || null,
        latencyMs
      };
    } catch (error) {
      quotaGuard.recordSearch({
        channelId: normalizedChannelId,
        priority,
        status: "error",
        latencyMs: Date.now() - startedAt,
        nowMs
      });
      throw error;
    }
  });
}

async function resolveOneFromSearch(streamConfig = {}, options = {}) {
  const cache = options.cache || defaultYoutubeLiveCache;
  const quotaGuard = options.quotaGuard || defaultYoutubeQuotaGuard;
  const nowMs = options.nowMs || Date.now();
  const channelId = normalizeId(streamConfig.channelId);
  const streamId = normalizeId(streamConfig.id);
  const staleEntry = cache.getStale(streamCacheKey(streamId), nowMs);

  try {
    const discovered = await discoverLiveVideoIdBySearch(channelId, {
      ...options,
      priority: normalizePriority(streamConfig.priority),
      force: options.force === true
    });

    if (discovered.status === "live" && discovered.videoId) {
      const result = buildVideoResult(streamConfig, discovered.videoId, "live_verified", {
        nowMs,
        source: "search.list",
        metadata: {
          upstreamLatencyMs: discovered.latencyMs ?? null
        }
      });
      cache.set(streamCacheKey(streamId), result, YOUTUBE_CACHE_TTL_MS.verifiedLive, nowMs);
      if (channelId) {
        cache.set(liveCacheKey(channelId), result, YOUTUBE_CACHE_TTL_MS.verifiedLive, nowMs);
      }
      return result;
    }

    if (discovered.status === "quota_limited") {
      const stale = buildStaleIfAvailable(streamConfig, staleEntry, discovered.reason, nowMs);
      if (stale) {
        return stale;
      }
      const result = buildFallbackResult(streamConfig, "quota_limited", {
        nowMs,
        errorReason: discovered.reason || "youtube_search_quota_limited"
      });
      cache.set(streamCacheKey(streamId), result, YOUTUBE_CACHE_TTL_MS.quotaLimited, nowMs);
      return result;
    }

    const result = buildFallbackResult(streamConfig, "channel_fallback", {
      nowMs,
      metadata: {
        reason: discovered.reason || "no_live_video_found",
        source: "search.list"
      }
    });
    cache.set(streamCacheKey(streamId), result, YOUTUBE_CACHE_TTL_MS.channelFallback, nowMs);
    return result;
  } catch (error) {
    const stale = buildStaleIfAvailable(streamConfig, staleEntry, safeErrorReason(error), nowMs);
    if (stale) {
      return stale;
    }

    const result = buildFallbackResult(streamConfig, "error", {
      nowMs,
      errorReason: safeErrorReason(error)
    });
    cache.set(streamCacheKey(streamId), result, YOUTUBE_CACHE_TTL_MS.error, nowMs);
    return result;
  } finally {
    quotaGuard.getNextSearchAt(channelId, streamConfig.priority, nowMs);
  }
}

function buildStaleIfAvailable(streamConfig = {}, staleEntry = null, errorReason = "youtube_request_failed", nowMs = Date.now()) {
  const staleValue = staleEntry?.value || null;
  if (!staleValue?.videoId || !["live_verified", "cached_verified", "last_known_stale"].includes(staleValue.availability)) {
    return null;
  }

  return compactStream({
    ...staleValue,
    availability: "last_known_stale",
    resolvedAt: new Date(nowMs).toISOString(),
    cacheAgeSec: Math.max(0, Math.round((staleEntry.ageMs || 0) / 1_000)),
    nextResolveAt: new Date(nowMs + YOUTUBE_CACHE_TTL_MS.error).toISOString(),
    errorReason: safeErrorReason(errorReason),
    fallbackUrl: staleValue.fallbackUrl || resolveFallbackUrl(streamConfig)
  });
}

function normalizeNonYoutubeStream(streamConfig = {}, nowMs = Date.now()) {
  const base = baseNormalizedStream(streamConfig);
  if (streamConfig.enabled === false) {
    return withResolutionMeta(base, {
      availability: "unavailable",
      ttlMs: 0,
      nowMs,
      errorReason: "stream_disabled"
    });
  }

  if (streamConfig.embedUrl || streamConfig.staticEmbedUrl) {
    return withResolutionMeta(
      {
        ...base,
        mode: "embed",
        embedUrl: streamConfig.embedUrl || streamConfig.staticEmbedUrl
      },
      {
        availability: "manual_fallback",
        ttlMs: 0,
        nowMs
      }
    );
  }

  return withResolutionMeta(base, {
    availability: "unavailable",
    ttlMs: 0,
    nowMs
  });
}

async function resolvePreparedStreams(streamConfigs = [], options = {}) {
  const cache = options.cache || defaultYoutubeLiveCache;
  const quotaGuard = options.quotaGuard || defaultYoutubeQuotaGuard;
  const nowMs = options.nowMs || Date.now();
  const force = options.force === true;
  const apiKey = getApiKey({ ...options, quotaGuard });
  const prepared = new Map();
  const unresolvedYoutube = [];

  for (const streamConfig of streamConfigs || []) {
    const streamId = normalizeId(streamConfig.id);
    const provider = normalizeProvider(streamConfig);

    if (!streamId) {
      continue;
    }
    if (streamConfig.enabled === false) {
      prepared.set(streamId, normalizeNonYoutubeStream(streamConfig, nowMs));
      continue;
    }
    if (provider !== "youtube") {
      prepared.set(streamId, normalizeNonYoutubeStream(streamConfig, nowMs));
      continue;
    }

    const manualVideoId = normalizeVideoId(streamConfig.manualVideoId);
    if (manualVideoId) {
      const result = buildVideoResult(streamConfig, manualVideoId, "manual_fallback", {
        nowMs,
        ttlMs: YOUTUBE_CACHE_TTL_MS.manual,
        source: "manualVideoId"
      });
      cache.set(streamCacheKey(streamId), result, YOUTUBE_CACHE_TTL_MS.manual, nowMs);
      prepared.set(streamId, result);
      continue;
    }

    const fresh = force ? null : cache.getFresh(streamCacheKey(streamId), nowMs);
    if (fresh) {
      prepared.set(streamId, toCachedResult(fresh.value, fresh.ageMs, nowMs));
      continue;
    }

    let effectiveStreamConfig = streamConfig;
    let channelLookupReason = null;
    if (!effectiveStreamConfig.channelId && getHandle(effectiveStreamConfig) && apiKey) {
      try {
        const lookup = await resolveChannelIdByHandle(getHandle(effectiveStreamConfig), {
          ...options,
          cache,
          quotaGuard,
          nowMs
        });
        if (lookup.channelId) {
          effectiveStreamConfig = {
            ...effectiveStreamConfig,
            channelId: lookup.channelId
          };
        } else {
          channelLookupReason = lookup.reason || "channel_id_unresolved";
        }
      } catch (error) {
        channelLookupReason = safeErrorReason(error, "channel_id_lookup_failed");
      }
    }

    if (!effectiveStreamConfig.channelId) {
      const result = buildFallbackResult(effectiveStreamConfig, "unavailable", {
        nowMs,
        errorReason:
          channelLookupReason ||
          (getHandle(effectiveStreamConfig) && !apiKey ? "missing_youtube_api_key" : "missing_channel_id")
      });
      cache.set(streamCacheKey(streamId), result, YOUTUBE_CACHE_TTL_MS.channelFallback, nowMs);
      prepared.set(streamId, result);
      continue;
    }

    if (!apiKey) {
      const result = apiUnavailableFallback(effectiveStreamConfig, "missing_youtube_api_key", nowMs);
      cache.set(streamCacheKey(streamId), result, YOUTUBE_CACHE_TTL_MS.channelFallback, nowMs);
      prepared.set(streamId, result);
      continue;
    }

    unresolvedYoutube.push(effectiveStreamConfig);
  }

  if (!unresolvedYoutube.length) {
    return prepared;
  }

  let validationResults = new Map();
  try {
    validationResults = await validateKnownVideoIds(unresolvedYoutube, {
      ...options,
      cache,
      quotaGuard,
      nowMs
    });
  } catch (error) {
    for (const streamConfig of unresolvedYoutube) {
      const streamId = normalizeId(streamConfig.id);
      const stale = buildStaleIfAvailable(
        streamConfig,
        cache.getStale(streamCacheKey(streamId), nowMs),
        safeErrorReason(error),
        nowMs
      );
      if (stale) {
        prepared.set(streamId, stale);
      }
    }
  }

  const needsSearch = [];
  for (const streamConfig of unresolvedYoutube) {
    const streamId = normalizeId(streamConfig.id);
    if (prepared.has(streamId)) {
      continue;
    }

    const validation = validationResults.get(streamId);
    if (validation?.valid && validation.videoId) {
      const result = buildVideoResult(streamConfig, validation.videoId, "live_verified", {
        nowMs,
        source: "videos.list",
        metadata: {
          validation
        }
      });
      cache.set(streamCacheKey(streamId), result, YOUTUBE_CACHE_TTL_MS.verifiedLive, nowMs);
      cache.set(liveCacheKey(streamConfig.channelId), result, YOUTUBE_CACHE_TTL_MS.verifiedLive, nowMs);
      prepared.set(streamId, result);
      continue;
    }

    needsSearch.push(streamConfig);
  }

  const concurrency = Math.max(
    1,
    Number.parseInt(String(options.concurrency || process.env.YOUTUBE_RESOLVE_CONCURRENCY || DEFAULT_CONCURRENCY), 10) ||
      DEFAULT_CONCURRENCY
  );
  const searchResults = await runWithConcurrency(needsSearch, concurrency, (streamConfig) =>
    resolveOneFromSearch(streamConfig, {
      ...options,
      cache,
      quotaGuard,
      nowMs
    })
  );

  for (let index = 0; index < needsSearch.length; index += 1) {
    prepared.set(normalizeId(needsSearch[index].id), searchResults[index]);
  }

  return prepared;
}

export async function resolveYoutubeLiveStreams(streamConfigs = [], options = {}) {
  const prepared = await resolvePreparedStreams(streamConfigs, options);
  return (streamConfigs || [])
    .map((streamConfig) => prepared.get(normalizeId(streamConfig.id)))
    .filter(Boolean)
    .map((item) => compactStream(item));
}

export async function resolveYoutubeLiveStream(streamConfig = {}, options = {}) {
  const cache = options.cache || defaultYoutubeLiveCache;
  return cache.withInFlight(streamCacheKey(streamConfig.id), async () => {
    const results = await resolveYoutubeLiveStreams([streamConfig], options);
    return results[0] || buildFallbackResult(streamConfig, "error", {
      nowMs: options.nowMs || Date.now(),
      errorReason: "resolver_empty_result"
    });
  });
}

export function buildYoutubeFallbackStream(streamConfig = {}, options = {}) {
  return buildFallbackResult(streamConfig, options.availability || "channel_fallback", {
    nowMs: options.nowMs || Date.now(),
    errorReason: options.errorReason
  });
}

export function buildYoutubeConfigStream(streamConfig = {}, options = {}) {
  const cache = options.cache || defaultYoutubeLiveCache;
  const nowMs = options.nowMs || Date.now();
  const fresh = cache.getFresh(streamCacheKey(streamConfig.id), nowMs);
  if (fresh) {
    return toCachedResult(fresh.value, fresh.ageMs, nowMs);
  }

  if (normalizeProvider(streamConfig) !== "youtube") {
    return normalizeNonYoutubeStream(streamConfig, nowMs);
  }

  const manualVideoId = normalizeVideoId(streamConfig.manualVideoId);
  if (manualVideoId) {
    return buildVideoResult(streamConfig, manualVideoId, "manual_fallback", {
      nowMs,
      ttlMs: YOUTUBE_CACHE_TTL_MS.manual,
      source: "manualVideoId"
    });
  }

  if (!streamConfig.channelId) {
    return buildFallbackResult(streamConfig, "unavailable", {
      nowMs,
      errorReason: "missing_channel_id"
    });
  }

  return buildFallbackResult(streamConfig, "channel_fallback", {
    nowMs,
    errorReason: options.errorReason
  });
}
