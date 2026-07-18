import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCanonicalRssCatalog } from "../services/news/rssCanonicalCatalog.js";
import { compareRssSnapshots, RssCanonicalPipeline } from "../services/news/rssCanonicalPipeline.js";
import { RssAggregatorService } from "../services/news/rssAggregator.js";

const xml = (title = "Canonical item") => `<?xml version="1.0"?><rss><channel><title>Test</title><item><title>${title}</title><link>https://news.test/item</link><description>Conflict update</description><pubDate>Sat, 11 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
const response = (body, status = 200, headers = {}) => new Response(body, { status, headers });
const feed = (id, host = "feeds.test", extras = {}) => ({ feedId: id, label: id, url: `https://${host}/${id}.xml`, minPollIntervalMs: 1, ...extras });

test("canonical catalog deduplicates primary and secondary feeds by URL and feedId", () => {
  const catalog = buildCanonicalRssCatalog({ primaryFeeds: [{ feedId: "world", url: "HTTPS://EXAMPLE.COM:443/rss?b=2&a=1" }], secondaryFeeds: [{ url: "https://example.com/rss?a=1&b=2" }, { feedId: "world", url: "https://mirror.test/rss" }] });
  assert.equal(catalog.feeds.length, 1); assert.equal(catalog.stats.duplicatesRemoved, 2); assert.deepEqual(catalog.feeds[0].origins, ["primary", "secondary"]);
});

test("conditional requests retain ETag and project 304 without losing corpus", async () => {
  let now = 1_000; const requests = [];
  const catalog = buildCanonicalRssCatalog({ primaryFeeds: [feed("etag")] });
  const pipeline = new RssCanonicalPipeline({ catalog, now: () => now, fetchImpl: async (_url, options) => { requests.push(options.headers); return requests.length === 1 ? response(xml(), 200, { ETag: '"v1"', "Last-Modified": "Sat, 11 Jul 2026 12:00:00 GMT" }) : response(null, 304); } });
  const first = await pipeline.runCycle(); now += 2; const second = await pipeline.runCycle();
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 1); assert.equal(second.meta.feedStatus[0].status, "not-modified"); assert.equal(requests[1]["If-None-Match"], '"v1"');
});

test("malformed XML serves the last good item as stale and enters cooldown", async () => {
  let now = 2_000; let calls = 0; const catalog = buildCanonicalRssCatalog({ primaryFeeds: [feed("malformed")] });
  const pipeline = new RssCanonicalPipeline({ catalog, now: () => now, fetchImpl: async () => response(++calls === 1 ? xml() : "<html>broken</html>") });
  await pipeline.runCycle(); now += 2; const snapshot = await pipeline.runCycle(); const state = pipeline.state("malformed");
  assert.equal(snapshot.meta.feedStatus[0].status, "stale"); assert.equal(snapshot.items[0].dataMode, "stale"); assert.equal(snapshot.items[0].provenance.stale, true); assert.equal(state.healthStatus, "degraded"); assert.ok(state.cooldownUntil > now); assert.equal(pipeline.selectEligible(now).length, 0);
});

test("slow sources are bounded by the cycle deadline", async () => {
  const catalog = buildCanonicalRssCatalog({ primaryFeeds: [feed("slow")] });
  const pipeline = new RssCanonicalPipeline({ catalog, cycleDeadlineMs: 10, timeoutMs: 100, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
  const started = Date.now(); const snapshot = await pipeline.runCycle();
  assert.ok(Date.now() - started < 200); assert.equal(snapshot.meta.feedStatus[0].status, "error");
});

test("selection is fair after the first bounded batch", async () => {
  let now = 5_000; const feeds = Array.from({ length: 13 }, (_, index) => feed(`fair-${String(index).padStart(2, "0")}`, `host-${index}.test`, { minPollIntervalMs: 10_000 }));
  const catalog = buildCanonicalRssCatalog({ primaryFeeds: feeds }); const pipeline = new RssCanonicalPipeline({ catalog, now: () => now, maxFeedsPerCycle: 12, fetchImpl: async () => response(xml()) });
  const firstIds = pipeline.selectEligible(now).map((item) => item.feedId); await pipeline.runCycle(); const nextIds = pipeline.selectEligible(now).map((item) => item.feedId);
  assert.equal(firstIds.length, 12); assert.deepEqual(nextIds, ["fair-12"]);
});

test("state, validators and corpus survive restart", async () => {
  let now = 7_000; const stateFile = join(mkdtempSync(join(tmpdir(), "rss-canonical-")), "state.json"); const catalog = buildCanonicalRssCatalog({ primaryFeeds: [feed("restart")] });
  const first = new RssCanonicalPipeline({ catalog, now: () => now, persistencePath: stateFile, fetchImpl: async () => response(xml(), 200, { ETag: '"restart"' }) }); await first.runCycle();
  const second = new RssCanonicalPipeline({ catalog, now: () => now, persistencePath: stateFile, fetchImpl: async () => response(null, 304) });
  assert.equal(second.corpus.length, 1); assert.equal(second.state("restart").etag, '"restart"');
});

test("cross-pipeline comparison reports overlap without publishing duplicates", () => {
  const article = { title: "Same", url: "https://news.test/same" }; const comparison = compareRssSnapshots({ articles: [article, article] }, { items: [article] });
  assert.deepEqual(comparison, { legacyCount: 1, canonicalCount: 1, overlap: 1, coverage: 1, crossPipelineDuplicates: 1 });
});

test("rollback keeps canonical state available while returning to legacy mode", () => {
  const pipeline = new RssCanonicalPipeline({ catalog: buildCanonicalRssCatalog({ primaryFeeds: [feed("rollback")] }) }); pipeline.corpus = [{ id: "kept" }]; pipeline.state("rollback");
  assert.deepEqual(pipeline.rollback(), { mode: "legacy", corpusPreserved: 1, statePreserved: 1 });
});

test("shadow mode publishes only the legacy projection and records equivalence", async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => response(xml());
  try {
    const service = new RssAggregatorService({ rssFeeds: [feed("shadow")], refreshIntervalMs: 900_000, maxFeedsPerRun: 12, maxCorpusItems: 50, pipelineMode: "shadow", canonicalFetchImpl: async () => response(xml()) });
    const snapshot = await service.refresh({ force: true });
    assert.equal(snapshot.meta.pipelineMode, "shadow"); assert.equal(snapshot.meta.shadow, true); assert.equal(snapshot.meta.equivalence.coverage, 1); assert.equal(snapshot.items.length, 1);
    service.rollbackToLegacy(); assert.equal(service.pipelineMode, "legacy");
  } finally { globalThis.fetch = originalFetch; }
});
