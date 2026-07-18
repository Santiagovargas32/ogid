import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calculateMinimumSafeIntervalMs, calculateTwelveCost, isInstrumentSessionEligible, MarketCreditScheduler, projectDailyCredits } from "../services/market/marketCreditScheduler.js";
import { listEnabledInstruments } from "../services/market/instrumentRegistry.js";

const monday = Date.parse("2026-07-13T15:00:00Z");
const instrument = (id, tier = "normal", extras = {}) => ({ instrumentId: id, refreshTier: tier, assetType: "equity", sessionPolicy: "nyse-equities", ...extras });

test("seven quote symbols cost and lease exactly seven credits", () => {
  const scheduler = new MarketCreditScheduler({ now: () => monday });
  const lease = scheduler.acquireLease({ symbols: ["A","B","C","D","E","F","G"], nowMs: monday });
  assert.equal(calculateTwelveCost(7), 7); assert.equal(lease.accepted, true); assert.equal(lease.lease.cost, 7); assert.equal(scheduler.snapshot().consumedMinute, 7);
});

test("large groups are split across successive minute windows", () => {
  const scheduler = new MarketCreditScheduler({ now: () => monday });
  const plan = scheduler.plan({ instruments: Array.from({ length: 10 }, (_, index) => instrument(`i${index}`)), trigger: "interval-market", nowMs: monday });
  assert.deepEqual(plan.batches.map((batch) => batch.predictedCredits), [7, 3]); assert.equal(new Date(plan.batches[1].scheduledAt).getTime() - new Date(plan.batches[0].scheduledAt).getTime(), 60_000);
});

test("absolute minute limit is never exceeded", () => {
  const scheduler = new MarketCreditScheduler({ now: () => monday });
  assert.equal(scheduler.acquireLease({ symbols: Array(8).fill("X"), tier: "hot", trigger: "manual-market", nowMs: monday }).accepted, true);
  assert.equal(scheduler.acquireLease({ symbols: ["Y"], tier: "hot", trigger: "manual-market", nowMs: monday }).accepted, false);
});

test("soft limit degrades background before normal and preserves hot", () => {
  const scheduler = new MarketCreditScheduler({ now: () => monday }); scheduler.state.consumedDay = 598;
  const plan = scheduler.plan({ instruments: [instrument("background", "background"), instrument("normal"), instrument("hot", "hot")], trigger: "interval-market", nowMs: monday });
  assert.deepEqual(plan.batches.flatMap((batch) => batch.instruments.map((item) => item.instrumentId)), ["hot", "normal"]); assert.equal(plan.omitted[0].instrumentId, "background");
});

test("hard limit blocks even manual refresh and normal cannot consume reserve", () => {
  const scheduler = new MarketCreditScheduler({ now: () => monday }); scheduler.state.consumedDay = 599;
  assert.equal(scheduler.acquireLease({ symbols: ["A", "B"], trigger: "interval-market", nowMs: monday }).reason, "daily-budget-exhausted");
  scheduler.state.consumedDay = 699;
  assert.equal(scheduler.acquireLease({ symbols: ["A", "B"], tier: "hot", trigger: "manual-market", nowMs: monday }).reason, "daily-budget-exhausted");
});

test("persistent consumption survives restart and UTC day rollover resets it", () => {
  let now = monday; const file = join(mkdtempSync(join(tmpdir(), "market-credit-")), "state.json");
  const first = new MarketCreditScheduler({ now: () => now, persistencePath: file }); first.acquireLease({ symbols: ["A", "B"], nowMs: now });
  const second = new MarketCreditScheduler({ now: () => now, persistencePath: file }); assert.equal(second.snapshot().consumedDay, 2);
  now = Date.parse("2026-07-14T00:00:01Z"); assert.equal(second.snapshot().consumedDay, 0);
});

test("equity respects market session while crypto remains 24/7", () => {
  const saturday = new Date("2026-07-11T15:00:00Z");
  assert.equal(isInstrumentSessionEligible(instrument("equity"), saturday), false);
  assert.equal(isInstrumentSessionEligible(instrument("btc", "hot", { assetType: "crypto", sessionPolicy: "24x7" }), saturday), true);
});

test("Retry-After blocks new leases until the indicated time", () => {
  let now = monday; const scheduler = new MarketCreditScheduler({ now: () => now });
  const lease = scheduler.acquireLease({ symbols: ["A"], nowMs: now }); scheduler.commitLease(lease.lease.leaseId, { status: "rate-limited", headers: { "retry-after": "5" } });
  const blocked = scheduler.acquireLease({ symbols: ["B"], nowMs: now }); assert.equal(blocked.reason, "retry-after"); assert.equal(new Date(blocked.nextEligibleAt).getTime(), now + 5_000);
  now += 5_001; assert.equal(scheduler.acquireLease({ symbols: ["B"], nowMs: now }).accepted, true);
});

test("current seven-symbol cadence is raised to the safe five-minute floor", () => {
  assert.equal(calculateMinimumSafeIntervalMs({ symbolCount: 7, sessionMinutes: 390, dailyBudget: 600 }), 300_000);
});

test("full verified rollout projects 580 scheduled quote credits per day", () => {
  const projection = projectDailyCredits(listEnabledInstruments(3));
  assert.equal(projection.scheduledCredits, 580);
  assert.ok(projection.scheduledCredits <= projection.softLimit);
  assert.equal(projection.hardLimit - projection.softLimit, projection.reservedCapacity);
});

test("per-instrument cadence survives planning and manual refresh bypasses it", () => {
  let now = monday; const scheduler = new MarketCreditScheduler({ now: () => now });
  const slow = instrument("slow", "background", { minRefreshIntervalMs: 3_600_000 });
  const lease = scheduler.acquireLease({ symbols: ["SLOW"], instrumentIds: [slow.instrumentId], nowMs: now });
  assert.equal(lease.accepted, true);
  now += 300_000;
  const scheduled = scheduler.plan({ instruments: [slow], trigger: "interval-market", nowMs: now });
  assert.equal(scheduled.batches.length, 0); assert.equal(scheduled.omitted[0].reason, "cadence");
  assert.equal(scheduler.plan({ instruments: [slow], trigger: "manual-market", nowMs: now }).batches.length, 1);
});
