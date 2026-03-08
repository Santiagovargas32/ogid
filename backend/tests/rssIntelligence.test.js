import test from "node:test";
import assert from "node:assert/strict";
import { buildExtendedRssFeedCatalog, classifyRssArticle } from "../services/news/rssClassifier.js";
import { deduplicateRssArticles } from "../services/news/rssDeduplicator.js";

test("rss classifier builds a 435+ feed catalog and extracts threat metadata", () => {
  const catalog = buildExtendedRssFeedCatalog([
    { label: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" }
  ]);
  assert.ok(catalog.stats.totalCount >= 435);

  const classified = classifyRssArticle({
    id: "rss-1",
    title: "Missile strike and cyber disruption hit Tehran and Tel Aviv",
    description: "Sanctions pressure rises after the attack.",
    sourceName: "Reuters",
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
