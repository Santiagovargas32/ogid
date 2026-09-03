import assert from "node:assert/strict";
import test from "node:test";
import { resolveInstrumentSession } from "../services/market/instrumentRegistry.js";
import { sessionPolicyResolver } from "../services/market/sessionPolicyResolver.js";

const btc = Object.freeze({ canonicalSymbol: "BTC-USD", assetType: "crypto", sessionPolicy: "24x7", timezone: "UTC" });
const spy = Object.freeze({ canonicalSymbol: "SPY", assetType: "etf", sessionPolicy: "exchange-hours", timezone: "America/New_York" });
const crude = Object.freeze({ canonicalSymbol: "CL=F", assetType: "future", sessionPolicy: "exchange-hours", timezone: "America/New_York" });

test("the current BTC-USD, SPY and CL=F fixtures resolve through one policy authority", () => {
  const asOf = "2026-08-03T15:00:00.000Z";
  assert.equal(sessionPolicyResolver.canonicalPolicy(btc), "24x7");
  assert.equal(sessionPolicyResolver.canonicalPolicy(spy), "exchange-hours");
  assert.equal(sessionPolicyResolver.canonicalPolicy(crude), "provider-futures-hours");
  assert.equal(sessionPolicyResolver.resolve(btc, asOf).eligible, true);
  assert.equal(sessionPolicyResolver.resolve(spy, asOf).eligible, true);
  assert.equal(sessionPolicyResolver.resolve(crude, asOf).eligible, true);
  assert.equal(sessionPolicyResolver.resolve(crude, asOf).sessionPolicyPartial, true);
});

test("legacy session strings remain accepted while asset semantics correct currency and futures", () => {
  assert.equal(sessionPolicyResolver.canonicalPolicy({ assetType: "currency", sessionPolicy: "24x7" }), "24x5");
  assert.equal(sessionPolicyResolver.canonicalPolicy({ assetType: "future", sessionPolicy: "nyse-equities" }), "provider-futures-hours");
  assert.equal(sessionPolicyResolver.canonicalPolicy({ sessionPolicy: "futures-hours" }), "provider-futures-hours");
  assert.equal(sessionPolicyResolver.canonicalPolicy({ sessionPolicy: "24/7" }), "24x7");
});

test("canonical quote session decoration is asset-aware without changing its string contract", () => {
  const marketSession = { state: "open", checkedAt: "2026-08-03T15:00:00.000Z" };
  assert.equal(resolveInstrumentSession(btc, marketSession), "24x7");
  assert.equal(resolveInstrumentSession(spy, marketSession), "open");
  assert.equal(resolveInstrumentSession(crude, marketSession), "open");
});
