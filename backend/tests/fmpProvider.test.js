import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFmpBatchQuoteUrl,
  buildFmpHistoricalEodUrl,
  fetchFmpQuotes,
  toStableFmpBaseUrl
} from "../services/market/providers/fmpProvider.js";

test("fmp provider normalizes legacy api/v3 base urls to stable", () => {
  assert.equal(toStableFmpBaseUrl("https://financialmodelingprep.com/api/v3"), "https://financialmodelingprep.com/stable");
  assert.equal(toStableFmpBaseUrl("https://financialmodelingprep.com/stable"), "https://financialmodelingprep.com/stable");
});

test("fmp provider builds stable batch and historical urls", () => {
  const batchUrl = buildFmpBatchQuoteUrl({
    baseUrl: "https://financialmodelingprep.com/api/v3",
    tickers: ["LMT", "RTX"],
    apiKey: "demo"
  });
  const historicalUrl = buildFmpHistoricalEodUrl({
    baseUrl: "https://financialmodelingprep.com/api/v3",
    ticker: "LMT",
    apiKey: "demo"
  });

  assert.equal(
    batchUrl.toString(),
    "https://financialmodelingprep.com/stable/batch-quote?symbols=LMT%2CRTX&apikey=demo"
  );
  assert.equal(
    historicalUrl.toString(),
    "https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=LMT&apikey=demo"
  );
});

test("fmp provider classifies 402 entitlement failures and skips historical fallback in the same cycle", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        Error: "Payment Required"
      }),
      {
        status: 402,
        headers: { "content-type": "application/json" }
      }
    );
  };

  try {
    const result = await fetchFmpQuotes({
      apiKey: "demo",
      baseUrl: "https://financialmodelingprep.com/api/v3",
      tickers: ["LMT", "RTX"],
      timeoutMs: 1000,
      enableHistoricalBackfill: true,
      historicalBackfillTickers: ["LMT", "RTX"]
    });

    assert.equal(fetchCalls, 1);
    assert.equal(result.sourceMode, "fallback");
    assert.equal(result.sourceMeta.requestMode, "batch");
    assert.equal(result.sourceMeta.providerDisabledReason, "provider-not-entitled");
    assert.equal(result.sourceMeta.historicalRequests, 0);
    assert.equal(result.sourceMeta.batchRequests, 1);
    assert.equal(result.sourceMeta.errors.length > 0, true);
    assert.equal(result.sourceMeta.errors[0].code, "provider-not-entitled");
    assert.equal(result.sourceMeta.errors[0].scope, "batch");
  } finally {
    global.fetch = originalFetch;
  }
});
