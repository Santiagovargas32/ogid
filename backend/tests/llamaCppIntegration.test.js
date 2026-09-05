import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createAppServer } from "../server.js";
import { LlamaCppProvider, createAiProvider } from "../services/ai/aiProviders.js";
import { AiEnrichmentCoordinator } from "../services/ai/aiEnrichmentCoordinator.js";
import { AiEnrichmentStore } from "../services/ai/aiEnrichmentStore.js";
import { AiBudgetService } from "../services/ai/aiBudgetService.js";
import { ProviderRuntime } from "../services/providers/providerRuntime.js";

function article(id = "article-a", sourceName = "Publisher A") {
  return { id, sourceName, provider: "rss", title: `Exxon disruption reported by ${sourceName} in United States`,
    url: `https://${id}.example/story`, publishedAt: "2026-09-05T08:00:00Z", receivedAt: "2026-09-05T08:01:00Z",
    countryMentions: ["US"], excerpt: "Exxon reports disruption.", analysisScore: 90,
    synthetic: false, dataMode: "observed", usagePolicy: "headline-only-link-out" };
}
function snapshotInput(articles = [article(), article("article-b", "Publisher B")]) {
  return {
    snapshot: { countries: { US: { score: 20 } }, market: { quotes: {} },
      impact: { items: [{ ticker: "XOM", eventScore: 5, impactScore: 3, linkedArticles: [articles[0].id] }] } },
    signalCorpus: articles, displaySelection: articles,
    rawArticles: articles.map((item) => ({ ...item, publisher: item.sourceName })),
    instruments: [{ instrumentId: "us-equity-exxon-mobil", canonicalSymbol: "XOM", displayName: "Exxon Mobil Corporation" }]
  };
}
function groundedResponse(options, corrupt = false) {
  const input = JSON.parse(JSON.parse(options.body).messages[1].content);
  const ids = [corrupt ? "ca_invented" : input.evidence[0].articleId];
  const uncertainty = { level: "high", notes: ["Limited evidence."] };
  const outputs = {
    article_summary: { summary: "A reported disruption.", summaryEvidenceArticleIds: ids, keyDevelopments: [], entities: [], uncertainty },
    country_insight: { countryId: "US", overview: "Reports describe disruption.", overviewEvidenceArticleIds: ids, developments: [], scenarios: [], informationGaps: [], uncertainty },
    market_explanation: { instrumentId: "us-equity-exxon-mobil", narrative: "A temporal association is observed.", narrativeEvidenceArticleIds: ids, drivers: [], causality: "not_established", limitations: ["Causality is not established."], uncertainty }
  };
  return new Response(JSON.stringify({ model: "actual.gguf", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(outputs[input.task]), reasoning_content: "never-store-this-reasoning" } }], usage: { total_tokens: 20 } }));
}
async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("AI integration condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function coordinatorHarness({ mode = "visible", store = new AiEnrichmentStore(), budget = new AiBudgetService(), fetchImpl = async (_url, options) => groundedResponse(options) } = {}) {
  const transport = new ProviderRuntime({ fetchImpl, failureThreshold: 2, recoveryMs: 1 });
  const provider = new LlamaCppProvider({ baseUrl: "http://localhost:8080/v1", summaryModel: "qwen3.8-27b", runtime: transport, maxRetries: 0 });
  const broadcasts = [];
  const config = { provider: "llamacpp", mode, features: ["article-summary", "country-insight", "market-explanation"], maxJobsPerCycle: 10 };
  const coordinator = new AiEnrichmentCoordinator({ config, provider, store, budget, socketServer: { broadcast: (type, data) => broadcasts.push({ type, data }) } });
  return { coordinator, store, budget, transport, broadcasts };
}

test("llama.cpp shadow persists all three features and public REST/WebSockets expose no generated output", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ogid-llamacpp-integration-"));
  const transport = new ProviderRuntime({ fetchImpl: async (_url, options) => groundedResponse(options) });
  const aiProvider = new LlamaCppProvider({ baseUrl: "http://localhost:8080/v1", apiKey: "private-test-key", summaryModel: "qwen3.8-27b", runtime: transport });
  const runtime = createAppServer({ port: 0, host: "127.0.0.1", disableBackgroundRefresh: true,
    news: { providers: [], rssFeeds: [] }, market: { provider: "", historyPersist: false },
    security: { allowLocalAdmin: false, adminApiToken: "test-admin-token" }, aiProvider,
    ai: { provider: "llamacpp", mode: "shadow", features: ["article-summary", "country-insight", "market-explanation"],
      baseUrl: "http://localhost:8080/v1", apiKey: "private-test-key", summaryModel: "qwen3.8-27b",
      stateFile: join(directory, "enrichments.json"), budgetStateFile: join(directory, "budget.json") }
  });
  let socket;
  t.after(async () => {
    socket?.terminate();
    if (runtime.server.listening) await runtime.stop();
    else runtime.socketServer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await runtime.start();
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/ws");
  const messages = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await waitUntil(() => socket.readyState === WebSocket.OPEN);
  const input = snapshotInput();
  const originalInput = structuredClone(input);
  // Keep optional deterministic analytics identical across this simulated
  // restart; a changed analytics timestamp correctly changes the market hash.
  runtime.aiCoordinator.technicalIndicatorService = null;
  runtime.aiCoordinator.newsPriceCouplingService = null;
  runtime.aiCoordinator.reconcileNewsSnapshot(input);
  await waitUntil(() => runtime.aiCoordinator.store.summary().counts.ready === 4 && runtime.aiCoordinator.active === 0);
  assert.deepEqual(input, originalInput);
  await waitUntil(() => messages.some((message) => message.type === "ai:update:v1"));
  assert.ok(messages.filter((message) => message.type === "ai:update:v1").every((message) => Object.keys(message.data.ai.articleSummaries).length === 0));
  assert.doesNotMatch(JSON.stringify(messages), /A reported disruption|Reports describe disruption|A temporal association|private-test-key|never-store-this-reasoning/);
  const snapshot = await (await fetch(`${baseUrl}/api/intel/snapshot?countries=ALL`)).json();
  assert.deepEqual(snapshot.data.ai.articleSummaries, {});
  assert.deepEqual(snapshot.data.ai.countryInsights, {});
  assert.deepEqual(snapshot.data.ai.marketExplanations, {});
  assert.equal((await fetch(`${baseUrl}/api/admin/ai-enrichments`)).status, 401);
  const headers = { Authorization: "Bearer test-admin-token" };
  const records = await (await fetch(`${baseUrl}/api/admin/ai-enrichments`, { headers })).json();
  assert.equal(records.data.pagination.totalItems, 4);
  assert.deepEqual([...new Set(records.data.items.map((item) => item.kind))].sort(), ["article_summary", "country_insight", "market_explanation"]);
  assert.ok(records.data.items.every((item) => item.status === "ready" && item.validation.valid));
  const pipeline = await (await fetch(`${baseUrl}/api/admin/pipeline-status`, { headers })).json();
  assert.equal(pipeline.data.ai.activeProvider, "llamacpp");
  assert.equal(pipeline.data.ai.mode, "shadow");
  assert.equal(pipeline.data.ai.apiKeyConfigured, true);
  assert.equal(pipeline.data.ai.transport.calls, 4);
  const storedText = readFileSync(join(directory, "enrichments.json"), "utf8");
  assert.doesNotMatch(storedText, /private-test-key|never-store-this-reasoning|"messages"|"reasoning_content"/);
  const restarted = coordinatorHarness({ mode: "shadow", store: new AiEnrichmentStore({ persistencePath: join(directory, "enrichments.json") }), budget: new AiBudgetService({ persistencePath: join(directory, "budget.json") }), fetchImpl: () => assert.fail("persisted cache must avoid another call") });
  restarted.coordinator.reconcileNewsSnapshot(input);
  assert.equal(restarted.coordinator.metrics.cacheHits, 4);
  assert.equal(restarted.budget.snapshot().requestsUsed, 4);
});

test("llama.cpp in-flight jobs deduplicate and visible accepted cache survives repeated outages", async () => {
  let release;
  let fail = false;
  let hold = true;
  const h = coordinatorHarness({ fetchImpl: async (_url, options) => {
    if (hold) await new Promise((resolve) => { release = resolve; });
    if (fail) throw new Error("connection refused private details");
    return groundedResponse(options);
  } });
  h.coordinator.features = new Set(["article_summary"]);
  const input = snapshotInput([article()]);
  h.coordinator.reconcileNewsSnapshot(input);
  await waitUntil(() => release);
  h.coordinator.reconcileNewsSnapshot(input);
  assert.equal(h.store.summary().total, 1);
  hold = false;
  release();
  await waitUntil(() => h.coordinator.active === 0);
  assert.equal(h.store.summary().counts.ready, 1);
  h.coordinator.reconcileNewsSnapshot(input);
  assert.equal(h.coordinator.metrics.cacheHits, 1);
  fail = true;
  for (const suffix of [" updated", " updated again"]) {
    const changed = snapshotInput([{ ...article(), title: article().title + suffix }]);
    h.coordinator.reconcileNewsSnapshot(changed);
    await waitUntil(() => h.coordinator.active === 0);
    const projection = h.coordinator.getPublicProjection();
    assert.equal(projection.articleSummaries[article().id].status, "stale");
    assert.equal(projection.articleSummaries[article().id].refreshStatus, "failed");
    assert.equal(projection.articleSummaries[article().id].output.summary, "A reported disruption.");
    assert.doesNotMatch(JSON.stringify(projection), /connection refused|private details/);
  }
  assert.equal(h.transport.getCircuitSnapshot("llamacpp").state, "open");
  await new Promise((resolve) => setTimeout(resolve, 5));
  fail = false;
  h.coordinator.reconcileNewsSnapshot(snapshotInput([{ ...article(), title: article().title + " recovered" }]));
  await waitUntil(() => h.coordinator.active === 0);
  assert.equal(h.coordinator.getPublicProjection().articleSummaries[article().id].status, "ready");
  assert.equal(h.transport.getCircuitSnapshot("llamacpp").state, "closed");
});

test("llama.cpp outputs with invented evidence are rejected by the unchanged grounding validator", async () => {
  const h = coordinatorHarness({ fetchImpl: async (_url, options) => groundedResponse(options, true) });
  h.coordinator.reconcileNewsSnapshot(snapshotInput());
  await waitUntil(() => h.coordinator.active === 0 && h.coordinator.queue.length === 0);
  assert.equal(h.store.summary().counts.rejected, 4);
  assert.ok(h.store.list().items.every((item) => item.output === null && item.validation.codes.includes("UNKNOWN_EVIDENCE_ARTICLE")));
});

test("a pending/unavailable llama.cpp server does not block news, market, awareness, health or update broadcasts", async (t) => {
  let release;
  let started = false;
  const blocked = new Promise((resolve) => { release = resolve; });
  const transport = new ProviderRuntime({ failureThreshold: 1, fetchImpl: async () => {
    started = true;
    await blocked;
    throw new Error("private connection details");
  } });
  const aiProvider = new LlamaCppProvider({ baseUrl: "http://localhost:8080/v1", summaryModel: "qwen3.8-27b", maxRetries: 0, runtime: transport });
  const runtime = createAppServer({ port: 0, host: "127.0.0.1", disableBackgroundRefresh: true,
    news: { providers: [], rssFeeds: [] }, market: { provider: "", historyPersist: false },
    aiProvider, ai: { provider: "llamacpp", mode: "shadow", features: ["article-summary"] }
  });
  t.after(async () => {
    release();
    if (runtime.server.listening) await runtime.stop();
    else runtime.socketServer.close();
  });
  await runtime.start();
  const broadcasts = [];
  const broadcast = runtime.socketServer.broadcast.bind(runtime.socketServer);
  runtime.socketServer.broadcast = (...args) => { broadcasts.push(args[0]); broadcast(...args); };
  runtime.aiCoordinator.reconcileNewsSnapshot(snapshotInput([article()]));
  await waitUntil(() => started);
  assert.equal(runtime.aiCoordinator.active, 1);
  await runtime.orchestrator.runNewsCycle("test-provider-offline");
  await runtime.orchestrator.runMarketCycle("test-provider-offline");
  await runtime.awarenessService.start();
  assert.ok(broadcasts.includes("update"));
  assert.equal(runtime.aiCoordinator.active, 1);
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  release();
  await waitUntil(() => runtime.aiCoordinator.active === 0);
  assert.equal(runtime.aiCoordinator.store.summary().counts.failed, 1);
  assert.equal(transport.getCircuitSnapshot("llamacpp").state, "open");
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
});

for (const [provider, mode] of [["llamacpp", "off"], ["nvidia", "off"], ["none", "visible"]]) {
  test(`${provider}/${mode} does zero model work without endpoint/model credentials`, () => {
    const store = new AiEnrichmentStore();
    const coordinator = new AiEnrichmentCoordinator({ config: { provider, mode, features: ["article-summary"] }, provider: createAiProvider({ provider, mode }), store, budget: new AiBudgetService() });
    coordinator.reconcileNewsSnapshot(snapshotInput());
    assert.equal(store.summary().total, 0);
    assert.equal(coordinator.getAdminSnapshot().transport.calls, 0);
  });
}
