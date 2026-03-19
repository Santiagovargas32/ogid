import test from "node:test";
import assert from "node:assert/strict";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { fetchMarketQuotes } from "../services/market/marketProviderRouter.js";
import { resetFmpProviderStateForTests } from "../services/market/providers/fmpProvider.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function csvResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/csv" }
  });
}

test("market provider router returns deterministic fallback when web and fmp are unavailable", async () => {
  resetFmpProviderStateForTests();
  apiQuotaTracker.reset({
    twelveDailyLimit: 800,
    twelveMinuteLimit: 8,
    fmpDailyLimit: 250
  });

  const result = await fetchMarketQuotes({
    provider: "web",
    fallbackProvider: "fmp",
    webSource: "unsupported-source",
    fmpApiKey: "",
    tickers: ["GD", "BA"],
    timeoutMs: 500
  });

  assert.equal(result.sourceMode, "fallback");
  assert.equal(Object.keys(result.quotes).length, 2);
  assert.ok(Object.values(result.quotes).every((quote) => quote.synthetic === true));
  assert.ok(Object.values(result.quotes).every((quote) => quote.dataMode === "synthetic-fallback"));
  assert.equal(result.sourceMeta.requestMode, "unavailable");
  assert.equal(result.sourceMeta.configuredProvider, "web");
  assert.equal(result.sourceMeta.configuredFallbackProvider, "fmp");
  assert.equal(result.sourceMeta.effectiveProvider, null);
  assert.deepEqual(result.sourceMeta.coverageByMode, {
    live: 0,
    webDelayed: 0,
    historicalEod: 0,
    routerStale: 0,
    syntheticFallback: 2
  });
  assert.equal(result.sourceMeta.fallbackCount, 2);
  assert.ok(Array.isArray(result.sourceMeta.providerErrors));
  assert.equal(result.sourceMeta.providerDiagnostics.web.errorCode, "web-source-invalid");
  assert.equal(result.sourceMeta.providerDiagnostics.fmp.errorCode, "api-key-missing");
});

test("market provider router prefers yahoo, dedupes duplicate tickers and ignores duplicate upstream symbols", async () => {
  resetFmpProviderStateForTests();
  apiQuotaTracker.reset({
    yahooDailyLimit: 100,
    twelveDailyLimit: 800,
    twelveMinuteLimit: 8,
    fmpDailyLimit: 250
  });

  const originalFetch = global.fetch;
  const seenUrls = [];
  global.fetch = async (url) => {
    const value = String(url);
    seenUrls.push(value);

    if (value.includes("query1.finance.yahoo.com/v7/finance/quote")) {
      return jsonResponse({
        quoteResponse: {
          result: [
            {
              symbol: "GD",
              regularMarketPrice: 300.5,
              regularMarketChangePercent: 0.25,
              regularMarketPreviousClose: 299.75,
              regularMarketDayHigh: 301.2,
              regularMarketDayLow: 298.8,
              regularMarketVolume: 1200,
              regularMarketTime: 1_742_141_100,
              marketState: "REGULAR"
            },
            {
              symbol: "BA",
              regularMarketPrice: 205.22,
              regularMarketChangePercent: 0.8,
              regularMarketPreviousClose: 203.6,
              regularMarketDayHigh: 206.0,
              regularMarketDayLow: 202.0,
              regularMarketVolume: 1800,
              regularMarketTime: 1_742_141_100,
              marketState: "REGULAR"
            },
            {
              symbol: "BA",
              regularMarketPrice: 206.11,
              regularMarketChangePercent: 1.1,
              regularMarketPreviousClose: 203.6,
              regularMarketDayHigh: 206.5,
              regularMarketDayLow: 202.0,
              regularMarketVolume: 1801,
              regularMarketTime: 1_742_141_160,
              marketState: "REGULAR"
            }
          ]
        }
      });
    }

    return jsonResponse({}, 404);
  };

  try {
    const result = await fetchMarketQuotes({
      provider: "web",
      fallbackProvider: "fmp",
      webSource: "yahoo",
      webBaseUrl: "https://query1.finance.yahoo.com",
      twelveApiKey: "demo",
      tickers: ["GD", "GD", "BA"],
      timeoutMs: 500
    });

    assert.equal(result.sourceMode, "live");
    assert.deepEqual(Object.keys(result.quotes).sort(), ["BA", "GD"]);
    assert.equal(result.quotes.GD.sourceDetail, "yahoo");
    assert.equal(result.quotes.BA.sourceDetail, "yahoo");
    assert.equal(result.quotes.BA.dataMode, "live");
    assert.equal(result.sourceMeta.providerDiagnostics.web.effectiveSource, "yahoo");
    assert.deepEqual(result.sourceMeta.providerDiagnostics.web.requestedTickers, ["GD", "BA"]);
    assert.equal(result.sourceMeta.providerDiagnostics.web.requestUrls.length, 1);
    assert.equal(result.sourceMeta.providerScore > 0, true);
    assert.deepEqual(result.sourceMeta.coverageByMode, {
      live: 2,
      webDelayed: 0,
      historicalEod: 0,
      routerStale: 0,
      syntheticFallback: 0
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("market provider router falls back from yahoo to twelve and records source attempts", async () => {
  resetFmpProviderStateForTests();
  apiQuotaTracker.reset({
    yahooDailyLimit: 100,
    twelveDailyLimit: 800,
    twelveMinuteLimit: 8,
    fmpDailyLimit: 250
  });

  const originalFetch = global.fetch;
  const seenUrls = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    seenUrls.push(value);

    if (value.includes("query1.finance.yahoo.com/v7/finance/quote")) {
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        const abort = () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (signal) {
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        }

        setTimeout(() => {
          resolve(jsonResponse({ quoteResponse: { result: [] } }));
        }, 50);
      });
    }

    if (value.includes("api.twelvedata.com/quote")) {
      return jsonResponse({
        data: [
          {
            symbol: "GD",
            close: "300.50",
            percent_change: "0.25",
            previous_close: "299.75",
            high: "301.20",
            low: "298.80",
            volume: "1200",
            datetime: "2026-03-16 18:45:00",
            market_state: "REGULAR"
          },
          {
            symbol: "BA",
            close: "200.25",
            percent_change: "0.80",
            previous_close: "198.66",
            high: "201.00",
            low: "199.00",
            volume: "1100",
            datetime: "2026-03-16 18:45:00",
            market_state: "REGULAR"
          }
        ]
      });
    }

    return jsonResponse({}, 404);
  };

  try {
    const result = await fetchMarketQuotes({
      provider: "web",
      fallbackProvider: "fmp",
      webSource: "yahoo",
      webBaseUrl: "https://query1.finance.yahoo.com",
      twelveApiKey: "demo",
      twelveBaseUrl: "https://api.twelvedata.com",
      webUserAgent: "ogid/1.0",
      tickers: ["GD", "BA"],
      timeoutMs: 15
    });

    assert.ok(seenUrls.some((value) => value.includes("query1.finance.yahoo.com/v7/finance/quote")));
    assert.ok(seenUrls.some((value) => value.includes("api.twelvedata.com/quote")));
    assert.equal(result.sourceMode, "live");
    assert.equal(result.quotes.GD.sourceDetail, "twelve");
    assert.equal(result.quotes.GD.dataMode, "live");
    assert.equal(result.quotes.BA.sourceDetail, "twelve");
    assert.equal(result.sourceMeta.providerDiagnostics.web.effectiveSource, "twelve");
    assert.equal(Array.isArray(result.sourceMeta.sourceAttempts), true);
    assert.equal(result.sourceMeta.sourceAttempts.length >= 2, true);
    assert.equal(result.sourceMeta.sourceAttempts[0].source, "yahoo");
    assert.equal(result.sourceMeta.sourceAttempts[1].source, "twelve");
    assert.equal(Number.isFinite(Number(result.sourceMeta.providerDiagnostics.web.providerLatencyMs)), true);
    assert.equal(result.sourceMeta.providerDiagnostics.web.providerLatencyMs > 0, true);
    assert.equal(result.sourceMeta.providerDiagnostics.web.providerScore >= 0, true);
    assert.deepEqual(result.sourceMeta.coverageByMode, {
      live: 2,
      webDelayed: 0,
      historicalEod: 0,
      routerStale: 0,
      syntheticFallback: 0
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("market provider router uses stale quotes before deterministic fallback when providers are exhausted", async () => {
  resetFmpProviderStateForTests();
  apiQuotaTracker.reset({
    twelveDailyLimit: 1,
    twelveMinuteLimit: 1,
    fmpDailyLimit: 1
  });
  apiQuotaTracker.recordCall("twelve", { status: "success" });
  apiQuotaTracker.recordCall("fmp", { status: "success" });

  const result = await fetchMarketQuotes({
    provider: "web",
    fallbackProvider: "fmp",
    webSource: "twelve",
    tickers: ["GD", "BA"],
    timeoutMs: 500,
    staleTtlMs: 60_000,
    previousQuotes: {
      GD: {
        price: 299.5,
        changePct: 0.5,
        asOf: new Date().toISOString(),
        source: "web",
        synthetic: false,
        dataMode: "live",
        sourceDetail: "yahoo"
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
    ["fmp", "web"]
  );
  assert.deepEqual(result.sourceMeta.usedStaleQuotes, ["GD"]);
  assert.deepEqual(result.sourceMeta.coverageByMode, {
    live: 0,
    webDelayed: 0,
    historicalEod: 0,
    routerStale: 1,
    syntheticFallback: 1
  });
  assert.equal(result.sourceMeta.fallbackCount, 2);
  assert.equal(result.sourceMeta.routerDecision.fallbackReason, "synthetic-fallback");
});
