import test from "node:test";
import assert from "node:assert/strict";
import { buildIntelNewsSelection } from "../services/news/newsSelectionService.js";

test("news selection preserves a wider signal corpus than the visible curated feed", () => {
  const now = Date.now();
  const articles = [
    {
      provider: "rss",
      sourceName: "BBC World",
      title: "Shipping lane risk rises in the Red Sea",
      url: "https://example.com/1",
      publishedAt: new Date(now - 5 * 60_000).toISOString(),
      countryMentions: ["US", "IL"],
      conflict: { totalWeight: 6 }
    },
    {
      provider: "rss",
      sourceName: "BBC World",
      title: "Shipping lane risk rises in the Red Sea again",
      url: "https://example.com/2",
      publishedAt: new Date(now - 10 * 60_000).toISOString(),
      countryMentions: ["US", "IL"],
      conflict: { totalWeight: 5 }
    },
    {
      provider: "rss",
      sourceName: "BBC World",
      title: "Regional escorts reinforce maritime corridor",
      url: "https://example.com/3",
      publishedAt: new Date(now - 15 * 60_000).toISOString(),
      countryMentions: ["US"],
      conflict: { totalWeight: 5 }
    },
    {
      provider: "newsapi",
      sourceName: "Reuters",
      title: "Defense contractors monitor regional escalation",
      url: "https://example.com/4",
      publishedAt: new Date(now - 20 * 60_000).toISOString(),
      countryMentions: ["IL", "IR"],
      conflict: { totalWeight: 7 }
    },
    {
      provider: "newsapi",
      sourceName: "Reuters",
      title: "Energy traders react to tanker security concerns",
      url: "https://example.com/5",
      publishedAt: new Date(now - 25 * 60_000).toISOString(),
      countryMentions: ["IR"],
      conflict: { totalWeight: 6 }
    }
  ];

  const result = buildIntelNewsSelection({
    articles,
    previousArticles: [],
    watchlistCountries: ["US", "IL", "IR"],
    now: new Date(now),
    analyzeLimit: 5,
    candidateWindowHours: 24,
    noveltyWindowHours: 12,
    maxPerSource: 2,
    maxSimilarHeadline: 2
  });

  assert.equal(result.signalCorpus.length, 5);
  assert.equal(result.displaySelection.length, 4);
  assert.ok(result.signalCorpus.length > result.displaySelection.length);
  assert.equal(result.selectionMeta.selectionConfig.maxPerSource, 2);
  assert.equal(Number.isFinite(result.selectionMeta.latestSelectedArticleAgeMin), true);

  const bbc = result.selectionMeta.selectionBySourceName.find((item) => item.provider === "rss" && item.sourceName === "BBC World");
  const reuters = result.selectionMeta.selectionBySourceName.find(
    (item) => item.provider === "newsapi" && item.sourceName === "Reuters"
  );
  assert.ok(bbc);
  assert.ok(reuters);
  assert.equal(bbc.raw, 3);
  assert.equal(bbc.filtered, 3);
  assert.equal(bbc.selected, 2);
  assert.equal(reuters.raw, 2);
  assert.equal(reuters.filtered, 2);
  assert.equal(reuters.selected, 2);
});
