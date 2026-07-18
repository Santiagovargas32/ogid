import assert from "node:assert/strict";
import test from "node:test";
import { createGuardedYahooFetch, createSanitizedYahooLogger, createYahooFinanceClient, YahooClient } from "../services/marketData/yahooClient.js";
import { SlidingWindowRateLimiter, YahooRequestQueue } from "../services/marketData/rateLimit.js";

test("Yahoo queue deduplicates requests and caps logical concurrency at three", async () => {
  const queue = new YahooRequestQueue({ concurrency: 3 });
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const operation = async () => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return calls;
  };
  const first = queue.run("same", operation);
  const duplicate = queue.run("same", operation);
  assert.equal(first, duplicate);
  await Promise.all([first, duplicate, ...[1, 2, 3, 4, 5].map((value) => queue.run(`key-${value}`, operation))]);
  assert.equal(calls, 6);
  assert.equal(maximum, 3);
  assert.equal(queue.snapshot().deduplicated, 1);
});

test("Yahoo queue retries 5xx and network failures with exponential jitter", async () => {
  const waits = [];
  let calls = 0;
  const queue = new YahooRequestQueue({
    retries: 3,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
    random: () => 0.5,
    sleep: async (ms) => waits.push(ms),
  });
  const value = await queue.run("retry", async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("upstream"), { code: 503 });
    if (calls === 2) throw Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" });
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
  assert.equal(queue.snapshot().retries, 2);
});

test("Yahoo queue does not retry 429 and opens a global fail-fast cooldown", async () => {
  let now = 1_000;
  let calls = 0;
  const waits = [];
  const queue = new YahooRequestQueue({
    retries: 3,
    rateLimitCooldownMs: 60_000,
    now: () => now,
    sleep: async (ms) => waits.push(ms),
  });
  await assert.rejects(queue.run("limited", async () => {
    calls += 1;
    throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 2_500 });
  }), (error) => error.status === 429 && error.retryAfterMs === 60_000);
  await assert.rejects(queue.run("another-request", async () => { calls += 1; }), (error) => (
    error.code === "YAHOO_RATE_LIMITED" && error.retryAfterMs === 60_000
  ));
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(queue.snapshot().rateLimited, 1);
  assert.equal(queue.snapshot().cooldownRemainingMs, 60_000);
  now += 60_001;
  assert.equal(await queue.run("recovered", async () => "ok"), "ok");
});

test("Yahoo queue times out each attempt and does not retry validation failures", async () => {
  let timeoutCalls = 0;
  const timeoutQueue = new YahooRequestQueue({ timeoutMs: 5, retries: 1, sleep: async () => {} });
  await assert.rejects(timeoutQueue.run("timeout", ({ signal }) => new Promise((_resolve, reject) => {
    timeoutCalls += 1;
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })), (error) => error.code === "YAHOO_TIMEOUT" || error.name === "AbortError");
  assert.equal(timeoutCalls, 2);

  let validationCalls = 0;
  const validationQueue = new YahooRequestQueue({ retries: 3, sleep: async () => {} });
  await assert.rejects(validationQueue.run("invalid", async () => {
    validationCalls += 1;
    throw Object.assign(new Error("invalid symbol"), { code: "INVALID_SYMBOL" });
  }), (error) => error.code === "INVALID_SYMBOL");
  assert.equal(validationCalls, 1);
});

test("Yahoo client passes a fresh AbortSignal through moduleOptions.fetchOptions", async () => {
  const calls = [];
  const fake = {
    chart: async (...args) => { calls.push(["chart", ...args]); return { quotes: [] }; },
    quote: async (...args) => { calls.push(["quote", ...args]); return {}; },
    search: async (...args) => { calls.push(["search", ...args]); return { quotes: [] }; },
  };
  const client = new YahooClient({ client: fake, timeoutMs: 100, retries: 0 });
  await client.chart("AAPL", { period1: new Date("2026-07-01Z"), period2: new Date("2026-07-02Z"), interval: "1d" });
  await client.quote(["AAPL"]);
  await client.search("Apple");
  assert.deepEqual(calls.map(([name]) => name), ["chart", "quote", "search"]);
  for (const call of calls) assert.ok(call[3].fetchOptions.signal instanceof AbortSignal);
  assert.notEqual(calls[0][3].fetchOptions.signal, calls[1][3].fetchOptions.signal);
});

test("Yahoo fetch guard preserves manual redirects and blocks secret-bearing HTTP error logs", async () => {
  const redirect = { ok: false, status: 302 };
  assert.equal(await createGuardedYahooFetch(async () => redirect)("https://example.test/consent"), redirect);

  const guarded = createGuardedYahooFetch(async () => ({ ok: false, status: 500 }));
  await assert.rejects(
    guarded("https://query2.finance.yahoo.com/v7/finance/quote?crumb=never-log-this"),
    (error) => error.name === "YahooHttpError"
      && error.status === 500
      && error.code === 500
      && !error.message.includes("never-log-this"),
  );

  const rateLimited = createGuardedYahooFetch(async () => ({
    ok: false,
    status: 429,
    headers: { get: (name) => name === "retry-after" ? "7" : null },
  }));
  await assert.rejects(rateLimited("https://query2.finance.yahoo.com/v1/finance/search"), (error) => (
    error.status === 429 && error.retryAfterMs === 7_000
  ));
});

test("Yahoo v4 client receives the guarded fetch through its public constructor option", async () => {
  let calls = 0;
  const client = createYahooFinanceClient({
    fetch: async () => { calls += 1; return { ok: false, status: 429, headers: { get: () => "5" } }; },
    logger: Object.fromEntries(["info", "warn", "error", "debug", "dir"].map((level) => [level, () => {}])),
  });
  await assert.rejects(client.search("AAPL"), (error) => error.status === 429 && error.retryAfterMs === 5_000);
  assert.equal(calls, 1);
});

test("Yahoo logger redacts crumb, cookies and sensitive Error messages", () => {
  const records = [];
  const sink = Object.fromEntries(["info", "warn", "error", "debug", "dir"].map((level) => [level, (...args) => records.push([level, ...args])]));
  const logger = createSanitizedYahooLogger(sink);
  logger.debug("Retrieved crumb from cookie store: crumb-secret");
  logger.error(new Error("request failed https://query2.finance.yahoo.com/quote?crumb=url-secret&symbol=GD Cookie: session-secret"));
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes("crumb-secret"), false);
  assert.equal(serialized.includes("url-secret"), false);
  assert.equal(serialized.includes("session-secret"), false);
  assert.equal(serialized.includes("***"), true);
});

test("sliding window limiter blocks bursts, returns Retry-After and recovers", () => {
  let now = 1_000;
  const limiter = new SlidingWindowRateLimiter({ maxRequests: 2, windowMs: 1_000, now: () => now });
  assert.equal(limiter.consume("client").allowed, true);
  assert.equal(limiter.consume("client").allowed, true);
  const blocked = limiter.consume("client");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 1_000);
  assert.equal(limiter.consume("other-client").allowed, true);
  now += 1_001;
  assert.equal(limiter.consume("client").allowed, true);
});
