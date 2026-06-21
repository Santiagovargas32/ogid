import { buildDefaultMediaCatalog } from "./mediaCatalog.js";
import defaultYoutubeLiveCache from "./youtubeLiveCache.js";
import { YoutubeQuotaGuard } from "./youtubeQuotaGuard.js";
import {
  buildYoutubeConfigStream,
  resolveYoutubeLiveStreams
} from "./youtubeLiveResolver.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("backend/services/media/mediaStreamService");
const LIVE_AVAILABILITY = new Set(["live_verified", "cached_verified", "manual_fallback", "last_known_stale"]);
const ERROR_AVAILABILITY = new Set(["error", "quota_limited"]);

function clone(value) {
  return structuredClone(value);
}

function normalizeRefreshIntervalMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 300_000;
  }
  return Math.max(30_000, Math.round(parsed));
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 8_000;
  }
  return Math.max(1_000, Math.round(parsed));
}

function normalizeResolveMode(value = "critical") {
  const normalized = String(value || "critical").trim().toLowerCase();
  return ["none", "critical", "visible", "all"].includes(normalized) ? normalized : "critical";
}

function normalizeIds(value = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePriority(value = "normal") {
  const normalized = String(value || "normal").toLowerCase();
  return ["critical", "normal", "lazy"].includes(normalized) ? normalized : "normal";
}

function compact(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}

function normalizeExternalStream(item = {}, nowMs = Date.now()) {
  return compact({
    id: String(item.id || ""),
    name: String(item.name || item.id || "External Stream"),
    region: item.region ? String(item.region) : undefined,
    category: item.category ? String(item.category) : undefined,
    provider: String(item.provider || item.kind || "external").toLowerCase(),
    kind: String(item.provider || item.kind || "external").toLowerCase(),
    mode: item.embedUrl ? "embed" : "external",
    embedUrl: item.embedUrl || undefined,
    fallbackUrl: item.fallbackUrl || item.watchUrl || "#",
    priority: normalizePriority(item.priority),
    enabled: item.enabled !== false,
    availability: item.availability || "unavailable",
    resolvedAt: new Date(nowMs).toISOString()
  });
}

function normalizeYoutubeConfig(stream = {}, lastKnownVideoIdById = new Map()) {
  const id = String(stream.id || "");
  return {
    ...stream,
    lastKnownVideoId: lastKnownVideoIdById.get(id) || stream.lastKnownVideoId || null
  };
}

function buildSummary(flatItems = []) {
  const summary = {
    total: flatItems.length,
    enabled: flatItems.filter((item) => item.enabled !== false).length,
    live: 0,
    cached: 0,
    fallback: 0,
    offline: 0,
    error: 0,
    unverified: 0,
    embedded: 0,
    linkOnly: 0
  };

  for (const item of flatItems) {
    if (item.mode === "embed" && item.embedUrl) {
      summary.embedded += 1;
    } else {
      summary.linkOnly += 1;
    }

    if (LIVE_AVAILABILITY.has(item.availability)) {
      summary.live += 1;
    }
    if (item.availability === "cached_verified") {
      summary.cached += 1;
    }
    if (["channel_fallback", "manual_fallback", "quota_limited"].includes(item.availability)) {
      summary.fallback += 1;
    }
    if (item.availability === "unavailable") {
      summary.offline += 1;
    }
    if (ERROR_AVAILABILITY.has(item.availability)) {
      summary.error += 1;
    }
    if (!item.availability || ["unverified", "channel_fallback"].includes(item.availability)) {
      summary.unverified += 1;
    }
  }

  return summary;
}

function streamChangeSignature(stream = {}) {
  return [
    stream.id || "",
    stream.videoId || "",
    stream.embedUrl || "",
    stream.availability || "",
    stream.errorReason || ""
  ].join("|");
}

class MediaStreamService {
  constructor({
    catalog = buildDefaultMediaCatalog(),
    refreshIntervalMs = 300_000,
    timeoutMs = 8_000,
    fetchImpl = fetch,
    youtubeApiKey = "",
    youtube = {},
    youtubeLiveCache = defaultYoutubeLiveCache,
    youtubeQuotaGuard = null,
    resolveConcurrency = 2,
    socketServer = null
  } = {}) {
    this.catalog = clone(catalog);
    this.refreshIntervalMs = normalizeRefreshIntervalMs(refreshIntervalMs);
    this.timeoutMs = normalizeTimeoutMs(timeoutMs);
    this.fetchImpl = fetchImpl;
    this.youtubeLiveCache = youtubeLiveCache;
    this.youtubeQuotaGuard =
      youtubeQuotaGuard ||
      new YoutubeQuotaGuard({
        apiKey: youtubeApiKey || youtube.apiKey || "",
        searchDailyBudget: youtube.searchDailyBudget,
        searchReserve: youtube.searchReserve,
        streamResolvePolicy: youtube.streamResolvePolicy,
        criticalRefreshHours: youtube.criticalRefreshHours,
        normalRefreshHours: youtube.normalRefreshHours,
        lazyRefreshHours: youtube.lazyRefreshHours
      });
    this.resolveConcurrency = Math.max(1, Number.parseInt(String(resolveConcurrency || 2), 10) || 2);
    this.socketServer = socketServer;
    this.lastKnownVideoIdById = new Map();
    this.lastBroadcastSignatureById = new Map();
    this.requestInFlight = new Map();
    this.snapshot = {
      generatedAt: null,
      summary: buildSummary([]),
      sections: {
        situational: [],
        webcams: []
      }
    };
    this.timerHandle = null;
  }

  setSocketServer(socketServer) {
    this.socketServer = socketServer;
  }

  start() {
    if (this.timerHandle) {
      return;
    }

    this.refresh({ trigger: "startup", resolve: "none" }).catch((error) => {
      log.warn("media_stream_refresh_failed", {
        trigger: "startup",
        message: error.message
      });
    });

    this.refresh({ trigger: "startup-critical", resolve: "critical" }).catch((error) => {
      log.warn("media_stream_refresh_failed", {
        trigger: "startup-critical",
        message: error.message
      });
    });

    this.timerHandle = setInterval(() => {
      this.refresh({ trigger: "interval-critical", resolve: "critical" }).catch((error) => {
        log.warn("media_stream_refresh_failed", {
          trigger: "interval-critical",
          message: error.message
        });
      });
    }, this.refreshIntervalMs);
  }

  stop() {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  selectStreams({ resolve = "critical", ids = [] } = {}) {
    const mode = normalizeResolveMode(resolve);
    const requestedIds = new Set(normalizeIds(ids));
    const streams = (this.catalog.situational || []).filter((item) => item.enabled !== false);

    if (mode === "none") {
      return [];
    }
    if (mode === "all") {
      return streams;
    }
    if (mode === "visible") {
      return streams.filter((item) => requestedIds.has(item.id));
    }
    return streams.filter((item) => normalizePriority(item.priority) === "critical");
  }

  buildBaseSituational(nowMs = Date.now()) {
    return (this.catalog.situational || []).map((item) =>
      buildYoutubeConfigStream(normalizeYoutubeConfig(item, this.lastKnownVideoIdById), {
        cache: this.youtubeLiveCache,
        nowMs,
        errorReason: this.youtubeQuotaGuard.hasApiKey() ? undefined : "missing_youtube_api_key"
      })
    );
  }

  buildWebcams(nowMs = Date.now()) {
    return (this.catalog.webcams || []).map((item) => normalizeExternalStream(item, nowMs));
  }

  updateLastKnown(streams = []) {
    for (const stream of streams) {
      if (stream?.id && stream?.videoId && LIVE_AVAILABILITY.has(stream.availability)) {
        this.lastKnownVideoIdById.set(stream.id, stream.videoId);
      }
    }
  }

  broadcastChanges(nextStreams = []) {
    const changedStreams = [];

    for (const stream of nextStreams) {
      const signature = streamChangeSignature(stream);
      const previous = this.lastBroadcastSignatureById.get(stream.id);
      this.lastBroadcastSignatureById.set(stream.id, signature);
      if (previous && previous !== signature) {
        changedStreams.push(stream);
      }
    }

    if (!changedStreams.length || !this.socketServer?.broadcast) {
      return;
    }

    this.socketServer.broadcast("media:streams:updated", {
      updatedAt: new Date().toISOString(),
      changedStreams
    });
  }

  async resolveSelectedStreams({ resolve = "critical", ids = [], force = false, nowMs = Date.now() } = {}) {
    const selected = this.selectStreams({ resolve, ids }).map((item) =>
      normalizeYoutubeConfig(item, this.lastKnownVideoIdById)
    );
    if (!selected.length) {
      return [];
    }

    return resolveYoutubeLiveStreams(selected, {
      cache: this.youtubeLiveCache,
      quotaGuard: this.youtubeQuotaGuard,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      concurrency: this.resolveConcurrency,
      force,
      nowMs
    });
  }

  async getSnapshot({ force = false, resolve = "critical", ids = [] } = {}) {
    const mode = normalizeResolveMode(resolve);
    if (!this.snapshot.generatedAt || force || mode !== "none") {
      await this.refresh({
        trigger: force ? "force" : "on-demand",
        resolve: mode,
        ids,
        force
      });
    }
    return clone(this.snapshot);
  }

  async getStreamById(id, { force = false, resolve = "visible" } = {}) {
    const streamId = String(id || "").trim();
    if (!streamId) {
      return null;
    }
    const snapshot = await this.getSnapshot({
      force,
      resolve,
      ids: [streamId]
    });
    return (
      (snapshot.sections.situational || []).find((item) => item.id === streamId) ||
      (snapshot.sections.webcams || []).find((item) => item.id === streamId) ||
      null
    );
  }

  async refreshStreams({ ids = [], force = false } = {}) {
    const normalizedIds = normalizeIds(ids);
    return this.getSnapshot({
      force,
      resolve: normalizedIds.length ? "visible" : "all",
      ids: normalizedIds
    });
  }

  async refresh(input = "manual", maybeOptions = {}) {
    const options =
      typeof input === "string"
        ? {
            trigger: input,
            ...maybeOptions
          }
        : {
            ...(input || {})
          };
    const trigger = options.trigger || "manual";
    const resolve = normalizeResolveMode(options.resolve || "critical");
    const ids = normalizeIds(options.ids);
    const force = options.force === true;
    const requestKey = `${resolve}:${ids.sort().join(",")}:${force ? "force" : "normal"}`;

    if (this.requestInFlight.has(requestKey)) {
      return this.requestInFlight.get(requestKey);
    }

    const promise = (async () => {
      const startedAt = Date.now();
      const nowMs = Date.now();
      const baseSituational = this.buildBaseSituational(nowMs);
      const resolved = await this.resolveSelectedStreams({ resolve, ids, force, nowMs });
      const resolvedById = new Map(resolved.map((item) => [item.id, item]));
      const situational = baseSituational.map((item) => resolvedById.get(item.id) || item);
      const webcams = this.buildWebcams(nowMs);
      const flat = [...situational, ...webcams];

      this.updateLastKnown(situational);
      this.snapshot = {
        generatedAt: new Date().toISOString(),
        summary: buildSummary(flat),
        sections: {
          situational,
          webcams
        }
      };
      this.broadcastChanges(situational);

      log.info("media_stream_refresh_completed", {
        trigger,
        resolve,
        ids: ids.length,
        total: flat.length,
        live: this.snapshot.summary.live,
        fallback: this.snapshot.summary.fallback,
        error: this.snapshot.summary.error,
        durationMs: Date.now() - startedAt
      });

      return clone(this.snapshot);
    })();

    this.requestInFlight.set(requestKey, promise);
    try {
      return await promise;
    } finally {
      this.requestInFlight.delete(requestKey);
    }
  }

  getHealth() {
    const nowMs = Date.now();
    const cacheDiagnostics = this.youtubeLiveCache.getDiagnostics();
    const quotaStatus = this.youtubeQuotaGuard.getStatus(nowMs);
    const streams = (this.snapshot.sections.situational.length
      ? this.snapshot.sections.situational
      : this.buildBaseSituational(nowMs)
    ).map((stream) => ({
      id: stream.id,
      name: stream.name,
      provider: stream.provider,
      channelId: stream.channelId || null,
      handle: stream.handle || null,
      priority: stream.priority,
      enabled: stream.enabled !== false,
      availability: stream.availability,
      resolvedAt: stream.resolvedAt || null,
      cacheAgeSec: stream.cacheAgeSec ?? null,
      nextResolveAt: stream.nextResolveAt || null,
      errorReason: stream.errorReason || null,
      fallbackUrl: stream.fallbackUrl || null,
      videoId: stream.videoId || null
    }));

    return {
      updatedAt: new Date(nowMs).toISOString(),
      youtube: {
        hasApiKey: quotaStatus.hasApiKey,
        searchDailyBudget: quotaStatus.searchDailyBudget,
        searchReserve: quotaStatus.searchReserve,
        effectiveSearchLimit: quotaStatus.effectiveSearchLimit,
        searchCallsUsedToday: quotaStatus.searchCallsUsedToday,
        searchCallsRemainingToday: quotaStatus.searchCallsRemainingToday,
        validationCallsUsedToday: quotaStatus.validationCallsUsedToday,
        channelLookupCallsUsedToday: quotaStatus.channelLookupCallsUsedToday,
        cacheSize: cacheDiagnostics.cacheSize,
        inFlightCount: cacheDiagnostics.inFlightCount,
        cacheHitRatio: cacheDiagnostics.cacheHitRatio,
        cacheHits: cacheDiagnostics.cacheHits,
        cacheMisses: cacheDiagnostics.cacheMisses
      },
      streams
    };
  }
}

export default MediaStreamService;
