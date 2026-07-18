import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candleIdentity, normalizeCanonicalCandle, resolveDailyCandleTimes } from "../services/market/canonicalCandle.js";
import { DailyCandleStore } from "../services/market/dailyCandleStore.js";
import { DailyCandleService, resolveExpectedClosedDailyCandle } from "../services/market/dailyCandleService.js";
import { getInstrumentById } from "../services/market/instrumentRegistry.js";
import { MarketCreditScheduler } from "../services/market/marketCreditScheduler.js";
import { fetchDailyCandles } from "../services/market/marketProviderRouter.js";
import { sensitiveRouteAuth } from "../middleware/sensitiveRouteAuth.js";
import { getCandles } from "../controllers/marketController.js";

const gd = getInstrumentById("us-equity-general-dynamics");
const raw = { instrumentId: gd.instrumentId, interval: "1day", date: "2026-07-10", datetime: "2026-07-10", open: "100", high: "110", low: "90", close: "105", volume: "1000", currency: "USD", source: "twelve", providerSymbol: "GD", dataMode: "observed" };

test("daily OHLC normalization creates UTC canonical identity and provenance", () => {
  const result = normalizeCanonicalCandle(raw, { instrument: gd, fetchedAt: "2026-07-11T00:00:00Z", source: "twelve", providerSymbol: "GD", adjustmentMode: "splits" });
  assert.equal(result.valid, true); assert.equal(result.candle.openTime, "2026-07-10T13:30:00.000Z"); assert.equal(result.candle.closeTime, "2026-07-10T20:00:00.000Z"); assert.equal(result.candle.adjusted, true); assert.equal(result.candle.methodVersion, "daily-candle-v1"); assert.equal(candleIdentity(result.candle), `${gd.instrumentId}|1day|2026-07-10T13:30:00.000Z`);
});

test("invalid high low timestamps currency instruments and finite values are rejected", () => {
  assert.ok(normalizeCanonicalCandle({ ...raw, high: 99 }, { instrument: gd }).errors.includes("high-invalid"));
  assert.ok(normalizeCanonicalCandle({ ...raw, low: 106 }, { instrument: gd }).errors.includes("low-invalid"));
  assert.ok(normalizeCanonicalCandle({ ...raw, date: "bad" }, { instrument: gd }).errors.includes("timestamp-invalid"));
  assert.ok(normalizeCanonicalCandle({ ...raw, currency: "EUR" }, { instrument: gd }).errors.includes("currency-mismatch"));
  assert.ok(normalizeCanonicalCandle({ ...raw, instrumentId: "unknown" }, { instrument: null }).errors.includes("instrument-not-verified"));
  assert.ok(normalizeCanonicalCandle({ ...raw, open: "NaN" }, { instrument: gd }).errors.includes("values-not-finite"));
});

test("equity and crypto daily closures use their own sessions", () => {
  const btc = getInstrumentById("crypto-bitcoin-us-dollar");
  assert.equal(resolveExpectedClosedDailyCandle(gd, new Date("2026-07-10T19:59:00Z")).closeTime, "2026-07-09T20:00:00.000Z");
  assert.equal(resolveExpectedClosedDailyCandle(gd, new Date("2026-07-10T20:16:00Z")).closeTime, "2026-07-10T20:00:00.000Z");
  assert.equal(resolveDailyCandleTimes("2026-07-10", btc).closeTime, "2026-07-11T00:00:00.000Z");
  assert.equal(resolveExpectedClosedDailyCandle(btc, new Date("2026-07-11T00:04:00Z")), null);
  assert.equal(resolveExpectedClosedDailyCandle(btc, new Date("2026-07-11T00:05:00Z")).openTime, "2026-07-10T00:00:00.000Z");
});

test("candle store is append-only, idempotent across restart, and separates adjustments from legacy quotes", async () => {
  const root = mkdtempSync(join(tmpdir(), "daily-candles-")); const candle = normalizeCanonicalCandle(raw, { instrument: gd, fetchedAt: "2026-07-11T00:00:00Z", source: "twelve", providerSymbol: "GD", adjustmentMode: "splits" }).candle;
  const first = new DailyCandleStore({ rootDir: root }); await first.hydrate(); assert.equal((await first.append([candle], { now: new Date("2026-07-11T00:00:00Z") })).inserted, 1); assert.equal((await first.append([candle], { now: new Date("2026-07-11T00:00:00Z") })).duplicates, 1);
  const openCandle = { ...candle, openTime: "2026-07-11T13:30:00.000Z", closeTime: "2026-07-11T20:00:00.000Z" }; assert.equal((await first.append([openCandle], { now: new Date("2026-07-11T19:00:00Z") })).rejectedOpen, 1);
  const second = new DailyCandleStore({ rootDir: root }); await second.hydrate(); assert.equal(second.query({ instrumentId: gd.instrumentId, adjustmentMode: "splits" }).length, 1); assert.equal(second.query({ instrumentId: gd.instrumentId, adjustmentMode: "none" }).length, 0);
  const unadjusted = normalizeCanonicalCandle(raw, { instrument: gd, fetchedAt: "2026-07-11T00:00:00Z", source: "twelve", providerSymbol: "GD", adjustmentMode: "none" }).candle; assert.equal((await second.append([unadjusted], { now: new Date("2026-07-11T00:00:00Z") })).inserted, 1); assert.equal(second.query({ instrumentId: gd.instrumentId, adjustmentMode: "none" }).length, 1);
  mkdirSync(join(root, "history"), { recursive: true }); writeFileSync(join(root, "history", "GD.jsonl"), JSON.stringify({ timestamp: "2026-07-10T12:00:00Z", price: 100 })); const third = new DailyCandleStore({ rootDir: root }); await third.hydrate(); assert.equal(third.query({ instrumentId: gd.instrumentId }).length, 1);
});

test("lazy upsert preserves prior disk history and serializes concurrent revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "daily-upsert-restart-"));
  const first = new DailyCandleStore({ rootDir: root });
  const firstCandle = normalizeCanonicalCandle(raw, { instrument: gd, fetchedAt: "2026-07-11T00:00:00Z", source: "yahoo", providerSymbol: "GD", adjustmentMode: "splits" }).candle;
  const secondCandle = normalizeCanonicalCandle({ ...raw, date: "2026-07-11", datetime: "2026-07-11", close: "106" }, { instrument: gd, fetchedAt: "2026-07-12T00:00:00Z", source: "yahoo", providerSymbol: "GD", adjustmentMode: "splits" }).candle;
  await first.append([firstCandle], { now: new Date("2026-07-12T00:00:00Z") });

  const restarted = new DailyCandleStore({ rootDir: root });
  await Promise.all([
    restarted.hydrate(),
    restarted.upsert([secondCandle], { now: new Date("2026-07-12T00:00:00Z") })
  ]);
  assert.equal(restarted.query({ instrumentId: gd.instrumentId, interval: "1day" }).length, 2);

  const revisionA = { ...secondCandle, high: 112, close: 107, fetchedAt: "2026-07-12T01:00:00.000Z" };
  const revisionB = { ...secondCandle, high: 113, close: 108, fetchedAt: "2026-07-12T02:00:00.000Z" };
  await Promise.all([
    restarted.upsert([revisionA], { now: new Date("2026-07-12T03:00:00Z") }),
    restarted.upsert([revisionB], { now: new Date("2026-07-12T03:00:00Z") })
  ]);
  const reloaded = new DailyCandleStore({ rootDir: root });
  assert.equal(reloaded.query({ instrumentId: gd.instrumentId, interval: "1day" }).length, 2);
  assert.equal(reloaded.latest(gd.instrumentId).close, 108);
});

test("daily router maps instrumentId to provider symbol, leases each symbol and keeps partial responses", async () => {
  const originalFetch = globalThis.fetch; let url = ""; const now = Date.parse("2026-07-11T00:00:00Z");
  globalThis.fetch = async (input) => { url = String(input); return new Response(JSON.stringify({ GD: { meta: { symbol: "GD", currency: "USD" }, values: [{ datetime: "2026-07-10", open: "100", high: "110", low: "90", close: "105", volume: "10" }] } }), { status: 200 }); };
  try { const scheduler = new MarketCreditScheduler({ now: () => now }); const result = await fetchDailyCandles({ provider: "twelve", twelveBaseUrl: "https://api.twelvedata.com", twelveApiKey: "test", instrumentIds: [gd.instrumentId, "us-equity-boeing"], creditScheduler: scheduler, timestamp: new Date(now).toISOString() }); assert.match(url, /symbol=GD%2CBA/); assert.equal(result.candles.length, 1); assert.ok(result.errors.some((error) => error.code === "daily-symbol-missing")); assert.equal(scheduler.snapshot().consumedDay, 2); }
  finally { globalThis.fetch = originalFetch; }
});

test("quota exhaustion rejects daily download before HTTP", async () => {
  let calls = 0; const originalFetch = globalThis.fetch; globalThis.fetch = async () => { calls += 1; throw new Error("must-not-call"); };
  try { const scheduler = new MarketCreditScheduler(); scheduler.state.consumedDay = 600; const result = await fetchDailyCandles({ provider: "twelve", twelveApiKey: "test", instrumentIds: [gd.instrumentId], creditScheduler: scheduler }); assert.equal(calls, 0); assert.equal(result.creditRejections.length, 1); }
  finally { globalThis.fetch = originalFetch; }
});

test("backfill mutation is denied remotely without authentication", () => {
  let status = null; const req = { path: "/api/market/candles/backfill", method: "POST", headers: {}, query: {}, socket: { remoteAddress: "203.0.113.5" } }; const res = { app: { locals: { config: { security: { allowLocalAdmin: false, adminApiToken: "secret" } } } }, status(code) { status = code; return this; }, json() { return this; } };
  sensitiveRouteAuth(req, res, () => { throw new Error("must-not-authorize"); }); assert.equal(status, 401);
});

test("explicit backfill is bounded and remains subject to quota", async () => {
  const scheduler = new MarketCreditScheduler(); scheduler.state.consumedDay = 600; const root = mkdtempSync(join(tmpdir(), "daily-backfill-")); const store = new DailyCandleStore({ rootDir: root }); await store.hydrate();
  const service = new DailyCandleService({ store, marketConfig: { provider: "twelve", twelveApiKey: "test", tickers: [gd.canonicalSymbol], watchlistRollout: 1, creditScheduler: scheduler, dailyCandles: { backfillMaxDays: 30, adjustmentMode: "splits" } } });
  const result = await service.backfill({ instrumentIds: [gd.instrumentId], days: 999 }); assert.equal(result.days, 30); assert.equal(result.creditRejections.length, 1); assert.equal(result.inserted, 0);
});

test("bounded candle API queries by instrumentId without exposing legacy history", async () => {
  const root = mkdtempSync(join(tmpdir(), "daily-api-")); const store = new DailyCandleStore({ rootDir: root }); await store.hydrate(); const candle = normalizeCanonicalCandle(raw, { instrument: gd, fetchedAt: "2026-07-11T00:00:00Z", source: "twelve", providerSymbol: "GD", adjustmentMode: "splits" }).candle; await store.append([candle], { now: new Date("2026-07-11T00:00:00Z") });
  let payload = null; const req = { query: { instrumentId: gd.instrumentId, interval: "1day", limit: "100", adjusted: "splits" } }; const res = { app: { locals: { config: { market: { provider: "twelve" } }, dailyCandleService: { query: (options) => store.query(options) } } }, status() { return this; }, json(value) { payload = value; return this; } };
  await getCandles(req, res, (error) => { throw error; }); assert.equal(payload.ok, true); assert.equal(payload.data.candles.length, 1); assert.equal(payload.data.candles[0].instrumentId, gd.instrumentId); assert.equal(payload.data.candles[0].price, undefined);
});
