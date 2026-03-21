import test from "node:test";
import assert from "node:assert/strict";
import { isMarketOpenEt, resolveMarketIntervalMs } from "../services/market/marketSessionService.js";

test("isMarketOpenEt returns true during NYSE open hours", () => {
  const mondayOpen = new Date("2026-03-02T15:00:00.000Z"); // 10:00 ET Monday
  assert.equal(isMarketOpenEt(mondayOpen), true);
});

test("isMarketOpenEt returns false outside session", () => {
  const sunday = new Date("2026-03-01T15:00:00.000Z"); // Sunday
  const mondayAfterClose = new Date("2026-03-02T22:30:00.000Z"); // 17:30 ET Monday
  assert.equal(isMarketOpenEt(sunday), false);
  assert.equal(isMarketOpenEt(mondayAfterClose), false);
});

test("resolveMarketIntervalMs uses the configured active interval during open session", () => {
  const interval = resolveMarketIntervalMs({
    now: new Date("2026-03-02T15:00:00.000Z"),
    activeIntervalMs: 120_000,
    offHoursIntervalMs: 900_000,
    quotaRemaining: 500
  });

  assert.equal(interval, 120_000);
});

test("resolveMarketIntervalMs honors explicit quota band interval mapping", () => {
  const interval = resolveMarketIntervalMs({
    now: new Date("2026-03-02T15:00:00.000Z"),
    quotaBand: "RED",
    bandIntervals: {
      RED: {
        activeIntervalMs: 600_000,
        offHoursIntervalMs: 3_600_000
      }
    },
    activeIntervalMs: 120_000,
    offHoursIntervalMs: 900_000
  });

  assert.equal(interval, 600_000);
});

test("resolveMarketIntervalMs uses the configured closed-session interval", () => {
  const interval = resolveMarketIntervalMs({
    now: new Date("2026-03-01T15:00:00.000Z"), // Sunday
    activeIntervalMs: 120_000,
    offHoursIntervalMs: 600_000
  });

  assert.equal(interval, 600_000);
});
