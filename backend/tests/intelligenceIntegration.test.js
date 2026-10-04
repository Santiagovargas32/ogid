import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAppServer } from "../server.js";
import { MockAiProvider } from "../services/ai/aiProviders.js";

function options(ai = {}, extra = {}) {
  return { port: 0, host: "127.0.0.1", disableBackgroundRefresh: true,
    news: { providers: [], rssFeeds: [] }, market: { provider: "", historyPersist: false },
    aiProvider: new MockAiProvider(),
    ai: { provider: "llamacpp", mode: "off", features: ["intelligence"], memoryEnabled: true, ...ai }, ...extra };
}

test("off, missing memory, missing feature and disabled provider create no prospective storage", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ogid-off-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const ai of [{ mode: "off" }, { mode: "shadow", memoryEnabled: false },
    { mode: "shadow", features: ["article-summary"] }, { mode: "shadow", provider: "none" }]) {
    const runtime = createAppServer(options({ ...ai, memoryDir: path.join(dir, "archive") },
      ai.provider === "none" ? { aiProvider: null } : {}));
    assert.equal(runtime.aiCoordinator.intelligence, null);
    assert.equal(runtime.orchestrator.evidenceMemory, null);
    assert.equal(runtime.aiCoordinator.config.taskProfiles, null);
    await runtime.aiCoordinator.stop();
    runtime.socketServer.close();
  }
  await assert.rejects(access(path.join(dir, "archive")), { code: "ENOENT" });
});

test("ordinary llama.cpp retains legacy limits; unlimited remote budgets and invalid active context fail", () => {
  const runtime = createAppServer(options({ mode: "shadow", features: ["article-summary"] }));
  assert.equal(runtime.aiCoordinator.config.maxOutputTokens, 1200);
  assert.equal(runtime.aiCoordinator.config.taskProfiles, null);
  runtime.socketServer.close();
  assert.throws(() => createAppServer(options({ provider: "nvidia", dailyRequestBudget: 0 })), { code: "AI_UNLIMITED_REQUIRES_LOCAL" });
  assert.throws(() => createAppServer(options({ mode: "shadow", contextTokens: 1000 })), { code: "AI_CONTEXT_CONFIG_INVALID" });
});

test("server lifecycle starts prospective work only when background refresh is enabled", async (t) => {
  for (const disabled of [true, false]) {
    const runtime = createAppServer(options({ mode: "shadow", memoryDir: null }, { disableBackgroundRefresh: disabled }));
    const service = runtime.aiCoordinator.intelligence;
    runtime.orchestrator.start = () => {};
    runtime.mediaStreamService.start = () => {};
    runtime.awarenessService.start = async () => {};
    let starts = 0;
    const start = service.start.bind(service);
    service.start = (...args) => { starts++; return start(...args); };
    await runtime.start();
    t.after(() => runtime.server.listening ? runtime.stop() : undefined);
    assert.equal(starts, disabled ? 0 : 1);
    assert.equal(Boolean(service.timer), !disabled);
    const health = await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/health`);
    assert.equal(health.status, 200);
    await runtime.stop();
    assert.equal(service.stopped, true);
  }
});

test("RSS cycle captures admitted news, forwards market corpus and tolerates archive failure", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(`<rss><channel><item><title>United States military security report</title>
    <link>https://fixture.example/news</link><description>Officials reported a military security development in the United States.</description>
    <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`, { headers: { "content-type": "application/xml" } });
  const runtime = createAppServer(options({ mode: "shadow", memoryDir: null }, {
    news: { providers: ["rss"], rssFeeds: [{ label: "Fixture", url: "https://fixture.example/rss" }], timeoutMs: 200 }
  }));
  t.after(async () => { await runtime.aiCoordinator.stop(); runtime.socketServer.close(); });
  // Keep this test focused on the admitted news path, without ancillary fetching.
  runtime.orchestrator.resolveAggregateNewsSnapshot = async () => ({ items: [] });
  runtime.orchestrator.enrichSnapshotWithMapAssets = async (snapshot) => snapshot;
  runtime.orchestrator.refreshSecondaryIntel = async () => {};
  let input;
  runtime.aiCoordinator.reconcileNewsSnapshot = (value) => { input = value; };
  await runtime.orchestrator.runNewsCycle("intelligence-fixture");
  assert.equal(runtime.orchestrator.newsCycleTelemetry.lastStatus, "ok");
  assert.ok(input.marketSignalCorpus.length > 0);
  assert.ok(runtime.aiCoordinator.intelligence.store.list("evidence").length > 0);
  runtime.orchestrator.evidenceMemory.capture = async () => { throw new Error("fixture-storage-failure"); };
  await runtime.orchestrator.runNewsCycle("intelligence-storage-failure");
  assert.equal(runtime.orchestrator.newsCycleTelemetry.lastStatus, "ok");
});

test("off keeps REST operational and visible scenarios reach the existing snapshot endpoint", async (t) => {
  for (const mode of ["off", "visible"]) {
    let calls = 0;
    const aiProvider = new MockAiProvider({ handler: ({ messages }) => {
      calls++;
      const packet = JSON.parse(messages[1].content);
      return { eventId: packet.subject.eventId, overview: "Análisis condicional", assessment: "conditional_only",
        scenarios: [{ condition: "Si ocurre", implications: "Se revisa el contexto", evidenceIds: [packet.evidence[0].evidenceId], invalidators: [] }],
        informationGaps: ["Consenso no disponible"] };
    } });
    const runtime = createAppServer(options({ mode, memoryDir: null, countries: [] }, { aiProvider }));
    await runtime.start();
    t.after(() => runtime.server.listening ? runtime.stop() : undefined);
    runtime.aiCoordinator.start();
    if (mode === "visible") {
      const service = runtime.aiCoordinator.intelligence;
      service.activeInstruments = () => [];
      await service.memory.capture([{ eventId: "fixture-event", title: "Official release", status: "scheduled",
        source: { sourceId: "official", official: true }, scheduledAt: new Date(Date.now() + 86400000).toISOString() }]);
      await service.tick();
      const deadline = Date.now() + 2000;
      while (runtime.aiCoordinator.metrics.completed !== 1) {
        if (Date.now() > deadline) throw new Error("scenario-rest-timeout");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const base = `http://127.0.0.1:${runtime.server.address().port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const snapshot = await (await fetch(`${base}/api/intel/snapshot`)).json();
    assert.equal(snapshot.data.ai.eventScenarios?.length || 0, mode === "visible" ? 1 : 0);
    assert.equal(calls, mode === "visible" ? 1 : 0);
    await runtime.stop();
  }
});
