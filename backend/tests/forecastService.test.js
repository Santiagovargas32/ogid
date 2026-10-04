import test from "node:test";
import assert from "node:assert/strict";
import { IntelligenceStore } from "../services/intel/intelligenceStore.js";
import { ForecastService, buildForecastBaseline, scoreForecast } from "../services/intel/forecastService.js";
import { validateScenarioOutput } from "../services/ai/aiScenarioSchemas.js";

const day = 86400000;
const at = Date.parse("2026-10-04T12:00:00Z");
const instrument = { instrumentId: "crypto-bitcoin-us-dollar", canonicalSymbol: "BTC/USD", assetType: "crypto", sessionPolicy: "24x7", timezone: "UTC" };
const candles = Array.from({ length: 60 }, (_, i) => ({ interval: "1day", dataMode: "observed", quality: "valid",
  openTime: new Date(at - (61 - i) * day).toISOString(), closeTime: new Date(at - (60 - i) * day).toISOString(),
  open: 100, close: 100 + (i % 3 - 1) }));

test("baseline requires observed history without future leakage and remains uncalibrated", () => {
  const insufficient = buildForecastBaseline({ instrument, candles: candles.slice(0, 59), asOf: new Date(at).toISOString() });
  assert.equal(insufficient.probabilities, null);
  const baseline = buildForecastBaseline({ instrument, candles: [...candles,
    { ...candles[0], openTime: new Date(at).toISOString(), closeTime: new Date(at + day).toISOString(), close: 10000 },
    { ...candles[0], synthetic: true }], asOf: new Date(at).toISOString() });
  assert.equal(baseline.status, "available");
  assert.equal(baseline.sampleSize, 60);
  assert.equal(baseline.probabilityStatus, "experimental_uncalibrated");
  assert.deepEqual(baseline.probabilities, { down: 1 / 3, flat: 1 / 3, up: 1 / 3 });
  assert.equal(scoreForecast({ down: 0, flat: 0, up: 1 }, "up").brier, 0);
});

test("one immutable emission per target resolves once and keeps LLM weight at zero", async () => {
  let now = at;
  const store = new IntelligenceStore({ now: () => now });
  let observed = candles;
  const service = new ForecastService({ store, now: () => now, candleStore: { query: () => observed } });
  const baseline = service.baseline(instrument, new Date(at).toISOString());
  const job = { subjectId: instrument.instrumentId, input: { baseline, asOf: new Date(at).toISOString() } };
  const result = { output: { weights: { down: 0.1, flat: 0.1, up: 0.8 } }, provider: "mock", model: "test" };
  const id = await service.issue({ job, result, packetHash: "packet" });
  assert.equal(await service.issue({ job, result, packetHash: "another-packet" }), id);
  assert.equal(store.list("forecast").length, 1);
  assert.deepEqual(store.get("forecast", id).probabilities, baseline.probabilities);
  now = Date.parse(baseline.target.resolveAt) + 1;
  await service.resolve();
  assert.equal(service.evaluation().overdueUnresolvedCount, 1);
  observed = [{ interval: "1day", dataMode: "observed", quality: "valid", openTime: baseline.target.referenceAt,
    closeTime: baseline.target.resolveAt, open: 100, close: 102 }];
  await service.resolve();
  await service.resolve();
  assert.equal(store.list("resolution").length, 1);
  assert.equal(store.get("resolution", id).outcome, "up");
  assert.equal(service.evaluation().resolvedCount, 1);
  assert.equal(service.evaluation().llmWeight, 0);
  await assert.rejects(store.put("forecast", id, { changed: true }, { immutable: true }), { code: "IMMUTABLE_RECORD" });
  assert.equal(store.status.healthy, true);
});

test("scenario validation rejects unknown evidence, bad partitions and unsupported probabilities", () => {
  const evidenceId = "ev_" + "a".repeat(32);
  const output = { instrumentId: "instrument", assessment: "conditional", overview: "Contexto", weights: null,
    scenarios: ["down", "flat", "up"].map((direction) => ({ direction, description: "Hipótesis",
      supportingEvidenceIds: [evidenceId], opposingEvidenceIds: [], triggers: [], invalidators: [] })), informationGaps: [] };
  const context = { subjectId: "instrument", allowedEvidenceIds: [evidenceId], hasBaseline: false };
  assert.equal(validateScenarioOutput("market_scenarios", output, context).valid, true);
  assert.equal(validateScenarioOutput("market_scenarios", output, { ...context, allowedEvidenceIds: [] }).valid, false);
  assert.equal(validateScenarioOutput("market_scenarios", { ...output, weights: { down: 0.2, flat: 0.3, up: 0.5 } }, context).valid, false);
  assert.equal(validateScenarioOutput("market_scenarios", { ...output, scenarios: [output.scenarios[0], output.scenarios[0], output.scenarios[2]] }, context).valid, false);
});
