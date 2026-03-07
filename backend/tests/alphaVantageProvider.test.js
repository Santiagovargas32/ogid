import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchAlphaVantageProviderQuotes,
  resetAlphaVantageThrottleForTests
} from "../services/market/providers/alphaVantageProvider.js";

test("alphavantage provider applies local cooldown after rate limit and stops the cycle early", async () => {
  resetAlphaVantageThrottleForTests();

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        Note: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day."
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  try {
    const first = await fetchAlphaVantageProviderQuotes({
      apiKey: "demo",
      baseUrl: "https://www.alphavantage.co/query",
      tickers: ["GD", "BA", "NOC"],
      timeoutMs: 1000,
      maxRequestsPerRun: 5
    });

    assert.equal(fetchCalls, 1);
    assert.equal(first.sourceMode, "fallback");
    assert.equal(first.sourceMeta.requestCount, 1);
    assert.equal(first.sourceMeta.errors.length, 1);
    assert.equal(first.sourceMeta.errors[0].code, "rate-limited");
    assert.ok(first.sourceMeta.nextAllowedAt);
    assert.deepEqual(first.missingTickers, ["GD", "BA", "NOC"]);

    const second = await fetchAlphaVantageProviderQuotes({
      apiKey: "demo",
      baseUrl: "https://www.alphavantage.co/query",
      tickers: ["GD", "BA", "NOC"],
      timeoutMs: 1000,
      maxRequestsPerRun: 5
    });

    assert.equal(fetchCalls, 1);
    assert.equal(second.sourceMeta.reason, "cooldown");
    assert.ok(second.sourceMeta.nextAllowedAt);
    assert.deepEqual(second.missingTickers, ["GD", "BA", "NOC"]);
  } finally {
    global.fetch = originalFetch;
    resetAlphaVantageThrottleForTests();
  }
});
