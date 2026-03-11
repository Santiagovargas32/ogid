import test from "node:test";
import assert from "node:assert/strict";
import MediaStreamService from "../services/media/mediaStreamService.js";
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

test("media stream service keeps the last valid embed url on resolver error", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(LIVE_HTML, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    throw new Error("network-down");
  };

  const service = new MediaStreamService({
    catalog: {
      situational: [
        {
          id: "bbc-news",
          name: "BBC News",
          kind: "youtube",
          channelHandle: "BBCNews",
          fallbackUrl: "https://www.youtube.com/@BBCNews/streams"
        }
      ],
      webcams: []
    },
    fetchImpl,
    timeoutMs: 1_000
  });

  const firstSnapshot = await service.getSnapshot({ force: true });
  const firstStream = firstSnapshot.sections.situational[0];
  assert.equal(firstStream.availability, "live");
  assert.equal(firstStream.mode, "embed");
  assert.equal(firstStream.embedUrl, "https://www.youtube.com/embed/EcOPAnQb1w0");

  const secondSnapshot = await service.getSnapshot({ force: true });
  const secondStream = secondSnapshot.sections.situational[0];
  assert.equal(secondStream.availability, "error");
  assert.equal(secondStream.mode, "embed");
  assert.equal(secondStream.embedUrl, "https://www.youtube.com/embed/EcOPAnQb1w0");
});

