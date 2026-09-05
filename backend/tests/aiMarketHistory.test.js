import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "cheerio";
import { AiEnrichmentCoordinator } from "../services/ai/aiEnrichmentCoordinator.js";
import { AiEnrichmentStore } from "../services/ai/aiEnrichmentStore.js";
import { MockAiProvider } from "../services/ai/aiProviders.js";
import { buildMarketExplanationJob } from "../services/ai/aiInputBuilder.js";
import { buildCanonicalArticleLayer } from "../services/ai/canonicalArticleService.js";
import { renderMarketExplanationHistory } from "../../frontend/js/aiMarketHistory.js";

function fixture(symbols = ["LMT", "XOM", "CVX", "RTX"]) {
  const articles = symbols.map((symbol) => ({
    id: `news-${symbol}`, sourceName: "Publisher", provider: "rss", title: `${symbol} reports a disruption`,
    url: `https://example.com/${symbol}`, publishedAt: "2026-09-05T08:00:00Z", receivedAt: "2026-09-05T08:01:00Z",
    countryMentions: ["US"], excerpt: "A disruption was reported.", analysisScore: 90,
    synthetic: false, dataMode: "observed", usagePolicy: "standard-link-out"
  }));
  return {
    snapshot: { countries: {}, market: { quotes: {} }, impact: {
      items: symbols.map((ticker, index) => ({ ticker, eventScore: 5, impactScore: 10 - index,
        linkedArticles: [`news-${ticker}`], quote: { price: 100, changePct: -1, asOf: "2026-09-04T20:00:00Z", providerLatencyMs: 10, providerScore: 90 } })),
      couplingSeries: symbols.map((ticker) => ({ ticker, predictionScore: 5, points: [{ timestamp: "2026-09-05T09:00:00Z", impactScore: 10, priceReaction: 1 }] }))
    } },
    signalCorpus: articles, displaySelection: articles, rawArticles: articles,
    instruments: symbols.map((canonicalSymbol) => ({ instrumentId: `instrument-${canonicalSymbol}`, canonicalSymbol, displayName: canonicalSymbol }))
  };
}

function output(request) {
  const input = JSON.parse(request.messages[1].content);
  return { instrumentId: input.subject.instrumentId, narrative: `${input.subject.symbol}: a temporal association is observed.`,
    narrativeEvidenceArticleIds: [input.evidence[0].articleId], drivers: [], causality: "not_established",
    limitations: ["Causality is not established."], uncertainty: { level: "medium", notes: ["Limited evidence."] } };
}

function harness({ mode = "visible", store = new AiEnrichmentStore(), handler = output, maxJobsPerCycle = 1, maxQueueSize = 20 } = {}) {
  let now = Date.parse("2026-09-05T09:00:00Z");
  const provider = new MockAiProvider({ handler });
  const broadcasts = [];
  const coordinator = new AiEnrichmentCoordinator({
    config: { mode, features: ["market-explanation"], maxJobsPerCycle, maxConcurrency: 2, maxQueueSize },
    provider, store, now: () => now,
    technicalIndicatorService: { calculate: ({ instrumentId }) => ({ instrumentId, calculatedAt: new Date(now).toISOString(), lastCandleAt: "2026-09-04T20:00:00Z", indicators: { rsi: { value: 50 } } }) },
    socketServer: { broadcast: (type, data) => broadcasts.push({ type, data }) }
  });
  return { coordinator, provider, store, broadcasts, tick() { now += 60_000; } };
}

async function idle(coordinator) {
  const deadline = Date.now() + 2_000;
  while (coordinator.active || coordinator.queue.length) {
    if (Date.now() > deadline) throw new Error("AI jobs did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function buildJob(input, analytics = {}) {
  const layer = buildCanonicalArticleLayer(input);
  return buildMarketExplanationJob(input.snapshot.impact.items[0], { couplingSeries: input.snapshot.impact.couplingSeries }, layer.articles, input.instruments[0], { deterministicAnalytics: analytics });
}

test("market cache ignores refresh metadata, repeated coupling points and evidence ordering without changing the request", () => {
  const input = fixture(["LMT"]);
  const original = structuredClone(input);
  const first = buildJob(input, { technicalIndicators: { calculatedAt: "2026-09-05T09:00:00Z", lastCandleAt: "2026-09-04T20:00:00Z" } });
  assert.deepEqual(input, original);
  const changed = structuredClone(input);
  changed.snapshot.impact.items[0].quote.providerLatencyMs = 200;
  changed.snapshot.impact.items[0].quote.providerScore = 70;
  changed.snapshot.impact.couplingSeries[0].points.push({ timestamp: "2026-09-05T10:00:00Z", impactScore: 10, priceReaction: 1 });
  const second = buildJob(changed, { technicalIndicators: { calculatedAt: "2026-09-05T10:00:00Z", lastCandleAt: "2026-09-04T20:00:00Z" } });
  assert.notEqual(first.inputHash, second.inputHash);
  assert.equal(first.cacheInputHash, second.cacheInputHash);
  assert.equal(JSON.parse(second.messages[1].content).deterministicContext.quote.providerLatencyMs, 200);
  const reordered = fixture(["LMT", "XOM"]);
  reordered.snapshot.impact.items[0].linkedArticles.push("news-XOM");
  const hash = buildJob(reordered).cacheInputHash;
  reordered.signalCorpus.reverse();
  assert.equal(buildJob(reordered).cacheInputHash, hash);
});

test("market cache invalidates for changed evidence, observed prices, candle times, quality and analytic values", () => {
  const input = fixture(["LMT"]);
  const originalHash = buildJob(input).cacheInputHash;
  const changes = [
    (value) => { value.signalCorpus[0].excerpt = "Additional reported disruption."; },
    (value) => { value.snapshot.impact.items[0].quote.price = 101; },
    (value) => { value.snapshot.impact.items[0].quote.asOf = "2026-09-05T20:00:00Z"; },
    (value) => { value.snapshot.impact.items[0].quote.dataMode = "stale"; },
    (value) => { value.snapshot.impact.items[0].eventScore = 20; },
    (value) => { value.snapshot.impact.couplingSeries[0].points[0].impactScore = 20; }
  ];
  for (const change of changes) {
    const changed = structuredClone(input);
    change(changed);
    assert.notEqual(buildJob(changed).cacheInputHash, originalHash);
  }
  const first = buildJob(input, { technicalIndicators: { lastCandleAt: "2026-09-04T20:00:00Z", indicators: { rsi: 50 } } });
  assert.notEqual(buildJob(input, { technicalIndicators: { lastCandleAt: "2026-09-05T20:00:00Z", indicators: { rsi: 50 } } }).cacheInputHash, first.cacheInputHash);
  assert.notEqual(buildJob(input, { technicalIndicators: { lastCandleAt: "2026-09-04T20:00:00Z", indicators: { rsi: 60 } } }).cacheInputHash, first.cacheInputHash);
});

test("one job per cycle rotates instruments, keeps three accepted results, and does no work when inputs are exhausted", async () => {
  const h = harness();
  const input = fixture();
  h.coordinator.reconcileNewsSnapshot(input);
  await idle(h.coordinator);
  for (let index = 1; index < 4; index += 1) {
    h.tick();
    assert.equal(h.coordinator.reconcileMarketSnapshot(input).scheduled, 1);
    assert.equal(h.coordinator.getPublicProjection().marketExplanationHistory.length, Math.min(index, 3));
    await idle(h.coordinator);
  }
  const projection = h.coordinator.getPublicProjection();
  assert.deepEqual(projection.marketExplanationHistory.map((entry) => entry.ticker), ["RTX", "CVX", "XOM"]);
  assert.equal(h.store.summary().counts.ready, 4);
  assert.equal(Object.keys(projection.marketExplanations).length, 4);
  for (let index = 0; index < 3; index += 1) {
    h.tick();
    assert.equal(h.coordinator.reconcileMarketSnapshot(input).scheduled, 0);
  }
  assert.equal(h.provider.calls.length, 4);
  assert.equal(h.broadcasts.at(-1).data.ai.status.active, 0);
  assert.deepEqual(h.broadcasts.at(-1).data.ai.marketExplanationHistory, projection.marketExplanationHistory);
});

test("unattempted instruments outrank a changed first instrument; cached subjects become eligible when evidence changes", async () => {
  const h = harness();
  const input = fixture(["LMT", "XOM"]);
  h.coordinator.reconcileNewsSnapshot(input);
  await idle(h.coordinator);
  h.tick();
  input.snapshot.impact.items[0].quote.price += 1;
  h.coordinator.reconcileMarketSnapshot(input);
  await idle(h.coordinator);
  assert.equal(h.store.list().items[0].subjectId, "instrument-XOM");
  h.tick();
  assert.equal(h.coordinator.reconcileMarketSnapshot(input).scheduled, 1);
  await idle(h.coordinator);
  assert.deepEqual(h.coordinator.getPublicProjection().marketExplanationHistory.map((entry) => entry.ticker), ["LMT", "XOM", "LMT"]);
});

test("changed model invalidates the market cache while an older accepted answer remains visible", async () => {
  const h = harness();
  const input = fixture(["LMT"]);
  h.coordinator.reconcileNewsSnapshot(input);
  await idle(h.coordinator);
  const original = h.coordinator.getPublicProjection().marketExplanationHistory[0];
  h.tick();
  h.provider.model = "new-model";
  assert.equal(h.coordinator.reconcileMarketSnapshot(input).scheduled, 1);
  assert.deepEqual(h.coordinator.getPublicProjection().marketExplanationHistory, [original]);
  await idle(h.coordinator);
  assert.deepEqual(h.coordinator.getPublicProjection().marketExplanationHistory.map((entry) => entry.model), ["new-model", "mock-grounded-v1"]);
});

test("overlapping news/market cycles do not run two revisions of one instrument with concurrency two", async () => {
  const releases = [];
  const h = harness({ handler: async (request) => { await new Promise((resolve) => releases.push(resolve)); return output(request); } });
  const input = fixture(["LMT", "XOM"]);
  try {
    h.coordinator.reconcileNewsSnapshot(input);
    h.tick();
    input.snapshot.impact.items[0].quote.price += 1;
    h.coordinator.reconcileMarketSnapshot(input);
    h.coordinator.reconcileNewsSnapshot(input);
    assert.equal(h.provider.calls.length, 2);
    assert.equal(h.coordinator.active, 2);
    assert.equal(h.coordinator.queue.length, 0);
    assert.deepEqual(h.store.list().items.map((record) => record.subjectId).sort(), ["instrument-LMT", "instrument-XOM"]);
  } finally {
    releases.forEach((release) => release());
    await idle(h.coordinator);
  }
});

test("queue capacity and per-cycle limits still apply to market scheduling", async () => {
  const releases = [];
  const h = harness({ maxJobsPerCycle: 4, maxQueueSize: 3, handler: async (request) => { await new Promise((resolve) => releases.push(resolve)); return output(request); } });
  try {
    assert.equal(h.coordinator.reconcileNewsSnapshot(fixture()).scheduled, 3);
    assert.equal(h.coordinator.active, 2);
    assert.equal(h.coordinator.queue.length, 1);
  } finally {
    while (h.coordinator.active || h.coordinator.queue.length) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
});

test("failed and rejected revisions preserve accepted history and do not monopolize unattempted subjects", async () => {
  let behavior = "ready";
  const h = harness({ handler: (request) => {
    if (behavior === "failed") throw new Error("provider offline");
    if (behavior === "rejected") return { ...output(request), instrumentId: "wrong-instrument" };
    return output(request);
  } });
  const input = fixture(["LMT"]);
  h.coordinator.reconcileNewsSnapshot(input);
  await idle(h.coordinator);
  const accepted = h.coordinator.getPublicProjection().marketExplanationHistory;
  for (const status of ["failed", "rejected"]) {
    behavior = status;
    h.tick();
    input.snapshot.impact.items[0].quote.price += 1;
    h.coordinator.reconcileMarketSnapshot(input);
    await idle(h.coordinator);
    const projection = h.coordinator.getPublicProjection();
    assert.deepEqual(projection.marketExplanationHistory, accepted);
    assert.equal(projection.marketExplanations["instrument-LMT"].refreshStatus, status);
  }
  behavior = "ready";
  h.tick();
  h.coordinator.reconcileNewsSnapshot(fixture(["LMT", "XOM"]));
  await idle(h.coordinator);
  assert.equal(h.store.list().items[0].subjectId, "instrument-XOM");
});

test("restart restores the full visible history before scheduling, retains dedup beyond three, and scopes removed instruments", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ogid-market-ai-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const persistencePath = join(directory, "enrichments.json");
  const h = harness({ store: new AiEnrichmentStore({ persistencePath }) });
  const input = fixture();
  h.coordinator.reconcileNewsSnapshot(input);
  await idle(h.coordinator);
  for (let index = 1; index < 4; index += 1) {
    h.tick();
    h.coordinator.reconcileMarketSnapshot(input);
    await idle(h.coordinator);
  }
  const expected = h.coordinator.getPublicProjection().marketExplanationHistory;
  const restored = harness({ store: new AiEnrichmentStore({ persistencePath }), handler: () => assert.fail("persisted cache must avoid provider calls") });
  assert.equal(restored.coordinator.reconcileNewsSnapshot(input).scheduled, 0);
  assert.deepEqual(restored.coordinator.getPublicProjection().marketExplanationHistory, expected);
  assert.equal(restored.provider.calls.length, 0);
  restored.coordinator.reconcileNewsSnapshot(fixture(["LMT"]));
  assert.deepEqual(restored.coordinator.getPublicProjection().marketExplanationHistory.map((entry) => entry.ticker), ["LMT"]);
  assert.deepEqual(Object.keys(restored.coordinator.getPublicProjection().marketExplanations), ["instrument-LMT"]);
  restored.coordinator.reconcileNewsSnapshot(fixture([]));
  assert.deepEqual(restored.coordinator.getPublicProjection().marketExplanationHistory, []);
});

test("shadow and off never expose accepted market history", async () => {
  const h = harness({ mode: "shadow" });
  h.coordinator.reconcileNewsSnapshot(fixture(["LMT"]));
  await idle(h.coordinator);
  assert.equal(h.store.summary().counts.ready, 1);
  for (const mode of ["shadow", "off"]) {
    h.coordinator.mode = mode;
    const projection = h.coordinator.getPublicProjection();
    assert.deepEqual(projection.marketExplanationHistory, []);
    assert.deepEqual(projection.marketExplanations, {});
  }
});

test("dashboard shows latest open with older responses nested, preserves expansion on refresh and filters hidden content", async () => {
  const h = harness({ maxJobsPerCycle: 4 });
  h.coordinator.reconcileNewsSnapshot(fixture());
  await idle(h.coordinator);
  const ai = h.coordinator.getPublicProjection();
  const [latest, previous] = ai.marketExplanationHistory;
  latest.output.narrative = '<img src=x onerror="alert(1)">';
  latest.provenance.evidence[0].canonicalUrl = "javascript:alert(1)";
  let html = renderMarketExplanationHistory(ai);
  let $ = load(html);
  assert.equal($("details").length, 3);
  assert.equal($("details[open]").length, 1);
  assert.equal($("details").first().attr("data-enrichment-id"), latest.enrichmentId);
  assert.equal($("details").first().find("p").text(), latest.output.narrative);
  assert.equal($("img").length, 0);
  assert.equal($('a[href^="javascript:"]').length, 0);
  html = renderMarketExplanationHistory(ai, { expanded: new Map([[latest.enrichmentId, false], [previous.enrichmentId, true]]) });
  $ = load(html);
  assert.equal($("details[open]").attr("data-enrichment-id"), previous.enrichmentId);
  $ = load(renderMarketExplanationHistory(ai, { expanded: new Map([[previous.enrichmentId, true]]) }));
  assert.equal($("details[open]").length, 1);
  assert.equal($("details[open]").attr("data-enrichment-id"), latest.enrichmentId);
  assert.equal(load(renderMarketExplanationHistory(ai, { symbols: [latest.ticker] }))("details").length, 1);
  assert.equal(renderMarketExplanationHistory(ai, { symbols: [] }), "");
  assert.equal(renderMarketExplanationHistory({ ...ai, mode: "shadow" }), "");
  ai.marketExplanations[latest.subjectId].refreshStatus = "running";
  $ = load(renderMarketExplanationHistory(ai));
  assert.equal($("details").length, 3);
  assert.match($('[role="status"]').text(), /Analysis in progress/);
});
