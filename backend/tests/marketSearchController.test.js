import assert from "node:assert/strict";
import test from "node:test";
import { searchInstruments } from "../controllers/marketController.js";

test("instrument search returns an explicit 429 before calling Yahoo when its window is exhausted", async () => {
  let upstreamCalls = 0;
  const req = { query: { q: "Tesla" }, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } };
  const res = {
    app: { locals: {
      marketSearchRateLimiter: { consume: () => ({ allowed: false, retryAfterMs: 2_500 }) },
      marketDataService: { searchSymbols: async () => { upstreamCalls += 1; return []; } },
      marketWatchlistService: { selectedInstrumentIds: [], rememberCandidates() {} },
    } },
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
  await searchInstruments(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["Retry-After"], "3");
  assert.equal(res.payload.error.code, "MARKET_SEARCH_RATE_LIMITED");
  assert.equal(upstreamCalls, 0);
});

test("instrument search translates Yahoo 429 into provider 503 with Retry-After", async () => {
  const req = { query: { q: "NQ=F", limit: "12" }, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } };
  const res = {
    app: { locals: {
      marketSearchRateLimiter: { consume: () => ({ allowed: true, retryAfterMs: 0 }) },
      marketDataService: { searchSymbols: async () => { throw Object.assign(new Error("upstream limited"), { status: 429, retryAfterMs: 60_000 }); } },
      marketWatchlistService: { selectedInstrumentIds: [], rememberCandidates() {} },
    } },
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
  await searchInstruments(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["Retry-After"], "60");
  assert.equal(res.payload.error.code, "MARKET_SEARCH_PROVIDER_RATE_LIMITED");
  assert.equal(res.payload.error.retryAfterSeconds, 60);
});

test("instrument search exposes transient Yahoo network failures as an explicit 503", async () => {
  const req = { query: { q: "AAPL" }, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } };
  const res = {
    app: { locals: {
      marketSearchRateLimiter: { consume: () => ({ allowed: true, retryAfterMs: 0 }) },
      marketDataService: { searchSymbols: async () => { throw Object.assign(new Error("fetch failed"), { code: "YAHOO_REQUEST_FAILED" }); } },
      marketWatchlistService: { selectedInstrumentIds: [], rememberCandidates() {} },
    } },
    statusCode: 200,
    payload: null,
    setHeader() {},
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
  await searchInstruments(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error.code, "MARKET_SEARCH_PROVIDER_UNAVAILABLE");
});
