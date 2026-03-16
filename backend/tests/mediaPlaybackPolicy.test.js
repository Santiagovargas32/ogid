import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCollectionPlaybackSignature,
  buildStreamPlaybackSignature,
  resolveVideoStreamSelection
} from "../../frontend/js/media/mediaPlaybackPolicy.js";

test("media playback policy keeps the same signature when availability changes but urls do not", () => {
  const baseline = buildStreamPlaybackSignature({
    id: "al-jazeera",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/example",
    fallbackUrl: "https://www.youtube.com/@aljazeeraenglish/streams",
    availability: "live"
  });
  const refreshed = buildStreamPlaybackSignature({
    id: "al-jazeera",
    mode: "embed",
    embedUrl: "https://www.youtube.com/embed/example",
    fallbackUrl: "https://www.youtube.com/@aljazeeraenglish/streams",
    availability: "error"
  });

  assert.equal(baseline, refreshed);
});

test("media playback policy resolves selected stream from preferred id and region", () => {
  const selection = resolveVideoStreamSelection(
    [
      { id: "reuters", region: "Global", mode: "embed", embedUrl: "a", fallbackUrl: "b" },
      { id: "al-jazeera", region: "MENA", mode: "embed", embedUrl: "c", fallbackUrl: "d" }
    ],
    {
      selectedRegion: "MENA",
      selectedId: "al-jazeera"
    }
  );

  assert.equal(selection.selectedRegion, "MENA");
  assert.equal(selection.selectedId, "al-jazeera");
  assert.equal(selection.selected?.embedUrl, "c");
});

test("media playback policy prioritizes an explicitly selected region over a previous stream id", () => {
  const selection = resolveVideoStreamSelection(
    [
      { id: "reuters", region: "Global", mode: "embed", embedUrl: "a", fallbackUrl: "b" },
      { id: "sky-news", region: "Europe", mode: "embed", embedUrl: "c", fallbackUrl: "d" }
    ],
    {
      selectedRegion: "Europe",
      selectedId: "reuters"
    }
  );

  assert.equal(selection.selectedRegion, "Europe");
  assert.equal(selection.selectedId, "sky-news");
  assert.equal(selection.selected?.embedUrl, "c");
  assert.deepEqual(selection.filteredStreams.map((item) => item.id), ["sky-news"]);
});

test("media playback policy builds a stable collection signature for webcam grids", () => {
  const signature = buildCollectionPlaybackSignature([
    { id: "cam-1", mode: "embed", embedUrl: "https://example.com/1", fallbackUrl: "https://example.com/f1" },
    { id: "cam-2", mode: "link", embedUrl: "", fallbackUrl: "https://example.com/f2" }
  ]);

  assert.match(signature, /cam-1\|embed\|https:\/\/example.com\/1\|https:\/\/example.com\/f1/);
  assert.match(signature, /cam-2\|link\|\|https:\/\/example.com\/f2/);
});
