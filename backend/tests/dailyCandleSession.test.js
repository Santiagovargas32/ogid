import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DailyCandleStore } from "../services/market/dailyCandleStore.js";
import { normalizeCanonicalCandle } from "../services/market/canonicalCandle.js";
import { getInstrumentByCanonicalSymbol, registerInstrument } from "../services/market/instrumentRegistry.js";
import { tradingDay } from "../services/market/exchangeCalendar.js";
import { TechnicalContextService } from "../services/market/technicalContextService.js";

const instrument = registerInstrument({ ...getInstrumentByCanonicalSymbol("GD"),
  instrumentId: "test-europe-session", canonicalSymbol: "TESTSESSION.DE", aliases: ["TESTSESSION.DE"],
  providerSymbols: { yahoo: "TESTSESSION.DE" }, exchange: "XETRA", mic: "XETR",
  timezone: "Europe/Berlin", currency: "EUR", sessionPolicy: "exchange-hours" });
const now = new Date("2026-10-08T18:00:00Z");
const bar = (date) => normalizeCanonicalCandle({ instrumentId: instrument.instrumentId, interval: "1day",
  date, open: 100, high: 110, low: 90, close: 105, volume: 100, currency: "EUR" },
  { instrument, source: "yahoo", fetchedAt: "2026-10-08T17:00:00.000Z" }).candle;
const legacy = (candle) => ({ ...candle,
  openTime: new Date(Date.parse(candle.openTime) + 30 * 60000).toISOString(),
  closeTime: new Date(Date.parse(candle.closeTime) - 90 * 60000).toISOString(),
  calendar: null, fetchedAt: "2026-10-08T16:00:00.000Z" });
const store = () => new DailyCandleStore({ rootDir: mkdtempSync(join(tmpdir(), "daily-session-")) });

test("daily upsert corrects session hours once, retaining the previous observation across restart", async () => {
  const first = store(), canonical = bar("2026-10-07"), old = legacy(canonical);
  await first.append([old], { now });
  assert.deepEqual(await first.upsert([canonical], { now }), { inserted: 0, updated: 1, duplicates: 0, rejectedOpen: 0 });
  assert.equal(first.has(instrument.instrumentId, canonical.openTime), true);
  assert.equal(first.query({ instrumentId: instrument.instrumentId }).length, 1);
  const corrected = first.latest(instrument.instrumentId);
  assert.equal(corrected.openTime, canonical.openTime);
  assert.equal(corrected.closeTime, canonical.closeTime);
  assert.equal(corrected.revisions.at(-1).openTime, old.openTime);
  assert.equal(corrected.revisions.at(-1).closeTime, old.closeTime);
  assert.equal((await first.append([old], { now })).duplicates, 1);
  const restarted = new DailyCandleStore({ rootDir: first.rootDir });
  assert.equal(restarted.latest(instrument.instrumentId).revision, 2);
  assert.equal(restarted.query({ instrumentId: instrument.instrumentId }).length, 1);
  const unadjusted = { ...canonical, adjusted: false, provenance: { ...canonical.provenance, adjustmentMode: "none" } };
  assert.equal((await restarted.append([unadjusted], { now })).inserted, 1);
});

test("hydration collapses legacy duplicate sessions before computing SMA200 and persists the audit on upsert", async () => {
  const first = store(), bars = [];
  for (let time = Date.parse("2025-01-02T12:00:00Z"); bars.length < 199; time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    if (!tradingDay(instrument, date).closed) bars.push(bar(date));
  }
  // Put an older, incorrect observation last: file order must not decide which hours win.
  const old = legacy(bars.at(-1));
  const target = first.seriesPath(instrument.instrumentId);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, [...bars, old].map(c => JSON.stringify(c)).join("\n") + "\n");
  const technical = new TechnicalContextService({ store: first, now: () => now });
  const before = technical.get({ instrumentId: instrument.instrumentId });
  assert.equal(before.sampleSize, 199);
  assert.equal(before.warmup.complete, false);
  assert.equal(before.indicators.sma200.value, null);
  assert.equal(first.latest(instrument.instrumentId).openTime, bars.at(-1).openTime);
  assert.equal(first.latest(instrument.instrumentId).revisions.at(-1).openTime, old.openTime);
  await first.upsert([bars.at(-1)], { now });
  const persisted = readFileSync(target, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(persisted.length, 199);
  assert.equal(persisted.at(-1).revisions.at(-1).openTime, old.openTime);
  const restarted = new DailyCandleStore({ rootDir: first.rootDir });
  let date = new Date(Date.parse(bars.at(-1).openTime) + 86400000).toISOString().slice(0, 10);
  while (tradingDay(instrument, date).closed) date = new Date(Date.parse(date + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
  await restarted.upsert([bar(date)], { now });
  const after = new TechnicalContextService({ store: restarted, now: () => now }).get({ instrumentId: instrument.instrumentId });
  assert.equal(after.sampleSize, 200);
  assert.equal(after.indicators.sma200.value, 105);
});

test("intraday bars in one session retain separate opening identities", async () => {
  const first = store(), canonical = bar("2026-10-07");
  const early = { ...canonical, interval: "30min", closeTime: new Date(Date.parse(canonical.openTime) + 1800000).toISOString() };
  const later = { ...early, openTime: early.closeTime, closeTime: new Date(Date.parse(early.closeTime) + 1800000).toISOString() };
  assert.equal((await first.upsert([early, later], { now })).inserted, 2);
  const restarted = new DailyCandleStore({ rootDir: first.rootDir });
  assert.equal(restarted.query({ instrumentId: instrument.instrumentId, interval: "30min" }).length, 2);
  assert.equal(restarted.hasCandle(instrument.instrumentId, "30min", later.openTime), true);
});

test("one upsert handles unordered inserts and a repeated session without changing another day's price", async () => {
  const first = store(), earlier = bar("2026-10-06"), middle = bar("2026-10-07"), latest = bar("2026-10-08");
  const revised = { ...middle, close: 106 };
  const result = await first.upsert([middle, earlier, revised, latest], { now });
  assert.deepEqual(result, { inserted: 3, updated: 1, duplicates: 0, rejectedOpen: 0 });
  const records = first.query({ instrumentId: instrument.instrumentId });
  assert.deepEqual(records.map(c => c.openTime), [earlier.openTime, middle.openTime, latest.openTime]);
  assert.deepEqual(records.map(c => c.close), [105, 106, 105]);
  assert.equal(first.has(instrument.instrumentId, "invalid"), false);
});
