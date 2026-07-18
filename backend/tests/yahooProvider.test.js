import test from "node:test";
import assert from "node:assert/strict";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { fetchYahooDailyCandles, fetchYahooQuotes } from "../services/market/providers/yahooProvider.js";

function quote(symbol, overrides = {}) {
  return {
    symbol,
    source: "yahoo",
    timestamp: "2026-07-16T18:45:00.000Z",
    price: 300.5,
    changePercent: 0.25,
    previousClose: 299.75,
    high: 301.2,
    low: 298.8,
    volume: 1_200,
    currency: "USD",
    exchange: "Nasdaq",
    timezone: "America/New_York",
    marketState: "REGULAR",
    ...overrides,
  };
}

test("Yahoo provider preserves the legacy quote envelope while using MarketDataService", async () => {
  apiQuotaTracker.reset({ yahooDailyLimit: 10 });
  const result = await fetchYahooQuotes({
    tickers: ["gd", "GD"],
    timestamp: "2026-07-16T18:45:00.000Z",
    session: { open: true, state: "open" },
    marketDataService: { fetchQuotes: async (symbols) => symbols.map((symbol) => quote(symbol)) },
  });
  assert.deepEqual(result.requestedTickers, ["GD"]);
  assert.deepEqual(result.returnedTickers, ["GD"]);
  assert.equal(result.requestMode, "yahoo-finance2-quote");
  assert.equal(result.transport, "server-library");
  assert.equal(result.quotes.GD.price, 300.5);
  assert.equal(result.quotes.GD.changePct, 0.25);
  assert.equal(result.quotes.GD.sourceDetail, "yahoo-finance2");
  assert.equal(result.requestUrls.length, 0);
  assert.equal(result.errors.length, 0);
});

test("Yahoo provider reports missing symbols without discarding successful quotes", async () => {
  const result = await fetchYahooQuotes({
    tickers: ["GD", "BA"],
    marketDataService: { fetchQuotes: async () => [quote("GD")] },
  });
  assert.deepEqual(Object.keys(result.quotes), ["GD"]);
  assert.deepEqual(result.missingTickers, ["BA"]);
  assert.equal(result.errors[0].code, "yahoo-quote-missing");
  assert.equal(result.errors[0].ticker, "BA");
});

test("Yahoo provider exposes a sanitized service failure through the existing envelope", async () => {
  const failure = Object.assign(new Error("Yahoo request timed out"), { code: "YAHOO_TIMEOUT" });
  const result = await fetchYahooQuotes({
    tickers: ["GD"],
    marketDataService: { fetchQuotes: async () => { throw failure; } },
  });
  assert.deepEqual(result.returnedTickers, []);
  assert.equal(result.errors[0].code, "YAHOO_TIMEOUT");
  assert.equal(result.errors[0].message, "Yahoo request timed out");
});

test("Yahoo provider rejects malformed public codes and redacts secret-bearing messages", async () => {
  const failure = Object.assign(new Error("failed https://query2.finance.yahoo.com/quote?crumb=message-secret"), {
    code: "https://example.test/error?token=code-secret",
  });
  const result = await fetchYahooQuotes({
    tickers: ["GD"],
    marketDataService: { fetchQuotes: async () => { throw failure; } },
  });
  const serialized = JSON.stringify(result.errors);
  assert.equal(result.errors[0].code, "yahoo-request-failed");
  assert.equal(serialized.includes("message-secret"), false);
  assert.equal(serialized.includes("code-secret"), false);
});

test("Yahoo candle adapter maps normalized bars into the legacy candle contract", async () => {
  const marketDataService = {
    ensureMarketData: async () => ({
      data: {
        GD: {
          symbol: "GD",
          stale: false,
          cached: false,
          bars: [{ symbol: "GD", source: "yahoo", timestamp: "2026-07-15T00:00:00.000Z", open: 10, high: 12, low: 9, close: 11, volume: 100 }],
          persistence: { inserted: 1, updated: 0, duplicates: 0, rejectedOpen: 0 },
        },
      },
      errors: [],
    }),
  };
  const result = await fetchYahooDailyCandles({ symbols: ["GD"], interval: "1day", outputsize: 5, marketDataService });
  assert.deepEqual(result.returnedSymbols, ["GD"]);
  assert.equal(result.candlesBySymbol.GD.values[0].close, 11);
  assert.equal(result.persistence.inserted, 1);
  assert.equal(result.errors.length, 0);
});
