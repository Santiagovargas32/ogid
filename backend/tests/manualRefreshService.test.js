import test from "node:test";
import assert from "node:assert/strict";
import ManualRefreshService from "../services/manualRefreshService.js";

async function flushAsyncTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("manual refresh service accepts request and blocks concurrent in-flight runs", async () => {
  let resolveRefresh = null;
  const calls = [];
  const orchestrator = {
    runManualRefresh: async (payload) =>
      new Promise((resolve) => {
        calls.push(payload);
        resolveRefresh = resolve;
      })
  };

  const service = new ManualRefreshService({
    orchestrator,
    cooldownMs: 120_000,
    perClientWindowMs: 900_000,
    perClientMax: 3
  });

  const accepted = service.request({
    clientId: "client-a",
    countries: ["US", "IL"],
    reason: "manual"
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.httpStatus, 202);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].countries, ["US", "IL"]);

  const inFlight = service.request({
    clientId: "client-a",
    countries: ["US"]
  });
  assert.equal(inFlight.accepted, false);
  assert.equal(inFlight.httpStatus, 409);

  resolveRefresh();
  await Promise.resolve();
});

test("manual refresh service enforces per-client window limit", async () => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;

  const orchestrator = {
    runManualRefresh: async () => {}
  };
  const service = new ManualRefreshService({
    orchestrator,
    cooldownMs: 1,
    perClientWindowMs: 1_000,
    perClientMax: 2
  });

  try {
    const first = service.request({ clientId: "client-a" });
    assert.equal(first.accepted, true);
    await flushAsyncTasks();

    now += 2;
    const second = service.request({ clientId: "client-a" });
    assert.equal(second.accepted, true);
    await flushAsyncTasks();

    now += 2;
    const blockedByClientWindow = service.request({ clientId: "client-a" });
    assert.equal(blockedByClientWindow.accepted, false);
    assert.equal(blockedByClientWindow.httpStatus, 429);
    assert.equal(blockedByClientWindow.code, "REFRESH_CLIENT_RATE_LIMIT");
  } finally {
    Date.now = originalNow;
  }
});

test("manual refresh service enforces global cooldown", async () => {
  const originalNow = Date.now;
  let now = 1_700_000_500_000;
  Date.now = () => now;

  const service = new ManualRefreshService({
    orchestrator: {
      runManualRefresh: async () => {}
    },
    cooldownMs: 1_000,
    perClientWindowMs: 60_000,
    perClientMax: 10
  });

  try {
    const first = service.request({ clientId: "client-a" });
    assert.equal(first.accepted, true);
    await flushAsyncTasks();

    const blocked = service.request({ clientId: "client-b" });
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.httpStatus, 429);
    assert.equal(blocked.code, "REFRESH_COOLDOWN");

    now += 1_001;
    const acceptedAfterCooldown = service.request({ clientId: "client-b" });
    assert.equal(acceptedAfterCooldown.accepted, true);
  } finally {
    Date.now = originalNow;
  }
});
