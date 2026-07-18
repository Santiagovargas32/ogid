import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeCanonicalCandle } from "../services/market/canonicalCandle.js";
import { DailyCandleStore } from "../services/market/dailyCandleStore.js";
import { IntradayCandleService, projectCombinedIntradayBudget } from "../services/market/intradayCandleService.js";
import { getInstrumentById, listEnabledInstruments } from "../services/market/instrumentRegistry.js";
import { isInstrumentSessionEligible, MarketCreditScheduler, TWELVE_BASIC_POLICY } from "../services/market/marketCreditScheduler.js";

const nowMs = Date.parse("2026-07-13T15:00:00Z");
const gd = getInstrumentById("us-equity-general-dynamics");
function config(scheduler, extras = {}) { return { provider: "twelve", twelveBaseUrl: "https://api.twelvedata.com", twelveApiKey: "test", timeoutMs: 100, tickers: listEnabledInstruments(3).map((item) => item.canonicalSymbol), watchlistRollout: 3, creditScheduler: scheduler, creditPolicy: scheduler.policy, dailyCandles: { enabled: true }, intradayCandles: { enabled: true, interval: "15min", pollIntervalMs: 900_000, adjustmentMode: "splits", ...extras } }; }

test("combined projection keeps rollout budgets below soft limit by widening polling only", () => {
  const rollout1 = projectCombinedIntradayBudget({ instruments: listEnabledInstruments(1), policy: TWELVE_BASIC_POLICY, interval: "15min", requestedPollIntervalMs: 900_000 });
  assert.equal(rollout1.quoteCredits, 546); assert.equal(rollout1.dailyCredits, 7); assert.equal(rollout1.intradayCredits, 42); assert.equal(rollout1.combinedCredits, 595); assert.equal(rollout1.effectivePollIntervalMs, 4_500_000);
  const rollout3 = projectCombinedIntradayBudget({ instruments: listEnabledInstruments(3), policy: TWELVE_BASIC_POLICY, interval: "15min", requestedPollIntervalMs: 900_000 });
  assert.equal(rollout3.combinedCredits, 598); assert.equal(rollout3.intradayCredits, 0); assert.equal(rollout3.effectivePollIntervalMs, null);
});

test("intraday ingestion queries only hot instruments and retains an open candle by key", async () => {
  const originalFetch = globalThis.fetch; let requestedUrl = "";
  globalThis.fetch = async (input) => { requestedUrl = String(input); const payload = Object.fromEntries(listEnabledInstruments(1).map((instrument) => [instrument.providerSymbols.twelve, { meta: { symbol: instrument.providerSymbols.twelve, currency: "USD" }, values: [{ datetime: "2026-07-13 11:00:00", open: "101", high: "103", low: "100", close: "102", volume: "10" }, { datetime: "2026-07-13 11:00:00", open: "101", high: "104", low: "100", close: "103", volume: "11" }, { datetime: "2026-07-13 10:30:00", open: "100", high: "102", low: "99", close: "101", volume: "20" }] }])); return new Response(JSON.stringify(payload), { status: 200 }); };
  try {
    const scheduler = new MarketCreditScheduler({ now: () => nowMs }); const store = new DailyCandleStore({ rootDir: mkdtempSync(join(tmpdir(), "intraday-hot-")), rolloutBatch: 3, intervals: ["15min"] }); await store.hydrate(); const service = new IntradayCandleService({ store, marketConfig: config(scheduler), now: () => new Date(nowMs) });
    const result = await service.runScheduled(); assert.equal(result.status, "ok"); assert.match(requestedUrl, /interval=15min/); assert.doesNotMatch(requestedUrl, /LDOS|HII|XLE|BTC/); assert.equal(scheduler.snapshot().consumedDay, 7); assert.equal(store.query({ instrumentId: gd.instrumentId, interval: "15min" }).length, 1); assert.equal(service.openCandles.size, 7); assert.equal(result.metrics.candlesStored, 7); assert.equal(result.metrics.intradayCredits, 7);
  } finally { globalThis.fetch = originalFetch; }
});

test("normal and background instruments never consume intraday credits", () => {
  const hotIds = new Set(listEnabledInstruments(3).filter((item) => item.refreshTier === "hot").map((item) => item.instrumentId)); assert.equal(hotIds.size, 7); assert.equal(hotIds.has("us-equity-leidos"), false); assert.equal(hotIds.has("crypto-bitcoin-us-dollar"), false);
});

test("closed equity session defers without HTTP while crypto session remains eligible 24/7", async () => {
  const originalFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls += 1; throw new Error("must-not-call"); };
  try { const saturday = Date.parse("2026-07-11T15:00:00Z"); const scheduler = new MarketCreditScheduler({ now: () => saturday }); const store = new DailyCandleStore({ rootDir: mkdtempSync(join(tmpdir(), "intraday-closed-")), intervals: ["15min"] }); await store.hydrate(); const service = new IntradayCandleService({ store, marketConfig: { ...config(scheduler), watchlistRollout: 1, tickers: listEnabledInstruments(1).map((item) => item.canonicalSymbol) }, now: () => new Date(saturday) }); assert.equal((await service.runScheduled()).status, "market-closed"); assert.equal(calls, 0); assert.equal(isInstrumentSessionEligible({ assetType: "crypto", sessionPolicy: "24x7" }, new Date(saturday)), true); }
  finally { globalThis.fetch = originalFetch; }
});

test("open candles are not persisted, closed candles deduplicate and intervals stay independent after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "intraday-store-")); const store = new DailyCandleStore({ rootDir: root, intervals: ["15min"] }); await store.hydrate();
  const candle = normalizeCanonicalCandle({ instrumentId: gd.instrumentId, interval: "15min", datetime: "2026-07-13 10:30:00", open: 100, high: 102, low: 99, close: 101, currency: "USD" }, { instrument: gd, fetchedAt: "2026-07-13T15:00:00Z", source: "twelve", providerSymbol: "GD" }).candle;
  assert.equal((await store.append([{ ...candle, closeTime: "2026-07-13T15:30:00Z" }], { now: new Date(nowMs) })).rejectedOpen, 1); assert.equal((await store.append([candle], { now: new Date(nowMs) })).inserted, 1); assert.equal((await store.append([candle], { now: new Date(nowMs) })).duplicates, 1); assert.equal(store.query({ instrumentId: gd.instrumentId, interval: "1day" }).length, 0);
  const restarted = new DailyCandleStore({ rootDir: root, intervals: ["15min"] }); await restarted.hydrate(); assert.equal(restarted.query({ instrumentId: gd.instrumentId, interval: "15min" }).length, 1);
});

test("quota exhaustion defers intraday before HTTP and exposes stale metadata", async () => {
  const originalFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls += 1; throw new Error("must-not-call"); };
  try { const scheduler = new MarketCreditScheduler({ now: () => nowMs }); scheduler.state.consumedDay = 600; const store = new DailyCandleStore({ rootDir: mkdtempSync(join(tmpdir(), "intraday-quota-")), intervals: ["15min"] }); await store.hydrate(); const service = new IntradayCandleService({ store, marketConfig: { ...config(scheduler), watchlistRollout: 1, tickers: listEnabledInstruments(1).map((item) => item.canonicalSymbol) }, now: () => new Date(nowMs) }); const result = await service.runScheduled(); assert.equal(result.status, "deferred-quota"); assert.equal(calls, 0); assert.ok(result.metrics.deferredByQuota >= 7); }
  finally { globalThis.fetch = originalFetch; }
});

test("partial intraday response persists valid instruments without discarding the batch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    GD: { meta: { symbol: "GD", currency: "USD" }, values: [{ datetime: "2026-07-13 10:30:00", open: "100", high: "102", low: "99", close: "101" }] },
  }), { status: 200 });
  try {
    const scheduler = new MarketCreditScheduler({ now: () => nowMs });
    const store = new DailyCandleStore({ rootDir: mkdtempSync(join(tmpdir(), "intraday-partial-")), rolloutBatch: 1, intervals: ["15min"] });
    await store.hydrate();
    const service = new IntradayCandleService({ store, marketConfig: { ...config(scheduler), watchlistRollout: 1, tickers: listEnabledInstruments(1).map((item) => item.canonicalSymbol) }, now: () => new Date(nowMs) });
    const result = await service.runScheduled();
    assert.equal(result.status, "partial");
    assert.equal(result.metrics.candlesStored, 1);
    assert.equal(store.query({ instrumentId: gd.instrumentId, interval: "15min" }).length, 1);
    assert.equal(scheduler.snapshot().consumedDay, 7);
  } finally { globalThis.fetch = originalFetch; }
});
