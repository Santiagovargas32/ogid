import test from "node:test";
import assert from "node:assert/strict";
import { buildExtendedRssFeedCatalog, classifyRssArticle } from "../services/news/rssClassifier.js";
import { deduplicateRssArticles } from "../services/news/rssDeduplicator.js";

test("rss classifier keeps RSS sources distinct from 435 generated searches", () => {
  const catalog = buildExtendedRssFeedCatalog([
    { label: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" }
  ]);
  assert.deepEqual(catalog.stats.typeCounts, { rss: 1, generated_search: 435, discovery: 0 });
  assert.equal(catalog.stats.totalCount, 436);

  const classified = classifyRssArticle({
    id: "rss-1",
    title: "Missile strike and cyber disruption hit Tehran and Tel Aviv",
    description: "Sanctions pressure rises after the attack.",
    sourceName: "Reuters",
    url: "https://www.reuters.com/world/fixture",
    publishedAt: new Date().toISOString()
  });

  assert.ok(classified.countryMentions.includes("IL"));
  assert.ok(classified.countryMentions.includes("IR"));
  assert.ok(classified.topicTags.includes("conflict"));
  assert.equal(classified.threatLevel, "critical");
  assert.ok(classified.credibilityScore >= 0.9);
});

test("rss deduplicator collapses repeated headlines while preserving duplicate counts", () => {
  const result = deduplicateRssArticles([
    {
      id: "a",
      title: "Shipping lane tensions return to the Red Sea",
      sourceName: "Reuters",
      publishedAt: "2026-03-08T10:00:00.000Z",
      credibilityScore: 0.98
    },
    {
      id: "b",
      title: "Shipping lane tensions return to the Red Sea",
      sourceName: "Reuters",
      publishedAt: "2026-03-08T10:01:00.000Z",
      credibilityScore: 0.98
    }
  ]);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].duplicateCount, 2);
});

test("replaying an RSS source or a retained corpus does not invent duplicates", () => {
  const article = { id: "source-article", title: "Unchanged source report", url: "https://example.org/report", publishedAt: "2026-03-08T10:00:00.000Z" };
  const initial = deduplicateRssArticles([article]);
  const replayed = deduplicateRssArticles([...initial.items, article, article]);
  const retained = deduplicateRssArticles(replayed.items);
  assert.deepEqual(replayed, initial);
  assert.deepEqual(retained, initial);
  assert.deepEqual(initial.items[0].duplicateIds, ["source-article"]);
});

test("RSS aggregates retain distinct source IDs and repair old repeated canonical references", () => {
  const first = { id: "source-a", title: "Same report", url: "https://example.org/shared", publishedAt: "2026-03-08T10:00:00.000Z" };
  const second = { ...first, id: "source-b" };
  const initial = deduplicateRssArticles([first, second]);
  const item = initial.items[0];
  const legacy = { ...item, duplicateCount: 2, duplicateIds: [item.id, item.id] };
  const recovered = deduplicateRssArticles([legacy, second, first]);
  assert.equal(recovered.items[0].duplicateCount, 2);
  assert.deepEqual(recovered.items[0].duplicateIds, ["source-a", "source-b"]);
  assert.deepEqual(deduplicateRssArticles(recovered.items), recovered);
  assert.deepEqual(recovered.clusters[item.id], ["source-a", "source-b"]);
});

test("repeated RSS acquisition routes retain provenance without increasing source ID counts", () => {
  const article = { id: "source-a", title: "Same report", url: "https://example.org/shared", publishedAt: "2026-03-08T10:00:00.000Z", provenance: { feedId: "feed-a", fetchedAt: "2026-03-08T10:01:00.000Z" } };
  const otherRoute = { ...article, provenance: { feedId: "feed-b", fetchedAt: "2026-03-08T10:02:00.000Z" } };
  const initial = deduplicateRssArticles([article, otherRoute]);
  const replayed = deduplicateRssArticles([...initial.items, otherRoute]);
  assert.equal(replayed.items[0].duplicateCount, 1);
  assert.deepEqual(replayed.items[0].provenances.map(p => p.feedId), ["feed-a", "feed-b"]);
  assert.deepEqual(replayed.items[0].provenances, initial.items[0].provenances);
  assert.deepEqual(replayed.items[0].aliases, initial.items[0].aliases);
});
