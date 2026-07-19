import test from "node:test";
import assert from "node:assert/strict";
import { buildCanonicalArticleLayer, canonicalizeArticleUrl } from "../services/ai/canonicalArticleService.js";
import { buildArticleSummaryJob, buildCountryInsightJob, buildMarketExplanationJob } from "../services/ai/aiInputBuilder.js";
import { buildArticleInstrumentLinks } from "../services/market/impactEngineService.js";

function article(overrides = {}) {
  return {
    id: "legacy-1",
    provider: "rss",
    sourceName: "Example Publisher",
    title: "Energy disruption affects Exxon operations",
    description: "Contact desk@example.com or +34 600 123 456 for details.",
    excerpt: "Contact desk@example.com or +34 600 123 456 for details.",
    content: "",
    url: "https://example.com/story?utm_source=rss&b=2&a=1#section",
    publishedAt: "2026-07-19T08:00:00.000Z",
    receivedAt: "2026-07-19T08:01:00.000Z",
    countryMentions: ["US"],
    usagePolicy: "headline-only-link-out",
    analysisScore: 82,
    sentiment: { label: "negative" },
    conflict: { totalWeight: 0 },
    dataMode: "observed",
    ...overrides
  };
}

test("canonical AI projection is stable and leaves legacy article identity untouched", () => {
  const raw = {
    ...article(),
    publisher: "Example Publisher",
    provenance: { sourceId: "source-1", sourceType: "rss", methodVersion: "rss-parser-v1" }
  };
  const first = buildCanonicalArticleLayer({ signalCorpus: [article()], displaySelection: [article()], rawArticles: [raw] });
  const second = buildCanonicalArticleLayer({
    signalCorpus: [article({ id: "legacy-reordered" })],
    displaySelection: [],
    rawArticles: [raw]
  });
  assert.equal(first.articles[0].legacyArticleId, "legacy-1");
  assert.equal(second.articles[0].legacyArticleId, "legacy-reordered");
  assert.equal(first.articles[0].canonicalArticleId, second.articles[0].canonicalArticleId);
  assert.equal(first.articles[0].canonicalUrl, "https://example.com/story?a=1&b=2");
  assert.deepEqual(first.articles[0].corpusMembership, ["signal", "display"]);
  assert.equal(first.articles[0].provenance.sourceId, "source-1");
});

test("generated search provenance never becomes a publisher", () => {
  const layer = buildCanonicalArticleLayer({
    signalCorpus: [article()],
    rawArticles: [{ ...article(), publisher: "Should Not Surface", provenance: { sourceType: "generated_search" } }]
  });
  assert.equal(layer.articles[0].publisher, null);
});

test("headline-only policy excludes excerpts from AI input", () => {
  const layer = buildCanonicalArticleLayer({ signalCorpus: [article()], rawArticles: [article()] });
  const job = buildArticleSummaryJob(layer.articles[0]);
  assert.equal(job.input.evidence[0].excerpt, null);
  assert.doesNotMatch(job.messages[1].content, /desk@example\.com|600 123 456/);
});

test("AI prompts carry the exact output schema when provider-side guidance is unavailable", () => {
  const layer = buildCanonicalArticleLayer({ signalCorpus: [article()], rawArticles: [article()] });
  const job = buildArticleSummaryJob(layer.articles[0]);
  assert.equal(job.promptVersion, "ogid-ai-grounded-v3");
  assert.match(job.messages[0].content, /Return only one JSON object/);
  assert.match(job.messages[0].content, /copy each name verbatim/);
  assert.match(job.messages[0].content, /summaryEvidenceArticleIds/);
  assert.match(job.messages[0].content, /additionalProperties/);
  assert.match(job.validationContext.evidenceText, /Example Publisher/);
});

test("AI input strips HTML and redacts authorization material", () => {
  const unsafe = article({
    usagePolicy: "standard-link-out",
    excerpt: "<b>Observed</b> Authorization: Bearer secret-token-value"
  });
  const layer = buildCanonicalArticleLayer({ signalCorpus: [unsafe], rawArticles: [unsafe] });
  const serialized = buildArticleSummaryJob(layer.articles[0]).messages[1].content;
  assert.doesNotMatch(serialized, /<b>|secret-token-value/);
  assert.match(serialized, /Observed/);
});

test("article jobs expose deterministic priority tiers", () => {
  const layer = buildCanonicalArticleLayer({ signalCorpus: [article()], rawArticles: [article()] });
  const direct = buildArticleSummaryJob(layer.articles[0], { priorityBase: 400 });
  const contextual = buildArticleSummaryJob(layer.articles[0], { priorityBase: 100 });
  assert.equal(direct.priority - contextual.priority, 300);
});

test("instrument links expose the same deterministic matching reasons", () => {
  const links = buildArticleInstrumentLinks(article(), {
    tickers: ["XOM", "QQQ"],
    instruments: [
      { instrumentId: "us-equity-exxon", canonicalSymbol: "XOM", displayName: "Exxon Mobil", sector: "Energy" },
      { instrumentId: "us-etf-qqq", canonicalSymbol: "QQQ", displayName: "Invesco QQQ", assetType: "etf" }
    ]
  });
  assert.deepEqual(links.map((item) => item.canonicalSymbol), ["XOM", "QQQ"]);
  assert.equal(links[0].relation, "direct");
  assert.equal(links[1].relation, "macro");
});

test("URL canonicalization is local, deterministic and protocol restricted", () => {
  assert.equal(canonicalizeArticleUrl("javascript:alert(1)"), "");
  assert.equal(canonicalizeArticleUrl("https://EXAMPLE.com/a/?utm_medium=x&z=2&y=1"), "https://example.com/a?y=1&z=2");
});

test("market AI input carries calculated analytics but never candle arrays", () => {
  const layer = buildCanonicalArticleLayer({
    signalCorpus: [article()],
    rawArticles: [article()],
    instruments: [{ instrumentId: "us-equity-exxon", canonicalSymbol: "XOM", displayName: "Exxon Mobil", sector: "Energy" }]
  });
  const job = buildMarketExplanationJob({
    ticker: "XOM",
    linkedArticles: ["legacy-1"],
    eventScore: 4,
    impactScore: 2,
    priceReaction: 0.5,
    level: "Low",
    windowMin: 120,
    inputMode: "live",
    quote: { price: 100, changePct: 0.5 }
  }, {}, layer.articles, { instrumentId: "us-equity-exxon", canonicalSymbol: "XOM", displayName: "Exxon Mobil" }, {
    deterministicAnalytics: {
      technicalIndicators: { instrumentId: "us-equity-exxon", methodVersion: "technical-indicators-v1", indicators: { rsi: { value: 55 } }, sampleSize: 30 },
      couplingV2: [{ methodVersion: "news-price-coupling-v2", newsId: "legacy-1", instrumentId: "us-equity-exxon", windows: [] }]
    }
  });
  assert.equal(job.eligible, true);
  assert.equal(job.input.deterministicContext.technicalIndicators.indicators.rsi.value, 55);
  assert.doesNotMatch(JSON.stringify(job.input), /"candles"/i);
});

test("country AI input requires two clusters and two independent publishers", () => {
  const base = buildCanonicalArticleLayer({ signalCorpus: [article()], rawArticles: [{ ...article(), publisher: "Publisher One" }] });
  const insufficient = buildCountryInsightJob("US", { score: 20 }, base.articles);
  assert.equal(insufficient.eligible, false);
  assert.equal(insufficient.reason, "insufficient-independent-evidence");

  const second = {
    ...article({ id: "legacy-2", title: "Second independent report on United States disruption", url: "https://second.example/story" })
  };
  const layer = buildCanonicalArticleLayer({
    signalCorpus: [article(), second],
    rawArticles: [{ ...article(), publisher: "Publisher One" }, { ...second, publisher: "Publisher Two" }]
  });
  const eligible = buildCountryInsightJob("US", { score: 20, level: "Monitoring" }, layer.articles);
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.validationContext.allowedArticleIds.length, 2);
  assert.deepEqual(eligible.input.deterministicContext.sourceDiversity.publishers.sort(), ["Publisher One", "Publisher Two"]);
});
