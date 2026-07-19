import test from "node:test";
import assert from "node:assert/strict";
import { AiBudgetService } from "../services/ai/aiBudgetService.js";
import { AiEnrichmentCoordinator } from "../services/ai/aiEnrichmentCoordinator.js";
import { AiEnrichmentStore } from "../services/ai/aiEnrichmentStore.js";
import { AiProviderError, MockAiProvider, NoopAiProvider } from "../services/ai/aiProviders.js";

function fixtureArticle() {
  return {
    id: "legacy-ai-1",
    provider: "rss",
    sourceName: "Verified Publisher",
    title: "Verified Publisher reports disruption in the United States",
    description: "A verified disruption was reported.",
    excerpt: "A verified disruption was reported.",
    content: "",
    url: "https://example.com/verified-story",
    publishedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    countryMentions: ["US"],
    usagePolicy: "headline-only-link-out",
    dataMode: "observed",
    synthetic: false,
    analysisScore: 90,
    sentiment: { label: "negative" },
    conflict: { totalWeight: 1 }
  };
}

function outputFromRequest(request) {
  const input = JSON.parse(request.messages[1].content);
  const articleId = input.evidence[0].articleId;
  return {
    summary: "Verified Publisher reports a disruption.",
    summaryEvidenceArticleIds: [articleId],
    keyDevelopments: [{ text: "A disruption was reported.", evidenceArticleIds: [articleId] }],
    entities: [{ name: "Verified Publisher", type: "organization", evidenceArticleIds: [articleId] }],
    uncertainty: { level: "medium", notes: ["Single article."] }
  };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition-timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function harness(mode = "visible", provider = new MockAiProvider({ handler: outputFromRequest })) {
  let projection = null;
  const broadcasts = [];
  const store = new AiEnrichmentStore();
  const coordinator = new AiEnrichmentCoordinator({
    config: {
      provider: provider.name,
      mode,
      features: ["article-summary"],
      maxConcurrency: 1,
      maxQueueSize: 10,
      maxJobsPerCycle: 10,
      maxInputChars: 6_000
    },
    provider,
    store,
    budget: new AiBudgetService(),
    stateManager: {
      setAiProjection(value) { projection = value; },
      getMeta() { return {}; }
    },
    socketServer: { broadcast(type, data) { broadcasts.push({ type, data }); } }
  });
  return { coordinator, provider, store, broadcasts, projection: () => projection };
}

test("visible coordinator enriches after deterministic input and maps output to legacy article id", async () => {
  const context = harness("visible");
  const article = fixtureArticle();
  context.coordinator.reconcileNewsSnapshot({
    snapshot: { market: { quotes: {} }, countries: {}, impact: { items: [] } },
    signalCorpus: [article],
    displaySelection: [article],
    rawArticles: [{ ...article, publisher: "Verified Publisher", provenance: { sourceType: "rss" } }],
    instruments: []
  });
  await waitUntil(() => context.store.summary().counts.ready === 1);
  const projection = context.coordinator.getPublicProjection();
  assert.equal(projection.articleSummaries[article.id].status, "ready");
  assert.match(projection.articleSummaries[article.id].output.summary, /disruption/);
  assert.equal(projection.articleSummaries[article.id].provenance.evidence[0].sourceName, "Verified Publisher");
  assert.equal(projection.articleSummaries[article.id].provenance.evidence[0].canonicalUrl, "https://example.com/verified-story");
  assert.ok(context.broadcasts.some((event) => event.type === "ai:update:v1"));
});

test("shadow coordinator stores accepted output but publishes no generated text", async () => {
  const context = harness("shadow");
  const article = fixtureArticle();
  context.coordinator.reconcileNewsSnapshot({
    snapshot: { market: { quotes: {} }, countries: {}, impact: { items: [] } },
    signalCorpus: [article],
    displaySelection: [article],
    rawArticles: [{ ...article, publisher: "Verified Publisher" }]
  });
  await waitUntil(() => context.store.summary().counts.ready === 1);
  assert.equal(context.store.list().items[0].output.summary.length > 0, true);
  assert.deepEqual(context.coordinator.getPublicProjection().articleSummaries, {});
});

test("off/none coordinator performs zero provider work", () => {
  const context = harness("off", new NoopAiProvider());
  const article = fixtureArticle();
  context.coordinator.reconcileNewsSnapshot({
    snapshot: { market: { quotes: {} } },
    signalCorpus: [article],
    displaySelection: [article],
    rawArticles: [article]
  });
  assert.equal(context.store.summary().total, 0);
  assert.equal(context.coordinator.getPublicProjection().enabled, false);
});

test("coordinator persists safe provider metadata when an enrichment fails", async () => {
  const responseMetadata = {
    requestedModel: "openai/gpt-oss-20b",
    payloadModel: "openai/gpt-oss-20b",
    finishReason: "length",
    requestId: "req-failed",
    usage: { promptTokens: 100, completionTokens: 1_200, totalTokens: 1_300 },
    contentType: "string",
    contentLength: 4_096,
    hasReasoningContent: true
  };
  const provider = {
    name: "nvidia",
    enabled: true,
    modelForKind: () => "openai/gpt-oss-20b",
    getMetrics: () => ({}),
    async generate() {
      throw new AiProviderError("AI_INVALID_JSON", "invalid JSON", { responseMetadata });
    }
  };
  const context = harness("shadow", provider);
  const article = fixtureArticle();
  context.coordinator.reconcileNewsSnapshot({
    snapshot: { market: { quotes: {} }, countries: {}, impact: { items: [] } },
    signalCorpus: [article],
    displaySelection: [article],
    rawArticles: [article]
  });
  await waitUntil(() => context.store.summary().counts.failed === 1);
  const record = context.store.list({ status: "failed" }).items[0];
  assert.equal(record.output, null);
  assert.equal(record.requestId, "req-failed");
  assert.deepEqual(record.usage, responseMetadata.usage);
  assert.deepEqual(record.providerResponse, responseMetadata);
  assert.deepEqual(record.validation.codes, ["AI_INVALID_JSON"]);
  assert.equal(Object.hasOwn(record.providerResponse, "content"), false);
  assert.equal(Object.hasOwn(record.providerResponse, "reasoningContent"), false);
});
