import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeYahooChart,
  normalizeYahooQuote,
  normalizeYahooSearchResults,
  normalizeYahooSymbol,
  resolveMarketDataRange,
} from "../services/marketData/normalizer.js";

test("Yahoo chart normalization returns sorted, deduplicated canonical bars", () => {
  const result = normalizeYahooChart({ quotes: [
    { date: new Date("2026-07-15T00:00:00Z"), open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { date: new Date("2026-07-14T00:00:00Z"), open: "8", high: "11", low: "7", close: "10", volume: null },
    { date: new Date("2026-07-15T00:00:00Z"), open: 10, high: 13, low: 9, close: 12, volume: 110 },
    { date: "invalid", open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { date: new Date("2026-07-16T00:00:00Z"), open: 10, high: 9, low: 8, close: 11, volume: 100 },
  ] }, { symbol: "aapl" });

  assert.deepEqual(result, [
    { symbol: "AAPL", source: "yahoo", timestamp: "2026-07-14T00:00:00.000Z", open: 8, high: 11, low: 7, close: 10, volume: null },
    { symbol: "AAPL", source: "yahoo", timestamp: "2026-07-15T00:00:00.000Z", open: 10, high: 13, low: 9, close: 12, volume: 110 },
  ]);
});

test("Yahoo quote and search normalization preserve useful instrument metadata", () => {
  const quote = normalizeYahooQuote({
    symbol: "aapl",
    regularMarketPrice: 201.5,
    regularMarketTime: new Date("2026-07-15T20:00:00Z"),
    regularMarketChangePercent: 1.25,
    regularMarketVolume: 50,
    currency: "USD",
    fullExchangeName: "NasdaqGS",
    exchangeTimezoneName: "America/New_York",
    quoteType: "EQUITY",
    longName: "Apple Inc.",
  });
  assert.equal(quote.symbol, "AAPL");
  assert.equal(quote.source, "yahoo");
  assert.equal(quote.assetType, "equity");
  assert.equal(quote.timestamp, "2026-07-15T20:00:00.000Z");

  const search = normalizeYahooSearchResults({ quotes: [
    { symbol: "AAPL", isYahooFinance: true, quoteType: "EQUITY", longname: "Apple Inc.", exchange: "NMS", sector: "Technology" },
    { symbol: "AAPL", isYahooFinance: true, quoteType: "EQUITY", shortname: "duplicate" },
    { symbol: "AAPL260101C00100000", isYahooFinance: true, quoteType: "OPTION" },
    { symbol: "bad symbol", isYahooFinance: true, quoteType: "EQUITY" },
  ] }, { limit: 10 });
  assert.deepEqual(search, [{
    symbol: "AAPL",
    source: "yahoo",
    name: "Apple Inc.",
    shortName: null,
    longName: "Apple Inc.",
    exchange: "NMS",
    assetType: "equity",
    quoteType: "EQUITY",
    sector: "Technology",
    industry: null,
  }]);
});

test("period and interval validation blocks invalid symbols and long intraday ranges", () => {
  const range = resolveMarketDataRange({ now: new Date("2026-07-16T12:00:00Z") });
  assert.equal(range.period, "1y");
  assert.equal(range.interval, "1d");
  assert.equal(range.period1.toISOString(), "2025-07-16T00:00:00.000Z");
  assert.equal(normalizeYahooSymbol("nq=f"), "NQ=F");
  assert.equal(normalizeYahooSymbol("^gspc"), "^GSPC");
  assert.equal(normalizeYahooSymbol("btc-usd"), "BTC-USD");
  assert.equal(normalizeYahooSymbol("eurusd=x"), "EURUSD=X");
  assert.throws(() => normalizeYahooSymbol("../AAPL"), (error) => error.code === "INVALID_SYMBOL");
  assert.throws(() => resolveMarketDataRange({ period: "10y", interval: "1d" }), (error) => error.code === "INVALID_PERIOD");
  assert.throws(() => resolveMarketDataRange({ period: "5y", interval: "1h" }), (error) => error.code === "INVALID_RANGE");
  assert.equal(resolveMarketDataRange({ period: "1mo", interval: "5m" }).interval, "5m");
  assert.throws(() => resolveMarketDataRange({ period: "3mo", interval: "15m" }), (error) => error.code === "INVALID_RANGE");
});

test("absolute market data ranges preserve historical boundaries and validate the actual span", () => {
  const range = resolveMarketDataRange({
    period: "5y",
    interval: "5m",
    from: "2024-01-08T14:30:00Z",
    to: "2024-01-12T21:00:00Z",
    now: new Date("2026-07-16T12:00:00Z"),
  });
  assert.equal(range.period1.toISOString(), "2024-01-08T14:30:00.000Z");
  assert.equal(range.period2.toISOString(), "2024-01-12T21:00:00.000Z");
  assert.throws(() => resolveMarketDataRange({ from: "not-a-date", to: "2024-01-12T21:00:00Z" }), (error) => error.code === "INVALID_RANGE");
  assert.throws(() => resolveMarketDataRange({ from: "2024-01-01T00:00:00Z" }), (error) => error.code === "INVALID_RANGE");
  assert.throws(() => resolveMarketDataRange({ to: "2024-01-12T21:00:00Z" }), (error) => error.code === "INVALID_RANGE");
  assert.throws(() => resolveMarketDataRange({ from: "2024-01-12T21:00:00Z", to: "2024-01-12T21:00:00Z" }), (error) => error.code === "INVALID_RANGE");
  assert.throws(() => resolveMarketDataRange({ interval: "5m", from: "2024-01-01T00:00:00Z", to: "2024-02-02T00:00:00Z" }), (error) => error.code === "INVALID_RANGE");
});
