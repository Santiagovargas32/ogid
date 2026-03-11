import { buildDefaultMediaCatalog } from "./mediaCatalog.js";
import { resolveYoutubeLiveStream } from "./youtubeStreamResolver.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("backend/services/media/mediaStreamService");

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

function clone(value) {
  return structuredClone(value);
}

function buildSummary(flatItems = []) {
  const summary = {
    total: flatItems.length,
    live: 0,
    offline: 0,
    error: 0,
    unverified: 0,
    embedded: 0,
    linkOnly: 0
  };

  for (const item of flatItems) {
    if (item.mode === "embed") {
      summary.embedded += 1;
    } else {
      summary.linkOnly += 1;
    }

    if (item.availability === "live") {
      summary.live += 1;
      continue;
    }
    if (item.availability === "offline") {
      summary.offline += 1;
      continue;
    }
    if (item.availability === "error") {
      summary.error += 1;
      continue;
    }
    summary.unverified += 1;
  }

  return summary;
}

class MediaStreamService {
  constructor({
    catalog = buildDefaultMediaCatalog(),
    refreshIntervalMs = 300_000,
    timeoutMs = 8_000,
    fetchImpl = fetch
  } = {}) {
    this.catalog = clone(catalog);
    this.refreshIntervalMs = normalizeRefreshIntervalMs(refreshIntervalMs);
    this.timeoutMs = normalizeTimeoutMs(timeoutMs);
    this.fetchImpl = fetchImpl;
    this.lastKnownEmbedById = new Map();
    this.snapshot = {
      generatedAt: null,
      summary: buildSummary([]),
      sections: {
        situational: [],
        webcams: []
      }
    };
    this.refreshInFlight = null;
    this.timerHandle = null;
  }

  start() {
    if (this.timerHandle) {
      return;
    }

    this.refresh("startup").catch((error) => {
      log.warn("media_stream_refresh_failed", {
        trigger: "startup",
        message: error.message
      });
    });

    this.timerHandle = setInterval(() => {
      this.refresh("interval").catch((error) => {
        log.warn("media_stream_refresh_failed", {
          trigger: "interval",
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

  async getSnapshot({ force = false } = {}) {
    if (force || !this.snapshot.generatedAt) {
      await this.refresh(force ? "force" : "on-demand");
    }
    return clone(this.snapshot);
  }

  async refresh(trigger = "manual") {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      const startedAt = Date.now();
      const [situational, webcams] = await Promise.all([
        Promise.all((this.catalog.situational || []).map((item) => this.resolveItem(item))),
        Promise.all((this.catalog.webcams || []).map((item) => this.resolveItem(item)))
      ]);

      const generatedAt = new Date().toISOString();
      const flat = [...situational, ...webcams];
      this.snapshot = {
        generatedAt,
        summary: buildSummary(flat),
        sections: {
          situational,
          webcams
        }
      };

      log.info("media_stream_refresh_completed", {
        trigger,
        total: flat.length,
        live: this.snapshot.summary.live,
        offline: this.snapshot.summary.offline,
        error: this.snapshot.summary.error,
        durationMs: Date.now() - startedAt
      });

      return clone(this.snapshot);
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  async resolveItem(item = {}) {
    const base = {
      id: item.id,
      name: item.name,
      kind: item.kind,
      region: item.region || null,
      category: item.category || null,
      channelHandle: item.channelHandle || null,
      channelId: item.channelId || null,
      fallbackUrl: item.fallbackUrl || null
    };

    if (item.kind !== "youtube") {
      return {
        ...base,
        mode: "link",
        availability: "unverified",
        embedUrl: null,
        streamsUrl: null,
        resolvedAt: new Date().toISOString()
      };
    }

    const resolved = await resolveYoutubeLiveStream({
      item,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl
    });
    const resolvedAt = new Date().toISOString();

    if (resolved.status === "live") {
      this.lastKnownEmbedById.set(item.id, resolved.embedUrl);
      return {
        ...base,
        mode: "embed",
        availability: "live",
        videoId: resolved.videoId,
        embedUrl: resolved.embedUrl,
        watchUrl: resolved.watchUrl || null,
        streamsUrl: resolved.streamsUrl || null,
        resolvedAt
      };
    }

    if (resolved.status === "offline") {
      return {
        ...base,
        mode: "link",
        availability: "offline",
        videoId: null,
        embedUrl: null,
        watchUrl: null,
        streamsUrl: resolved.streamsUrl || null,
        resolvedAt
      };
    }

    const lastKnownEmbedUrl = this.lastKnownEmbedById.get(item.id) || null;
    if (lastKnownEmbedUrl) {
      return {
        ...base,
        mode: "embed",
        availability: "error",
        videoId: null,
        embedUrl: lastKnownEmbedUrl,
        watchUrl: item.fallbackUrl || null,
        streamsUrl: resolved.streamsUrl || null,
        error: resolved.error || "youtube-request-failed",
        resolvedAt
      };
    }

    return {
      ...base,
      mode: "link",
      availability: "error",
      videoId: null,
      embedUrl: null,
      watchUrl: null,
      streamsUrl: resolved.streamsUrl || null,
      error: resolved.error || "youtube-request-failed",
      resolvedAt
    };
  }
}

export default MediaStreamService;

