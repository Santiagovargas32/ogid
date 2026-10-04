import test from "node:test";
import assert from "node:assert/strict";
import { AiEnrichmentCoordinator } from "../services/ai/aiEnrichmentCoordinator.js";
import { AiEnrichmentStore } from "../services/ai/aiEnrichmentStore.js";
import { AiBudgetService } from "../services/ai/aiBudgetService.js";
import { MockAiProvider } from "../services/ai/aiProviders.js";
import { IntelligenceStore } from "../services/intel/intelligenceStore.js";
import { EvidenceMemoryService } from "../services/intel/evidenceMemoryService.js";
import { ForecastService } from "../services/intel/forecastService.js";
import { ProspectiveIntelligenceService } from "../services/intel/prospectiveIntelligenceService.js";

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("prospective-test-timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const mode of ["shadow", "visible"]) {
  test(`${mode} schedules grounded event scenarios through the existing coordinator and stops cleanly`, async (t) => {
    const now = Date.parse("2026-10-04T10:00:00Z");
    const store = new IntelligenceStore({ now: () => now });
    const memory = new EvidenceMemoryService({ store, now: () => now });
    const event = { eventId: "release", title: "Official scheduled release", status: "scheduled",
      countries: ["US"], scheduledAt: "2026-10-05T10:00:00Z", source: { sourceId: "official", official: true } };
    const awarenessStore = { events: new Map([["release", event]]), sourceStatuses: new Map([["official", { admissionState: "active" }]]) };
    const config = { provider: "llamacpp", mode, features: ["intelligence"], countries: [],
      analysisIntervalMs: 60000, packetMaxChars: 96000, maxJobsPerCycle: 2 };
    const intelligence = new ProspectiveIntelligenceService({ config, store, memory, awarenessStore, now: () => now,
      forecastService: new ForecastService({ store, now: () => now }),
      stateManager: { getSnapshot: () => ({ countries: {}, market: {} }) },
      marketWatchlistService: { selectedInstruments: () => [] },
      marketConditionsService: { getSnapshot: () => ({ symbols: [] }) } });
    let calls = 0;
    const provider = new MockAiProvider({ handler: ({ messages }) => {
      calls++;
      const packet = JSON.parse(messages[1].content);
      return { eventId: packet.subject.eventId, overview: "Escenarios condicionales", assessment: "conditional_only",
        scenarios: [{ condition: "Si se confirma", implications: "Se revisaría el contexto", evidenceIds: [packet.evidence[0].evidenceId], invalidators: [] }],
        informationGaps: ["No hay consenso numérico."] };
    } });
    const coordinator = new AiEnrichmentCoordinator({ config, provider, intelligence, store: new AiEnrichmentStore(), budget: new AiBudgetService() });
    t.after(() => coordinator.stop());
    coordinator.start();
    coordinator.start();
    await intelligence.tick();
    await waitUntil(() => store.list("analysis").length === 1);
    await intelligence.tick();
    assert.equal(calls, 1);
    assert.equal(coordinator.metrics.completed, 1);
    assert.equal(store.list("analysis")[0].kind, "event_scenarios");
    assert.equal(Boolean(store.list("analysis")[0].packetHash), true);
    const projection = coordinator.getPublicProjection();
    assert.equal(projection.eventScenarios?.length || 0, mode === "visible" ? 1 : 0);
    await coordinator.stop();
    await intelligence.tick();
    assert.equal(calls, 1);
    assert.equal(intelligence.busy, false);
  });
}

test("shutdown waits for evidence capture and does not enqueue after stopping", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let enqueued = 0;
  const store = new IntelligenceStore();
  const intelligence = new ProspectiveIntelligenceService({
    config: { provider: "llamacpp", mode: "shadow", features: ["intelligence"], analysisIntervalMs: 60000, maxJobsPerCycle: 1 },
    store, memory: { captureAwareness: () => pending }, forecastService: { resolve: async () => {} }
  });
  intelligence.buildJobs = () => [{ kind: "event_scenarios", subjectId: "event" }];
  intelligence.start(() => { enqueued++; return true; });
  const tick = intelligence.tick();
  let stopped = false;
  const stop = intelligence.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stopped, false);
  release();
  await Promise.all([tick, stop]);
  assert.equal(enqueued, 0);
});

test("market scenarios archive grounded output and issue the empirical forecast through the same queue", async (t) => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const store = new IntelligenceStore({ now: () => now });
  const memory = new EvidenceMemoryService({ store, now: () => now });
  const instrument = { instrumentId: "crypto-bitcoin-us-dollar", canonicalSymbol: "BTC/USD", assetType: "crypto", sessionPolicy: "24x7", timezone: "UTC" };
  await memory.capture([{ id: "btc-report", title: "Bitcoin market report", url: "https://fixture.example/bitcoin",
    sourceId: "fixture", publishedAt: "2026-10-04T11:00:00Z", instrumentIds: [instrument.instrumentId], dataMode: "observed" }]);
  const candles = Array.from({ length: 60 }, (_, i) => ({ interval: "1day", dataMode: "observed", quality: "valid", open: 100, close: 100 + (i % 3 - 1),
    openTime: new Date(now - (61 - i) * 86400000).toISOString(), closeTime: new Date(now - (60 - i) * 86400000).toISOString() }));
  const config = { provider: "llamacpp", mode: "visible", features: ["intelligence"], countries: [], analysisIntervalMs: 60000, packetMaxChars: 96000, maxJobsPerCycle: 2 };
  const forecastService = new ForecastService({ store, candleStore: { query: () => candles }, now: () => now });
  const intelligence = new ProspectiveIntelligenceService({ config, store, memory, forecastService, now: () => now,
    stateManager: { getSnapshot: () => ({ countries: {}, market: {} }) },
    marketWatchlistService: { selectedInstruments: () => [instrument] },
    marketConditionsService: { getSnapshot: () => ({ symbols: [] }) } });
  const provider = new MockAiProvider({ handler: ({ messages }) => {
    const packet = JSON.parse(messages[1].content);
    return { instrumentId: packet.subject.instrumentId, assessment: "conditional", overview: "Contexto limitado", weights: { down: 0.2, flat: 0.3, up: 0.5 },
      scenarios: ["down", "flat", "up"].map((direction) => ({ direction, description: "Hipótesis condicional",
        supportingEvidenceIds: [packet.evidence[0].evidenceId], opposingEvidenceIds: [], triggers: [], invalidators: [] })), informationGaps: [] };
  } });
  const coordinator = new AiEnrichmentCoordinator({ config, provider, intelligence, store: new AiEnrichmentStore(), budget: new AiBudgetService() });
  t.after(() => coordinator.stop());
  coordinator.start();
  await intelligence.tick();
  await waitUntil(() => coordinator.metrics.completed === 1);
  assert.equal(store.list("forecast").length, 1);
  assert.deepEqual(store.list("forecast")[0].probabilities, { down: 1 / 3, flat: 1 / 3, up: 1 / 3 });
  const projection = coordinator.getPublicProjection();
  assert.equal(projection.marketScenarios[instrument.instrumentId].length, 1);
  assert.equal(projection.evaluation.llmWeight, 0);
});
