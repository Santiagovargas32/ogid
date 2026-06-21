import test from "node:test";
import assert from "node:assert/strict";
import MediaStreamService from "../services/media/mediaStreamService.js";
import { YoutubeLiveCache } from "../services/media/youtubeLiveCache.js";
import { YoutubeQuotaGuard } from "../services/media/youtubeQuotaGuard.js";
import { parseYoutubeLiveVideoIdFromHtml } from "../services/media/youtubeStreamResolver.js";

const LIVE_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var ytInitialData = {"contents":{"twoColumnBrowseResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[{"itemSectionRenderer":{"contents":[{"gridRenderer":{"items":[{"gridVideoRenderer":{"videoId":"EcOPAnQb1w0","thumbnailOverlays":[{"thumbnailOverlayTimeStatusRenderer":{"style":"LIVE","text":{"runs":[{"text":"LIVE"}]}}}]}}]}}]}}]}}}}]}}};
    </script>
  </body>
</html>`;

const OFFLINE_HTML = `<!doctype html>
<html>
  <body>
    <script>
      var ytInitialData = {"contents":{"twoColumnBrowseResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[{"itemSectionRenderer":{"contents":[{"gridRenderer":{"items":[{"gridVideoRenderer":{"videoId":"dQw4w9WgXcQ","thumbnailOverlays":[{"thumbnailOverlayTimeStatusRenderer":{"style":"DEFAULT","text":{"runs":[{"text":"12:33"}]}}}]}}]}}]}}]}}}}]}}};
    </script>
  </body>
</html>`;

const TEST_CATALOG = {
  situational: [
    {
      id: "alpha",
      name: "Alpha",
      region: "Global",
      provider: "youtube",
      mode: "embed",
      channelId: "UC_ALPHA",
      fallbackUrl: "https://www.youtube.com/@alpha/streams",
      manualVideoId: null,
      lastKnownVideoId: null,
      priority: "critical",
      enabled: true
    },
    {
      id: "bravo",
      name: "Bravo",
      region: "Global",
      provider: "youtube",
      mode: "embed",
      channelId: "UC_BRAVO",
      fallbackUrl: "https://www.youtube.com/@bravo/streams",
      manualVideoId: null,
      lastKnownVideoId: null,
      priority: "normal",
      enabled: true
    }
  ],
  webcams: []
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createService({ catalog = TEST_CATALOG, fetchImpl, apiKey = "test-key", searchDailyBudget = 80 } = {}) {
  const cache = new YoutubeLiveCache();
  const quotaGuard = new YoutubeQuotaGuard({
    apiKey,
    searchDailyBudget,
    searchReserve: 0,
    criticalRefreshHours: 6,
    normalRefreshHours: 12,
    lazyRefreshHours: 24
  });

  return new MediaStreamService({
    catalog,
    fetchImpl,
    timeoutMs: 500,
    youtubeLiveCache: cache,
    youtubeQuotaGuard: quotaGuard,
    resolveConcurrency: 2
  });
}

test("youtube parser resolves live video id from ytInitialData payload", () => {
  const videoId = parseYoutubeLiveVideoIdFromHtml(LIVE_HTML);
  assert.equal(videoId, "EcOPAnQb1w0");
});

test("youtube parser returns null when no live badge is present", () => {
  const videoId = parseYoutubeLiveVideoIdFromHtml(OFFLINE_HTML);
  assert.equal(videoId, null);
});

test("youtube parser handles invalid html payloads without throwing", () => {
  const videoId = parseYoutubeLiveVideoIdFromHtml("<html><body>not valid</body></html>");
  assert.equal(videoId, null);
});

test("media stream service falls back without API key and avoids YouTube API calls", async () => {
  let fetchCalls = 0;
  const service = createService({
    apiKey: "",
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    }
  });

  const snapshot = await service.getSnapshot({ force: true, resolve: "all" });
  assert.equal(fetchCalls, 0);
  assert.equal(snapshot.sections.situational.length, 2);
  assert.ok(snapshot.sections.situational.every((item) => item.availability === "channel_fallback"));
  assert.ok(snapshot.sections.situational.every((item) => item.errorReason === "missing_youtube_api_key"));
});

test("manualVideoId takes precedence over cache and API", async () => {
  let fetchCalls = 0;
  const service = createService({
    catalog: {
      situational: [
        {
          ...TEST_CATALOG.situational[0],
          manualVideoId: "EcOPAnQb1w0"
        }
      ],
      webcams: []
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    }
  });

  const snapshot = await service.getSnapshot({ force: true, resolve: "all" });
  const stream = snapshot.sections.situational[0];
  assert.equal(fetchCalls, 0);
  assert.equal(stream.availability, "manual_fallback");
  assert.equal(stream.videoId, "EcOPAnQb1w0");
  assert.match(stream.embedUrl, /youtube\.com\/embed\/EcOPAnQb1w0/);
});

test("bulk validation validates multiple last known video ids with one videos.list call", async () => {
  const urls = [];
  const service = createService({
    catalog: {
      situational: [
        {
          ...TEST_CATALOG.situational[0],
          lastKnownVideoId: "EcOPAnQb1w0"
        },
        {
          ...TEST_CATALOG.situational[1],
          lastKnownVideoId: "dQw4w9WgXcQ"
        }
      ],
      webcams: []
    },
    fetchImpl: async (url) => {
      urls.push(String(url));
      assert.match(String(url), /youtube\/v3\/videos/);
      return jsonResponse({
        items: [
          {
            id: "EcOPAnQb1w0",
            snippet: { liveBroadcastContent: "live" },
            liveStreamingDetails: { actualStartTime: "2026-06-21T10:00:00Z" },
            status: { embeddable: true }
          },
          {
            id: "dQw4w9WgXcQ",
            snippet: { liveBroadcastContent: "live" },
            liveStreamingDetails: { actualStartTime: "2026-06-21T10:00:00Z" },
            status: { embeddable: true }
          }
        ]
      });
    }
  });

  const snapshot = await service.getSnapshot({ force: true, resolve: "all" });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes("id=EcOPAnQb1w0%2CdQw4w9WgXcQ") || urls[0].includes("id=EcOPAnQb1w0,dQw4w9WgXcQ"));
  assert.ok(snapshot.sections.situational.every((item) => item.availability === "live_verified"));
});

test("search.list is called only for streams without a valid known video id", async () => {
  const urls = [];
  const service = createService({
    catalog: {
      situational: [
        {
          ...TEST_CATALOG.situational[0],
          lastKnownVideoId: "EcOPAnQb1w0"
        },
        TEST_CATALOG.situational[1]
      ],
      webcams: []
    },
    fetchImpl: async (url) => {
      const value = String(url);
      urls.push(value);
      if (value.includes("/youtube/v3/videos")) {
        return jsonResponse({
          items: [
            {
              id: "EcOPAnQb1w0",
              snippet: { liveBroadcastContent: "live" },
              liveStreamingDetails: { actualStartTime: "2026-06-21T10:00:00Z" },
              status: { embeddable: true }
            }
          ]
        });
      }
      if (value.includes("/youtube/v3/search")) {
        return jsonResponse({
          items: [{ id: { videoId: "oHg5SJYRHA0" }, snippet: {} }]
        });
      }
      return jsonResponse({});
    }
  });

  const snapshot = await service.getSnapshot({ force: true, resolve: "all" });
  assert.equal(urls.filter((url) => url.includes("/youtube/v3/videos")).length, 1);
  assert.equal(urls.filter((url) => url.includes("/youtube/v3/search")).length, 1);
  assert.deepEqual(
    snapshot.sections.situational.map((item) => item.videoId),
    ["EcOPAnQb1w0", "oHg5SJYRHA0"]
  );
});

test("handle-only streams resolve channel id before live search", async () => {
  const urls = [];
  const service = createService({
    catalog: {
      situational: [
        {
          id: "bbc-news",
          name: "BBC News",
          region: "Global",
          provider: "youtube",
          mode: "external",
          channelId: null,
          handle: "@BBCNews",
          fallbackUrl: "https://www.youtube.com/@BBCNews/streams",
          manualVideoId: null,
          lastKnownVideoId: null,
          priority: "normal",
          enabled: true
        }
      ],
      webcams: []
    },
    fetchImpl: async (url) => {
      const value = String(url);
      urls.push(value);
      if (value.includes("/youtube/v3/channels")) {
        const parsed = new URL(value);
        assert.equal(parsed.searchParams.get("forHandle"), "@BBCNews");
        return jsonResponse({
          items: [{ id: "UC_BBC_NEWS", snippet: { title: "BBC News" } }]
        });
      }
      if (value.includes("/youtube/v3/search")) {
        const parsed = new URL(value);
        assert.equal(parsed.searchParams.get("channelId"), "UC_BBC_NEWS");
        return jsonResponse({
          items: [{ id: { videoId: "oHg5SJYRHA0" }, snippet: {} }]
        });
      }
      return jsonResponse({});
    }
  });

  const snapshot = await service.getSnapshot({ force: true, resolve: "all" });
  const stream = snapshot.sections.situational[0];
  assert.equal(urls.filter((url) => url.includes("/youtube/v3/channels")).length, 1);
  assert.equal(urls.filter((url) => url.includes("/youtube/v3/search")).length, 1);
  assert.equal(stream.channelId, "UC_BBC_NEWS");
  assert.equal(stream.availability, "live_verified");
  assert.equal(stream.videoId, "oHg5SJYRHA0");
});

test("no active live stream uses channel fallback without error state", async () => {
  const service = createService({
    catalog: {
      situational: [TEST_CATALOG.situational[0]],
      webcams: []
    },
    fetchImpl: async (url) => {
      assert.match(String(url), /youtube\/v3\/search/);
      return jsonResponse({ items: [] });
    }
  });

  const snapshot = await service.getSnapshot({ force: true, resolve: "all" });
  const stream = snapshot.sections.situational[0];
  assert.equal(stream.availability, "channel_fallback");
  assert.equal(stream.errorReason, undefined);
  assert.equal(stream.metadata.reason, "no_live_video_found");
});

test("quota guard returns quota_limited fallback when search budget is exhausted", async () => {
  let fetchCalls = 0;
  const service = createService({
    searchDailyBudget: 0,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    }
  });

  const snapshot = await service.getSnapshot({ force: true, resolve: "visible", ids: ["alpha"] });
  const stream = snapshot.sections.situational.find((item) => item.id === "alpha");
  assert.equal(fetchCalls, 0);
  assert.equal(stream.availability, "quota_limited");
  assert.equal(stream.errorReason, "youtube_search_budget_exhausted");
});

test("stale-if-error returns last verified video when validation fails", async () => {
  let callCount = 0;
  const service = createService({
    catalog: {
      situational: [
        {
          ...TEST_CATALOG.situational[0],
          lastKnownVideoId: "EcOPAnQb1w0"
        }
      ],
      webcams: []
    },
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse({
          items: [
            {
              id: "EcOPAnQb1w0",
              snippet: { liveBroadcastContent: "live" },
              liveStreamingDetails: { actualStartTime: "2026-06-21T10:00:00Z" },
              status: { embeddable: true }
            }
          ]
        });
      }
      return jsonResponse({ error: { message: "upstream down" } }, 500);
    }
  });

  const firstSnapshot = await service.getSnapshot({ force: true, resolve: "all" });
  assert.equal(firstSnapshot.sections.situational[0].availability, "live_verified");
  service.youtubeLiveCache.cache.delete("youtube_video_validation:EcOPAnQb1w0");

  const secondSnapshot = await service.getSnapshot({ force: true, resolve: "all" });
  assert.equal(secondSnapshot.sections.situational[0].availability, "last_known_stale");
  assert.equal(secondSnapshot.sections.situational[0].videoId, "EcOPAnQb1w0");
});
