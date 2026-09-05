import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../server.js";
import WebSocket from "ws";
import stateManager from "../state/stateManager.js";
import { MockAiProvider } from "../services/ai/aiProviders.js";
import { applyUpdate, getState, setSnapshot } from "../../frontend/js/state.js";

test("AI layer is additive and performs no work when off", async () => {
  const runtime = createAppServer({
    port: 0,
    runtime: { disableBackgroundRefresh: true },
    market: { enabled: false, provider: "", historyPersist: false },
    ai: { provider: "none", mode: "off", stateFile: null, budgetStateFile: null }
  });
  await runtime.start();
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    const snapshotResponse = await fetch(`${baseUrl}/api/intel/snapshot?countries=ALL`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.data.ai.enabled, false);
    assert.equal(snapshot.data.ai.mode, "off");
    assert.deepEqual(snapshot.data.ai.articleSummaries, {});
    assert.deepEqual(snapshot.data.ai.marketExplanationHistory, []);

    const pipelineResponse = await fetch(`${baseUrl}/api/admin/pipeline-status`);
    const pipeline = await pipelineResponse.json();
    assert.equal(pipeline.data.ai.activeProvider, "none");
    assert.equal(pipeline.data.ai.transport.calls, 0);

    const recordsResponse = await fetch(`${baseUrl}/api/admin/ai-enrichments?page=1&pageSize=10`);
    const records = await recordsResponse.json();
    assert.equal(recordsResponse.status, 200);
    assert.equal(records.data.pagination.totalItems, 0);

    const invalidQuery = await fetch(`${baseUrl}/api/admin/ai-enrichments?rawPrompt=1`);
    assert.equal(invalidQuery.status, 404);
  } finally {
    await runtime.stop();
  }
});

test("visible market history reaches REST, WebSocket bootstrap/updates and frontend state with country filters", async (t) => {
  const aiProvider = new MockAiProvider({ handler: (request) => {
    const input = JSON.parse(request.messages[1].content);
    return { instrumentId: input.subject.instrumentId, narrative: "A temporal association is observed.",
      narrativeEvidenceArticleIds: [input.evidence[0].articleId], drivers: [], causality: "not_established",
      limitations: ["Causality is not established."], uncertainty: { level: "medium", notes: [] } };
  } });
  const runtime = createAppServer({ port: 0, host: "127.0.0.1", disableBackgroundRefresh: true, aiProvider,
    news: { providers: [], rssFeeds: [] }, market: { provider: "", historyPersist: false },
    ai: { provider: "llamacpp", mode: "visible", features: ["market-explanation"], maxJobsPerCycle: 1, stateFile: null, budgetStateFile: null }
  });
  let socket;
  t.after(async () => {
    socket?.terminate();
    if (runtime.server.listening) await runtime.stop();
    else runtime.socketServer.close();
  });
  await runtime.start();
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for market history");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const instruments = ["LMT", "XOM"].map((symbol) => ({ instrumentId: `instrument-${symbol}`, canonicalSymbol: symbol, displayName: symbol }));
  const articles = instruments.map((instrument) => ({ id: `news-${instrument.canonicalSymbol}`, title: `${instrument.canonicalSymbol} reports disruption`,
    provider: "rss", sourceName: "Publisher", url: `https://example.com/${instrument.canonicalSymbol}`, publishedAt: "2026-09-05T08:00:00Z",
    countryMentions: [instrument.canonicalSymbol === "LMT" ? "US" : "IL"], analysisScore: 90, synthetic: false, dataMode: "observed" }));
  const impact = { items: instruments.map((instrument, index) => ({ ticker: instrument.canonicalSymbol, eventScore: 5, impactScore: 10 - index,
    linkedArticles: [articles[index].id], linkedCountries: articles[index].countryMentions })) };
  stateManager.updateIntel({ news: articles, impact });
  const input = { snapshot: stateManager.getSnapshot(), signalCorpus: articles, displaySelection: articles, rawArticles: articles, instruments };
  runtime.aiCoordinator.reconcileNewsSnapshot(input);
  await waitUntil(() => runtime.aiCoordinator.active === 0);
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  const messages = [];
  socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/ws");
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await waitUntil(() => messages.some((message) => message.type === "snapshot"));
  const bootstrap = messages.find((message) => message.type === "snapshot");
  assert.deepEqual(bootstrap.data.ai.marketExplanationHistory.map((entry) => entry.ticker), ["LMT"]);
  setSnapshot(bootstrap.data);
  runtime.aiCoordinator.reconcileMarketSnapshot(input);
  await waitUntil(() => messages.some((message) => message.type === "ai:update:v1" && message.data.ai.marketExplanationHistory.length === 2));
  const update = messages.filter((message) => message.type === "ai:update:v1").at(-1);
  applyUpdate(update.data);
  assert.deepEqual(getState().ai.marketExplanationHistory.map((entry) => entry.ticker), ["XOM", "LMT"]);
  const all = await (await fetch(`${baseUrl}/api/intel/snapshot?countries=ALL`)).json();
  assert.deepEqual(all.data.ai.marketExplanationHistory, getState().ai.marketExplanationHistory);
  const filtered = await (await fetch(`${baseUrl}/api/intel/snapshot?countries=US`)).json();
  assert.deepEqual(filtered.data.ai.marketExplanationHistory.map((entry) => entry.ticker), ["LMT"]);
  const empty = await (await fetch(`${baseUrl}/api/intel/snapshot?countries=IR`)).json();
  assert.deepEqual(empty.data.ai.marketExplanationHistory, []);
});
