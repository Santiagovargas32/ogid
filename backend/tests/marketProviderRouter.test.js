import test from "node:test";
import assert from "node:assert/strict";
import { fetchMarketQuotes } from "../services/market/marketProviderRouter.js";

test("market provider router returns deterministic fallback when all providers unavailable", async () => {
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
});

test("market provider router merges partial primary with secondary provider", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);

    if (value.includes("financialmodelingprep.com")) {
      return new Response(
        JSON.stringify([
          {
            symbol: "GD",
            price: 300.12,
            changesPercentage: "(+1.50%)"
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
