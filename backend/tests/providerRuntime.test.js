import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiQuotaTrackerService } from "../services/admin/apiQuotaTrackerService.js";
import { ProviderErrorCode, parseRetryAfter } from "../services/providers/providerErrors.js";
import { getProviderPolicy } from "../services/providers/providerPolicies.js";
import { ProviderRuntime } from "../services/providers/providerRuntime.js";

const ok = (status = 200, headers = {}) => new Response("{}", { status, headers });
const unlimitedQuota = { getProviderSnapshot: () => ({ exhausted: false }) };

test("provider policies distinguish declared, internal and unknown limits", () => {
  assert.equal(getProviderPolicy("newsapi").declaredLimit.day, 100);
  assert.equal(getProviderPolicy("gnews").constraints.maxPageSize, 10);
  assert.equal(getProviderPolicy("mediastack").quotaPeriod, "month");
  assert.deepEqual(getProviderPolicy("twelve").declaredLimit, { minute: 8, day: 800 });
  assert.equal(getProviderPolicy("youtube-search").internalBudget.hard.day, 60);
  for (const provider of ["rss", "gdelt", "yahoo", "carto"]) assert.equal(getProviderPolicy(provider).declaredLimit, null);
});

test("Retry-After supports seconds and HTTP dates with a simulated clock", () => {
  const now = Date.parse("2026-07-11T12:00:00Z");
  assert.equal(parseRetryAfter("3", now), 3_000);
  assert.equal(parseRetryAfter("Sat, 11 Jul 2026 12:00:05 GMT", now), 5_000);
});

test("429 and 5xx retry idempotent calls using Retry-After, backoff and jitter", async () => {
  let now = 1_000; const waits = []; let calls = 0;
  const runtime = new ProviderRuntime({ now: () => now, random: () => 0.5, sleep: async (ms) => { waits.push(ms); now += ms; }, fetchImpl: async () => ++calls === 1 ? ok(429, { "Retry-After": "2" }) : calls === 2 ? ok(503) : ok() });
  const response = await runtime.fetch("test", "https://example.test/data", { retries: 2, quotaTracker: unlimitedQuota });
  assert.equal(response.status, 200); assert.deepEqual(waits, [2_000, 500]); assert.equal(runtime.getMetrics("test").retries, 2);
});

test("timeout is classified and retried only for an idempotent operation", async () => {
  let calls = 0;
  const runtime = new ProviderRuntime({ sleep: async () => {}, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => { calls += 1; signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }) });
  await assert.rejects(runtime.fetch("slow", "https://slow.test", { timeoutMs: 2, retries: 1, quotaTracker: unlimitedQuota }), (error) => error.code === ProviderErrorCode.TIMEOUT);
  assert.equal(calls, 2);
});

test("in-flight requests are deduplicated", async () => {
  let release; let calls = 0;
  const runtime = new ProviderRuntime({ fetchImpl: async () => { calls += 1; await new Promise((resolve) => { release = resolve; }); return ok(); } });
  const one = runtime.fetch("dedupe", "https://example.test/same", { quotaTracker: unlimitedQuota });
  const two = runtime.fetch("dedupe", "https://example.test/same", { quotaTracker: unlimitedQuota });
  await new Promise((resolve) => setImmediate(resolve)); release(); await Promise.all([one, two]);
  assert.equal(calls, 1); assert.equal(runtime.getMetrics("dedupe").deduplicated, 1);
});

test("quota exhaustion rejects before making a network call", async () => {
  let calls = 0; const runtime = new ProviderRuntime({ fetchImpl: async () => { calls += 1; return ok(); } });
  await assert.rejects(runtime.fetch("limited", "https://example.test", { quotaTracker: { getProviderSnapshot: () => ({ exhausted: true }) } }), (error) => error.code === ProviderErrorCode.QUOTA_EXHAUSTED);
  assert.equal(calls, 0);
});

test("circuit opens and recovers half-open with a simulated clock", async () => {
  let now = 0; let fail = true;
  const runtime = new ProviderRuntime({ now: () => now, failureThreshold: 1, recoveryMs: 1_000, sleep: async () => {}, fetchImpl: async () => fail ? ok(503) : ok() });
  await assert.rejects(runtime.fetch("circuit", "https://example.test/a", { retries: 0, throwHttpErrors: true, quotaTracker: unlimitedQuota }));
  assert.equal(runtime.getCircuitSnapshot("circuit").state, "open");
  await assert.rejects(runtime.fetch("circuit", "https://example.test/b", { quotaTracker: unlimitedQuota }), (error) => error.code === ProviderErrorCode.CIRCUIT_OPEN);
  now = 1_001; fail = false; assert.equal((await runtime.fetch("circuit", "https://example.test/c", { quotaTracker: unlimitedQuota })).status, 200);
  assert.equal(runtime.getCircuitSnapshot("circuit").state, "closed");
});

test("quota consumption survives restart through an atomic state file", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ogid-quota-")), "quota.json");
  const first = new ApiQuotaTrackerService({ persistencePath: file }); first.reset({ newsapiDailyLimit: 100 }); first.recordCall("newsapi", { units: 3 });
  const second = new ApiQuotaTrackerService({ persistencePath: file }); second.reset({ newsapiDailyLimit: 100 }, { hydrate: true });
  assert.equal(second.getProviderSnapshot("newsapi").units24h, 3);
});
