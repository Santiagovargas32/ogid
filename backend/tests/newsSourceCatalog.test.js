import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createNewsSourceCatalog,
  NEWS_SOURCE_CATALOG,
  projectLegacyGeneratedSearches,
  projectLegacyRssFeeds,
  summarizeNewsSourceCatalog,
  validateNewsSourceCatalog
} from "../services/news/newsSourceCatalog.js";
import { parseFeedArticles } from "../services/news/providers/rssProvider.js";
import { RssAggregatorService } from "../services/news/rssAggregator.js";

const LEGACY_RSS_PROJECTION_SHA256 = "6a510ef55f64c288a0993a9619b1c70d368ea25410b4d7be5ac7ff4149a5c37c";
const LEGACY_GENERATED_PROJECTION_SHA256 = "9f3ecc31d3735f7d5c7be4dae62ab34112968159b72aba63275ef83c43ea8cb9";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cloneEntries() {
  return structuredClone(NEWS_SOURCE_CATALOG.entries);
}

test("canonical source catalog has the exact inventory split", () => {
  const summary = summarizeNewsSourceCatalog();
  assert.equal(summary.total, 501);
  assert.deepEqual(summary.byType, { rss: 66, generated_search: 435, discovery: 0 });
  assert.equal(summary.enabledRss, 66);
  assert.equal(summary.disabledRss, 0);
  assert.equal(new Set(NEWS_SOURCE_CATALOG.entries.map((entry) => entry.sourceId)).size, 501);
  assert.equal(NEWS_SOURCE_CATALOG.entries.every((entry) => entry.instrumentIds.length === 0), true);
});

test("legacy RSS projection preserves order, URLs and enabled state", () => {
  const projection = projectLegacyRssFeeds();
  const stableProjection = projection.map(({ label, url, disabled, reason }) => ({ label, url, disabled, reason }));
  assert.equal(digest(stableProjection), LEGACY_RSS_PROJECTION_SHA256);
  assert.equal(projection.length, 66);
  assert.deepEqual(projection.slice(0, 3).map(({ label }) => label), [
    "U.S. Defense Releases",
    "U.S. Defense Contracts",
    "EIA Today in Energy"
  ]);
});

test("official sources lead the catalog and retired invalid feeds stay removed", () => {
  const rssEntries = NEWS_SOURCE_CATALOG.entries.filter((entry) => entry.type === "rss");
  assert.equal(rssEntries.slice(0, 16).every((entry) => entry.role === "official"), true);
  const ids = new Set(rssEntries.map((entry) => entry.sourceId));
  for (const retiredId of [
    "rss-globalsecurity",
    "rss-zerohedge-disabled",
    "rss-reliefweb-global-crisis",
    "rss-reuters-world",
    "rss-yahoo-world"
  ]) {
    assert.equal(ids.has(retiredId), false);
  }
});

test("generated searches retain their legacy projection without becoming RSS sources", () => {
  const generated = projectLegacyGeneratedSearches();
  const stableProjection = generated.map(({ label, url, disabled, generated: isGenerated }) => ({
    label,
    url,
    disabled,
    generated: isGenerated
  }));
  assert.equal(digest(stableProjection), LEGACY_GENERATED_PROJECTION_SHA256);
  assert.equal(generated.length, 435);
  const source = NEWS_SOURCE_CATALOG.entries.find((entry) => entry.sourceId === generated[0].sourceId);
  assert.equal(source.type, "generated_search");
  assert.equal(Object.hasOwn(source, "url"), false);
  assert.equal(typeof source.queryDefinition.query, "string");
  assert.equal(source.queryProvider, "google-news-rss");
  assert.equal(source.publisher, null);
});

test("generated search parser metadata cannot claim a publisher", () => {
  const generated = projectLegacyGeneratedSearches()[0];
  const xml = "<rss><channel><title>Google News</title><item><title>Observed title</title><link>https://example.test/item</link><pubDate>Sun, 12 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>";
  const [article] = parseFeedArticles(xml, generated.label, generated);
  assert.equal(article.publisher, null);
  assert.equal(article.source.type, "generated_search");
  assert.equal(article.provenance.sourceId, generated.sourceId);
});

test("catalog validation detects duplicate canonical URLs and query definitions", () => {
  const duplicateUrl = cloneEntries();
  duplicateUrl.push({
    ...structuredClone(duplicateUrl[0]),
    sourceId: "rss-duplicate-url",
    url: `${duplicateUrl[0].url}#fragment`
  });
  assert.throws(() => createNewsSourceCatalog(duplicateUrl), /duplicate-news-source-identity/);

  const duplicateQuery = cloneEntries();
  const generated = duplicateQuery.find((entry) => entry.type === "generated_search");
  const reorderedLocale = Object.fromEntries(Object.entries(generated.queryDefinition.locale).reverse());
  duplicateQuery.push({
    ...structuredClone(generated),
    sourceId: "search-duplicate-query",
    queryDefinition: { ...structuredClone(generated.queryDefinition), locale: reorderedLocale }
  });
  assert.throws(() => createNewsSourceCatalog(duplicateQuery), /duplicate-news-source-identity/);
});

test("invalid catalog entries are rejected during validation", () => {
  const invalidCatalog = structuredClone(NEWS_SOURCE_CATALOG);
  invalidCatalog.entries[0].hostname = "different.example";
  assert.throws(() => validateNewsSourceCatalog(invalidCatalog), /invalid-news-source-hostname/);
});

test("catalog validation rejects unsafe URLs and inconsistent metadata", () => {
  const invalidCases = [
    ["url", "ftp://www.bellingcat.com/feed/", /invalid-news-source-url/],
    ["url", "https://user:secret@www.bellingcat.com/feed/", /invalid-news-source-url/],
    ["expectedCadence", { minPollIntervalMs: 0 }, /invalid-news-source-policy/],
    ["status", "unknown", /invalid-news-source-fields/],
    ["topics", [""], /invalid-news-source-arrays/]
  ];
  for (const [field, value, expectedError] of invalidCases) {
    const invalidCatalog = structuredClone(NEWS_SOURCE_CATALOG);
    invalidCatalog.entries[0][field] = value;
    assert.throws(() => validateNewsSourceCatalog(invalidCatalog), expectedError);
  }
});

test("canonical entries and nested metadata are immutable after validation", () => {
  assert.equal(Object.isFrozen(NEWS_SOURCE_CATALOG.entries[0].topics), true);
  assert.equal(Object.isFrozen(NEWS_SOURCE_CATALOG.entries[0].provenance), true);
  assert.throws(() => NEWS_SOURCE_CATALOG.entries[0].topics.push("mutation"), TypeError);
});

test("legacy batch projection keeps the first visible selection unchanged", () => {
  const rssFeeds = projectLegacyRssFeeds().filter((feed) => !feed.disabled);
  const service = new RssAggregatorService({
    rssFeeds,
    refreshIntervalMs: 900_000,
    maxFeedsPerRun: 18,
    maxCorpusItems: 900,
    pipelineMode: "legacy"
  });
  assert.deepEqual(
    service.nextFeedBatch().map(({ label, url }) => ({ label, url })),
    rssFeeds.slice(0, 18).map(({ label, url }) => ({ label, url }))
  );
  assert.equal(service.feedCatalogStats.typeCounts.generated_search, 435);
  assert.equal(service.feedCatalogStats.catalogVersion, NEWS_SOURCE_CATALOG.catalogVersion);
});

test("legacy batches rotate through every configured RSS without exceeding the per-cycle cap", () => {
  const rssFeeds = projectLegacyRssFeeds().filter((feed) => !feed.disabled);
  const service = new RssAggregatorService({
    rssFeeds,
    refreshIntervalMs: 900_000,
    maxFeedsPerRun: 18,
    maxCorpusItems: 900,
    pipelineMode: "legacy"
  });
  const batches = Array.from({ length: Math.ceil(rssFeeds.length / 18) }, () => service.nextFeedBatch());
  assert.equal(batches.every((batch) => batch.length <= 18), true);
  const configuredIds = new Set(batches.flat().filter((feed) => !feed.generated).map((feed) => feed.sourceId));
  assert.equal(configuredIds.size, rssFeeds.length);
});

test("catalog and projections perform zero HTTP calls", () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error("unexpected-http");
  };
  try {
    validateNewsSourceCatalog(NEWS_SOURCE_CATALOG);
    projectLegacyRssFeeds();
    projectLegacyGeneratedSearches();
    summarizeNewsSourceCatalog();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
