import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, getRecentLogs } from "../utils/logger.js";
import { errorHandler } from "../utils/error.js";

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


test("request failures log the storage cause and command without adding internal diagnostics to HTTP",t=>{
  t.mock.method(console,"error",()=>{});
  let response;
  const reason=Object.assign(new Error("STORAGE_WORKER_FAILED"),{statusCode:503,code:"STORAGE_WORKER_FAILED",causeCode:"STORAGE_DISPATCH_TIMEOUT",diagnostic:{operation:"snapshot.prepare",phase:"dispatched"}});
  errorHandler(reason,{requestId:"fixture",method:"GET",originalUrl:"/api/intel/advanced-snapshot"},{status(){return this;},json(value){response=value;}});
  const entry=getRecentLogs({limit:1}).at(-1);
  assert.equal(entry.causeCode,"STORAGE_DISPATCH_TIMEOUT");assert.deepEqual(entry.command,reason.diagnostic);
  assert.equal(response.error.code,"STORAGE_WORKER_FAILED");assert.equal(response.error.causeCode,undefined);assert.equal(response.error.command,undefined);
});
