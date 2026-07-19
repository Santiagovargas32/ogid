import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, getRecentLogs } from "../utils/logger.js";

test("logger preserves envelope fields and retains a colliding context message as errorMessage", () => {
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const logger = createLogger("backend/services/testService");
    logger.warn("dashboard_map_assets_refresh_failed", {
      timestamp: "invalid-context-timestamp",
      level: "info",
      scope: "overridden-scope",
      message: "Invalid time value"
    });

    const entry = getRecentLogs({ limit: 1 }).at(-1);
    assert.equal(entry.level, "warn");
    assert.equal(entry.scope, "backend/services/testService");
    assert.equal(entry.message, "dashboard_map_assets_refresh_failed");
    assert.equal(entry.errorMessage, "Invalid time value");
    assert.equal(Number.isFinite(Date.parse(entry.timestamp)), true);
  } finally {
    console.warn = originalWarn;
  }
});
