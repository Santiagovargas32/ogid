import test from "node:test";
import assert from "node:assert/strict";
import {
  AdvancedIntelligenceService,
  buildAdvancedCorpus,
  buildFrequentTerms
} from "../services/intel/advancedIntelligenceService.js";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");

function article(id, title, topicTags, overrides = {}) {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    publishedAt: new Date(NOW - 60 * 60 * 1_000).toISOString(),
    countryMentions: ["US"],
    topicTags,
    threatLevel: topicTags.includes("conflict") ? "elevated" : "monitoring",
    threatScore: topicTags.includes("conflict") ? 6 : 3,
    credibilityScore: 0.9,
    sourceName: "Test Wire",
    ...overrides
  };
}

test("advanced corpus applies the common window and deduplicates signal/RSS articles", () => {
  const shared = article("shared", "Missile activity reported", ["conflict"]);
  const result = buildAdvancedCorpus({
    signalCorpus: [shared],
    aggregateItems: [
      { ...shared, id: "rss-copy", credibilityScore: 0.95 },
      article("old", "Old report", ["conflict"], { publishedAt: "2026-07-18T12:00:00.000Z" })
    ],
    countries: ["US"],
    windowHours: 24,
    now: NOW
  });

  assert.equal(result.articles.length, 1);
  assert.equal(result.stats.duplicatesRemoved, 1);
  assert.equal(result.stats.outsideWindow, 1);
  assert.equal(result.articles[0].credibilityScore, 0.95);
});

test("advanced corpus recognizes normalized multilingual country entities", () => {
  const result = buildAdvancedCorpus({
    aggregateItems: [article("spanish", "Estados Unidos refuerza la seguridad ante un misil", [], {
      countryMentions: [],
      threatLevel: "low",
      threatScore: 0
    })],
    countries: ["US"],
    windowHours: 24,
    now: NOW
  });
  assert.equal(result.articles.length, 1);
  assert.deepEqual(result.articles[0].countryMentions, ["US"]);
  assert.equal(result.articles[0].topicTags.includes("conflict"), true);
  assert.equal(result.articles[0].threatLevel, "monitoring");
});

test("advanced corpus does not attribute Latin America to the United States alias", () => {
  const result = buildAdvancedCorpus({
    aggregateItems: [article("latin-america", "América Latina debate nuevas sanciones", [], { countryMentions: ["US"] })],
    countries: ["US"],
    windowHours: 24,
    now: NOW
  });
  assert.equal(result.articles.length, 0);
});

test("advanced snapshot shares one corpus, timestamp and methodology across every projection", async () => {
  let aggregateCalls = 0;
  let aggregateOptions = null;
  const signalArticles = [article("conflict", "Missile activity in Washington", ["conflict"])];
  const aggregateArticles = [
    { ...signalArticles[0], id: "conflict-copy" },
    article("cyber", "Cyber alert affects United States networks", ["cyber"]),
    article("sanctions", "Sanctions pressure rises in United States", ["sanctions"]),
    article("previous", "Abating pressure in United States", ["sanctions"], {
      publishedAt: new Date(NOW - 30 * 60 * 60 * 1_000).toISOString()
    }),
    article("iran", "Iran regional update", ["conflict"], { countryMentions: ["IR"] })
  ];
  const stateManager = {
    getSnapshot: () => ({
      meta: { dataQuality: { news: { mode: "live", provider: "rss" } } },
      countries: { US: { score: 120, metrics: {} }, IR: { score: 90, metrics: {} } },
      market: { quotes: { SPY: { changePct: 2, asOf: new Date(NOW).toISOString(), source: "test" } } },
      predictions: { updatedAt: new Date(NOW).toISOString(), tickers: [] },
      impact: { items: [] }
    }),
    getSignalCorpus: () => signalArticles
  };
  const rssAggregator = {
    getSnapshot: async (options) => {
      aggregateCalls += 1;
      aggregateOptions = options;
      return {
        generatedAt: new Date(NOW).toISOString(),
        items: aggregateArticles,
        meta: { provider: "rss-aggregate", pipelineMode: "canonical" }
      };
    }
  };
  const signalCorrelator = {
    getAnomalies: ({ activeWindowHours }) => ({
      status: "insufficient_baseline",
      window: { activeWindowHours, baselineDays: 7 },
      items: [{ signalType: "news", status: "insufficient_baseline", anomalyScore: null }]
    })
  };
  const service = new AdvancedIntelligenceService({ stateManager, rssAggregator, signalCorrelator, now: () => NOW });
  const snapshot = await service.getSnapshot({ countries: ["US"], windowHours: 24 });
  const cached = await service.getSnapshot({ countries: ["US"], windowHours: 24 });

  assert.equal(aggregateCalls, 1);
  assert.deepEqual(aggregateOptions.countries, []);
  assert.deepEqual(cached, snapshot);
  assert.equal(snapshot.schemaVersion, "advanced-intelligence-snapshot-v1");
  assert.equal(snapshot.methodology.version, "advanced-intelligence-v2");
  assert.equal(snapshot.methodology.severity.version, "rule-based-news-severity-v1");
  assert.equal(snapshot.methodology.frequentTerms.version, "frequent-headline-terms-v2");
  assert.equal(snapshot.methodology.anomaly.version, "signal-anomaly-v3");
  assert.equal(snapshot.generatedAt, snapshot.anomalies.generatedAt);
  assert.equal(snapshot.window.hours, 24);
  assert.equal(snapshot.corpus.uniqueArticles, 3);
  assert.equal(snapshot.corpus.previousWindowArticles, 1);
  assert.deepEqual(snapshot.countryInstability.ranking.map((item) => item.iso2), ["US"]);
  assert.equal(snapshot.worldBrief.articles.every((item) => item.countryMentions.includes("US")), true);
  assert.deepEqual(snapshot.worldBrief.drivers.map((item) => item.key).sort(), ["cii", "geo", "military", "news"]);
  assert.equal(snapshot.worldBrief.drivers.every((item) => Number.isFinite(item.contribution)), true);
  assert.equal(snapshot.anomalies.items[0].anomalyScore, null);
  assert.equal(snapshot.anomalies.alignedWithSnapshotWindow, true);

  const hotspot = snapshot.hotspots[0];
  const expected =
    hotspot.components.news.score * 0.35 +
    hotspot.components.cii.score * 0.25 +
    hotspot.components.geo.score * 0.25 +
    hotspot.components.military.score * 0.15;
  assert.ok(Math.abs(hotspot.hotspotScore - expected) < 0.02);
  assert.equal(hotspot.components.news.eventCount, 3);
  assert.equal(snapshot.corpus.scoringUsesCompleteWindow, true);
  assert.equal(snapshot.frequentTerms.comparison.previousSampleSize, 1);

  const limited = await service.getSnapshot({ countries: ["US"], windowHours: 24, maxEvents: 50 });
  const wide = await service.getSnapshot({ countries: ["US"], windowHours: 24, maxEvents: 1000 });
  assert.equal(limited.hotspots[0].hotspotScore, wide.hotspots[0].hotspotScore);
  assert.equal(limited.corpus.eventCount, wide.corpus.eventCount);
});

test("frequent terms normalize accents and compare the full window with the preceding window", () => {
  const current = article("current", "Tensión energética aumenta", ["energy"], {
    publishedAt: new Date(NOW - 60 * 60 * 1_000).toISOString()
  });
  const previous = article("previous", "Tension regional continúa", ["conflict"], {
    publishedAt: new Date(NOW - 30 * 60 * 60 * 1_000).toISOString()
  });
  const result = buildFrequentTerms([current], { previousArticles: [previous], windowHours: 24, now: NOW });
  const tension = result.items.find((item) => item.term === "tension");
  assert.ok(tension);
  assert.equal(tension.count, 1);
  assert.equal(tension.previousCount, 1);
  assert.equal(tension.direction, "flat");
  assert.equal(result.comparison.currentHours, 24);
  assert.equal(result.comparison.previousHours, 24);
  assert.equal(result.items.find((item) => item.term === "regional").direction, "down");

  const insufficient = buildFrequentTerms([current], { previousArticles: [], windowHours: 24, now: NOW });
  assert.equal(insufficient.comparison.status, "insufficient_comparison");
  assert.equal(insufficient.items.find((item) => item.term === "tension").direction, "unavailable");
  assert.equal(insufficient.items.find((item) => item.term === "tension").delta, null);
});
