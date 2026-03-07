import test from "node:test";
import assert from "node:assert/strict";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { fetchMarketQuotes } from "../services/market/marketProviderRouter.js";

test("market provider router returns deterministic fallback when all providers unavailable", async () => {
  apiQuotaTracker.reset({
    fmpDailyLimit: 250,
    alphavantageDailyLimit: 500
  });

  const result = await fetchMarketQuotes({
    provider: "fmp",
    fallbackProvider: "alphavantage",
    fmpApiKey: "",
    alphaVantageApiKey: "",
    tickers: ["GD", "BA"],
    timeoutMs: 500
  });

  assert.equal(result.sourceMode, "fallback");
  assert.equal(Object.keys(result.quotes).length, 2);
  assert.ok(Object.values(result.quotes).every((quote) => quote.synthetic === true));
  assert.ok(Object.values(result.quotes).every((quote) => quote.dataMode === "synthetic-fallback"));
  assert.equal(result.sourceMeta.requestMode, "unavailable");
  assert.deepEqual(result.sourceMeta.coverageByMode, {
    live: 0,
    historicalEod: 0,
    routerStale: 0,
    syntheticFallback: 2
  });
  assert.ok(Array.isArray(result.sourceMeta.providerErrors));
});

test("market provider router merges stable fmp batch with secondary provider", async () => {
  apiQuotaTracker.reset({
    fmpDailyLimit: 250,
    alphavantageDailyLimit: 500
  });

  const originalFetch = global.fetch;
  const seenUrls = [];
  global.fetch = async (url) => {
    const value = String(url);
    seenUrls.push(value);

    if (value.includes("/stable/batch-quote")) {
      return new Response(
        JSON.stringify([
          {
            symbol: "GD",
            price: 300.12,
            changePercentage: "(+1.50%)"
          }
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    if (value.includes("alphavantage.co")) {
      return new Response(
        JSON.stringify({
          "Global Quote": {
            "05. price": "205.22",
            "10. change percent": "0.80%"
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    return new Response("{}", { status: 500 });
  };

  try {
    const result = await fetchMarketQuotes({
      provider: "fmp",
      fallbackProvider: "alphavantage",
      fmpApiKey: "test-key",
      fmpBaseUrl: "https://financialmodelingprep.com/api/v3",
      alphaVantageApiKey: "test-key",
      alphaVantageBaseUrl: "https://www.alphavantage.co/query",
      tickers: ["GD", "BA"],
      timeoutMs: 500
    });

    assert.ok(seenUrls.some((value) => value.includes("/stable/batch-quote?symbols=GD%2CBA")));
    assert.equal(result.sourceMode, "live");
    assert.equal(result.sourceMeta.liveCount, 2);
    assert.equal(result.sourceMeta.totalTickers, 2);
    assert.equal(result.quotes.GD.source, "fmp");
    assert.equal(result.quotes.BA.source, "alphavantage");
    assert.equal(result.quotes.GD.synthetic, false);
    assert.equal(result.quotes.BA.synthetic, false);
    assert.equal(result.quotes.GD.changePct, 1.5);
  } finally {
    global.fetch = originalFetch;
  }
});

test("market provider router uses stale quotes before deterministic fallback when providers are exhausted", async () => {
  apiQuotaTracker.reset({
    fmpDailyLimit: 1,
    alphavantageDailyLimit: 1
  });
  apiQuotaTracker.recordCall("fmp", { status: "success" });
  apiQuotaTracker.recordCall("alphavantage", { status: "success" });

  const result = await fetchMarketQuotes({
    provider: "fmp",
    fallbackProvider: "alphavantage",
    fmpApiKey: "test-key",
    alphaVantageApiKey: "test-key",
    tickers: ["GD", "BA"],
    timeoutMs: 500,
    staleTtlMs: 60_000,
    previousQuotes: {
      GD: {
        price: 299.5,
        changePct: 0.5,
        asOf: new Date().toISOString(),
        source: "fmp",
        synthetic: false,
        dataMode: "live"
      }
    }
  });

  assert.equal(result.sourceMode, "fallback");
  assert.equal(result.quotes.GD.dataMode, "router-stale");
  assert.equal(result.quotes.GD.synthetic, false);
  assert.equal(result.quotes.BA.synthetic, true);
  assert.equal(result.quotes.BA.dataMode, "synthetic-fallback");
  assert.deepEqual(
    result.sourceMeta.providersSkipped.map((item) => item.provider).sort(),
    ["alphavantage", "fmp"]
  );
  assert.deepEqual(result.sourceMeta.usedStaleQuotes, ["GD"]);
  assert.deepEqual(result.sourceMeta.coverageByMode, {
    live: 0,
    historicalEod: 0,
    routerStale: 1,
    syntheticFallback: 1
  });
});
