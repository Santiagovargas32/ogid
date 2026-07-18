import assert from "node:assert/strict";
import test from "node:test";
import {
  getInstrumentById,
  getInstrumentByProviderSymbol,
  getProviderSymbol,
  listEnabledInstruments,
  listVerifiedInstruments,
  resolveAlias,
  resolveEnabledInstruments,
  resolveInstrument,
  validateInstrument
} from "../services/market/instrumentRegistry.js";
import { fetchMarketQuotes } from "../services/market/marketProviderRouter.js";

test("canonical registry contains exactly the seven verified enabled instruments", () => {
  const instruments = listEnabledInstruments();
  assert.deepEqual(instruments.map((item) => item.canonicalSymbol), ["GD", "BA", "NOC", "LMT", "RTX", "XOM", "CVX"]);
  assert.equal(new Set(instruments.map((item) => item.instrumentId)).size, 7);
  assert.equal(new Set(instruments.flatMap((item) => item.aliases.map((alias) => alias.toUpperCase()))).size, 7);
  for (const instrument of instruments) {
    assert.equal(validateInstrument(instrument).valid, true);
    assert.notEqual(instrument.instrumentId, instrument.canonicalSymbol);
    assert.equal(instrument.exchange, "New York Stock Exchange");
    assert.equal(instrument.mic, "XNYS");
    assert.equal(instrument.currency, "USD");
    assert.equal(instrument.timezone, "America/New_York");
    assert.ok(instrument.providerSymbols.twelve);
    assert.ok(instrument.providerSymbols.yahoo);
  }
});

test("verified rollout batches add only confirmed provider mappings", () => {
  assert.deepEqual(listEnabledInstruments(2).map((item) => item.canonicalSymbol), ["GD", "BA", "NOC", "LMT", "RTX", "XOM", "CVX", "LDOS", "HII"]);
  assert.deepEqual(listEnabledInstruments(3).map((item) => item.canonicalSymbol), ["GD", "BA", "NOC", "LMT", "RTX", "XOM", "CVX", "LDOS", "HII", "NVDA", "AAPL", "AMD", "ORCL", "GOOGL", "MSFT", "QQQ", "XLE", "BTC/USD"]);
  assert.equal(listVerifiedInstruments().length, 18);
  for (const instrument of listVerifiedInstruments()) {
    assert.equal(instrument.verificationStatus, "verified");
    assert.ok(instrument.providerSymbols.twelve);
    assert.ok(instrument.providerSymbols.yahoo);
    assert.ok(instrument.minRefreshIntervalMs >= 300_000);
  }
  assert.equal(resolveEnabledInstruments(["LDOS"], 1).rejected[0], "LDOS");
  assert.equal(resolveEnabledInstruments(["LDOS"], 2).instruments[0].instrumentId, "us-equity-leidos");
  assert.equal(resolveEnabledInstruments(["NVDA", "AAPL", "AMD", "ORCL"], 3).instruments.length, 4);
  for (const symbol of ["NVDA", "AAPL", "AMD"]) {
    const instrument = resolveInstrument(symbol);
    assert.equal(instrument.exchange, "Nasdaq Stock Market");
    assert.equal(instrument.mic, "XNAS");
    assert.equal(instrument.currency, "USD");
    assert.equal(instrument.timezone, "America/New_York");
    assert.equal(instrument.providerSymbols.twelve, symbol);
    assert.equal(instrument.providerSymbols.yahoo, symbol);
  }
  assert.equal(resolveInstrument("ORCL").exchange, "New York Stock Exchange");
  assert.equal(resolveInstrument("ORCL").mic, "XNYS");
  for (const symbol of ["GOOGL", "MSFT", "QQQ"]) {
    const instrument = resolveInstrument(symbol);
    assert.equal(instrument.mic, "XNAS");
    assert.equal(instrument.providerSymbols.twelve, symbol);
    assert.equal(instrument.providerSymbols.yahoo, symbol);
  }
});

test("instrument and alias resolution is case-insensitive and provider-specific", () => {
  const gd = resolveInstrument("gd");
  assert.equal(getInstrumentById(gd.instrumentId.toUpperCase()).canonicalSymbol, "GD");
  assert.equal(resolveAlias("gD").instrumentId, gd.instrumentId);
  assert.equal(getProviderSymbol(gd.instrumentId, "TWELVE"), "GD");
  assert.equal(getProviderSymbol(gd.instrumentId, "yahoo"), "GD");
  assert.equal(getInstrumentByProviderSymbol("twelve", "gd").instrumentId, gd.instrumentId);
  assert.equal(resolveAlias("UNKNOWN"), null);
  assert.deepEqual(resolveEnabledInstruments(["GD", "unknown"]).rejected, ["unknown"]);
});

test("router preserves canonical identity through fallback and enriches all seven quotes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("api.twelvedata.com")) return new Response(JSON.stringify({ status: "error", code: 401, message: "test" }));
    const symbol = value.split("/quote/")[1]?.split(/[/?#]/)[0];
    return new Response(`<fin-streamer data-symbol="${symbol}" data-field="regularMarketPrice" value="100">100</fin-streamer>`);
  };
  try {
    const symbols = listEnabledInstruments().map((item) => item.canonicalSymbol);
    const result = await fetchMarketQuotes({ provider: "twelve", fallbackProvider: "yahoo", twelveApiKey: "test", tickers: symbols, timeoutMs: 100, marketDataService: { fetchQuotes: async (requested) => requested.map((symbol) => ({ symbol, timestamp: new Date().toISOString(), price: 100, changePercent: 0, previousClose: 100, currency: "USD", exchange: resolveInstrument(symbol).exchange, timezone: "America/New_York", marketState: "REGULAR" })) } });
    assert.deepEqual(Object.keys(result.quotes), symbols);
    for (const symbol of symbols) {
      const instrument = resolveInstrument(symbol); const quote = result.quotes[symbol];
      assert.equal(quote.instrumentId, instrument.instrumentId);
      assert.equal(quote.providerSymbol, instrument.providerSymbols.yahoo);
      assert.equal(quote.exchange, instrument.exchange);
      assert.equal(quote.mic, instrument.mic);
      assert.equal(quote.currency, instrument.currency);
      assert.equal(quote.timezone, instrument.timezone);
      assert.equal(quote.dataMode, "observed");
      assert.equal(quote.stale, false);
      assert.ok(quote.session);
      assert.ok(quote.asOf);
      assert.ok(quote.source);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("unknown references never reach a provider", async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("network-must-not-run"); };
  try {
    const result = await fetchMarketQuotes({ provider: "twelve", fallbackProvider: "yahoo", twelveApiKey: "test", tickers: ["UNKNOWN"] });
    assert.equal(calls, 0); assert.deepEqual(result.sourceMeta.rejectedInstrumentReferences, ["UNKNOWN"]); assert.deepEqual(result.quotes, {});
  } finally { globalThis.fetch = originalFetch; }
});

test("unexpected provider symbols do not create instruments", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ symbol: "AAPL", close: "200" }] }), { headers: { "content-type": "application/json" } });
  try {
    const result = await fetchMarketQuotes({ provider: "twelve", fallbackProvider: "", twelveApiKey: "test", tickers: ["GD"], timeoutMs: 100 });
    assert.deepEqual(Object.keys(result.quotes), ["GD"]); assert.equal(result.quotes.GD.dataMode, "synthetic"); assert.equal(result.quotes.AAPL, undefined);
  } finally { globalThis.fetch = originalFetch; }
});
