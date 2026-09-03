import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFinancialNewsQueryPacks,
  buildFinancialNewsQueryPlan,
  FINANCIAL_QUERY_MAX_LENGTH,
  normalizeNewsQueryPacks
} from "../services/news/newsQueryPackService.js";

test("financial query packs are separated by lane and every query stays within provider limits", () => {
  const marketTickers = ["BTC-USD", "SPY", "CL=F"];
  const packs = buildFinancialNewsQueryPacks({ marketTickers });

  assert.deepEqual(Object.keys(packs), ["macro", "market", "corporate-watchlist", "regulatory"]);
  assert.equal(Object.values(packs).every((query) => query.length > 0), true);
  assert.equal(Object.values(packs).every((query) => query.length <= FINANCIAL_QUERY_MAX_LENGTH), true);
  assert.match(packs.macro, /Federal Reserve/);
  assert.match(packs.market, /stock market/);
  assert.match(packs["corporate-watchlist"], /BTC-USD/);
  assert.match(packs["corporate-watchlist"], /SPY/);
  assert.match(packs["corporate-watchlist"], /CL=F/);
  assert.match(packs["corporate-watchlist"], /earnings/);
  assert.match(packs.regulatory, /Securities and Exchange Commission/);
  assert.equal(Object.values(packs).some((query) => /(?: OR|AND)\s*$/.test(query)), false);
});

test("corporate coverage rotates the three selected instruments without adding provider calls", () => {
  const marketTickers = ["BTC-USD", "SPY", "CL=F"];
  const first = buildFinancialNewsQueryPlan({ marketTickers, maxQueryLength: 80, tickerOffset: 0 });
  const second = buildFinancialNewsQueryPlan({ marketTickers, maxQueryLength: 80, tickerOffset: 1 });

  assert.deepEqual(first.corporateCoverage.queriedTickers, ["BTC-USD", "SPY"]);
  assert.deepEqual(first.corporateCoverage.omittedTickers, ["CL=F"]);
  assert.deepEqual(second.corporateCoverage.queriedTickers, ["SPY", "CL=F"]);
  assert.deepEqual(second.corporateCoverage.omittedTickers, ["BTC-USD"]);
});

test("GNews-sized corporate pack keeps both selected instruments and corporate terms", () => {
  const query = buildFinancialNewsQueryPacks({ marketTickers: ["NVDA", "AAPL", "MSFT"], maxQueryLength: 180 })["corporate-watchlist"];
  assert.ok(query.length <= 180);
  assert.match(query, /NVDA/);
  assert.match(query, /earnings/);
  assert.doesNotMatch(query, /(?: OR|AND)\s*$/);
});

test("financial pack generation does not change legacy query-pack normalization", () => {
  const before = normalizeNewsQueryPacks({
    editorial: { defense: "missile OR defense" },
    marketSignals: { priceAction: "upgrade OR earnings" }
  }, { marketTickers: ["GD", "BA"] });

  buildFinancialNewsQueryPacks({ marketTickers: ["GD", "BA"] });

  const after = normalizeNewsQueryPacks({
    editorial: { defense: "missile OR defense" },
    marketSignals: { priceAction: "upgrade OR earnings" }
  }, { marketTickers: ["GD", "BA"] });
  assert.deepEqual(after, before);
});
