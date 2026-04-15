import test from "node:test";
import assert from "node:assert/strict";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { fetchMarketQuotes } from "../services/market/marketProviderRouter.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function htmlResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/html" }
  });
}

function buildYahooQuoteHtml({
  ticker,
  price,
  previousClose,
  changePercent,
  high,
  low,
  volume,
  marketTime = 1_742_141_100,
  marketState = "REGULAR"
}) {
  return `<!doctype html>
  <html>
    <head><title>${ticker}</title></head>
    <body>
      <script>
        root.App.main = ${JSON.stringify({
          context: {
            dispatcher: {
              stores: {
                QuoteSummaryStore: {
                  price: {
                    symbol: ticker,
                    regularMarketPrice: { raw: price },
                    regularMarketChangePercent: { raw: changePercent },
                    regularMarketTime: { raw: marketTime },
                    marketState
                  },
                  summaryDetail: {
                    regularMarketPreviousClose: { raw: previousClose },
                    regularMarketDayHigh: { raw: high },
                    regularMarketDayLow: { raw: low },
                    regularMarketVolume: { raw: volume }
                  },
                  quoteType: {
                    symbol: ticker
                  }
                }
              }
            }
          }
        })};
      </script>
    </body>
  </html>`;
}

function buildYahooPriceOnlyHtml({ ticker, price, changePercent = 0.15, marketTime = 1_742_141_100, marketState = "REGULAR" }) {
  return `<!doctype html>
  <html>
    <body>
      <fin-streamer data-symbol="${ticker}" data-field="regularMarketPrice" value="${price}">${price}</fin-streamer>
      <fin-streamer data-symbol="${ticker}" data-field="regularMarketChangePercent" value="${changePercent}">${changePercent}%</fin-streamer>
      <fin-streamer data-symbol="${ticker}" data-field="regularMarketTime" value="${marketTime}">${marketTime}</fin-streamer>
      <fin-streamer data-symbol="${ticker}" data-field="marketState" value="${marketState}">${marketState}</fin-streamer>
    </body>
  </html>`;
}

test("market provider router returns deterministic fallback when twelve and yahoo are unavailable", async () => {
  apiQuotaTracker.reset({
    twelveDailyLimit: 800,
    twelveMinuteLimit: 8,
    yahooDailyLimit: 100
  });

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("finance.yahoo.com/quote/")) {
      return htmlResponse("<html><body>No embedded quote</body></html>");
    }
    return jsonResponse({}, 404);
  };

  try {
    const result = await fetchMarketQuotes({
      provider: "twelve",
      fallbackProvider: "yahoo",
      twelveApiKey: "",
      yahooBaseUrl: "https://finance.yahoo.com",
      yahooUserAgent: "ogid/1.0",
      tickers: ["GD", "BA"],
      timeoutMs: 500
    });

    assert.equal(result.provider, "twelve+yahoo");
    assert.equal(result.sourceMode, "fallback");
    assert.equal(result.sourceMeta.providerChain, "twelve+yahoo");
    assert.equal(result.sourceMeta.effectiveProvider, null);
    assert.equal(Object.keys(result.quotes).length, 2);
    assert.ok(Object.values(result.quotes).every((quote) => quote.synthetic === true));
    assert.equal(result.sourceMeta.providerSlots[0].provider, "twelve");
    assert.equal(result.sourceMeta.providerSlots[0].errorCode, "api-key-missing");
    assert.equal(result.sourceMeta.providerSlots[1].provider, "yahoo");
    assert.equal(result.sourceMeta.providerSlots[1].errorCode, "yahoo-html-quote-missing");
    assert.deepEqual(result.sourceMeta.coverageByMode, {
      live: 0,
      webDelayed: 0,
      historicalEod: 0,
      routerStale: 0,
      syntheticFallback: 2
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("market provider router prefers twelve, dedupes duplicate tickers and leaves yahoo idle", async () => {
  apiQuotaTracker.reset({
    twelveDailyLimit: 800,
    twelveMinuteLimit: 8,
    yahooDailyLimit: 100
  });

  const originalFetch = global.fetch;
  const seenUrls = [];
  global.fetch = async (url) => {
    const value = String(url);
    seenUrls.push(value);

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
            close: "205.22",
            percent_change: "0.80",
            previous_close: "203.60",
            high: "206.00",
            low: "202.00",
            volume: "1800",
            datetime: "2026-03-16 18:45:00",
            market_state: "REGULAR"
          },
          {
            symbol: "BA",
            close: "206.11",
            percent_change: "1.10",
            previous_close: "203.60",
            high: "206.50",
            low: "202.00",
            volume: "1801",
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
      provider: "twelve",
      fallbackProvider: "yahoo",
      twelveApiKey: "demo",
      twelveBaseUrl: "https://api.twelvedata.com",
      yahooBaseUrl: "https://finance.yahoo.com",
      yahooUserAgent: "ogid/1.0",
      tickers: ["GD", "GD", "BA"],
      timeoutMs: 500
    });

    assert.equal(result.sourceMode, "live");
    assert.deepEqual(Object.keys(result.quotes).sort(), ["BA", "GD"]);
    assert.equal(result.quotes.GD.sourceDetail, "twelve");
    assert.equal(result.quotes.BA.sourceDetail, "twelve");
    assert.equal(result.sourceMeta.providerChain, "twelve+yahoo");
    assert.equal(result.sourceMeta.effectiveProvider, "twelve");
    assert.equal(result.sourceMeta.providerSlots[0].status, "ok");
    assert.equal(result.sourceMeta.providerSlots[1].status, "idle");
    assert.equal(result.sourceMeta.providerSlots[0].requestUrls.length, 1);
    assert.ok(seenUrls.some((value) => value.includes("api.twelvedata.com/quote")));
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

test("market provider router falls back from twelve to yahoo and records provider slots", async () => {
  apiQuotaTracker.reset({
    twelveDailyLimit: 800,
    twelveMinuteLimit: 8,
    yahooDailyLimit: 100
  });

  const originalFetch = global.fetch;
  const seenUrls = [];
  global.fetch = async (url) => {
    const value = String(url);
    seenUrls.push(value);

    if (value.includes("api.twelvedata.com/quote")) {
      return jsonResponse(
        {
          status: "error",
          code: 401,
          message: "apikey parameter is incorrect or not specified."
        },
        200
      );
    }

    if (value.includes("finance.yahoo.com/quote/GD")) {
      return htmlResponse(
        buildYahooQuoteHtml({
          ticker: "GD",
          price: 300.5,
          previousClose: 299.75,
          changePercent: 0.25,
          high: 301.2,
          low: 298.8,
          volume: 1200
        })
      );
    }

    if (value.includes("finance.yahoo.com/quote/BA")) {
      return htmlResponse(
        buildYahooQuoteHtml({
          ticker: "BA",
          price: 200.25,
          previousClose: 198.66,
          changePercent: 0.8,
          high: 201,
          low: 199,
          volume: 1100
        })
      );
    }

    return jsonResponse({}, 404);
  };

  try {
    const result = await fetchMarketQuotes({
      provider: "twelve",
      fallbackProvider: "yahoo",
      twelveApiKey: "demo",
      twelveBaseUrl: "https://api.twelvedata.com",
      yahooBaseUrl: "https://finance.yahoo.com",
      yahooUserAgent: "ogid/1.0",
      tickers: ["GD", "BA"],
      timeoutMs: 500
    });

    assert.ok(seenUrls.some((value) => value.includes("api.twelvedata.com/quote")));
    assert.ok(seenUrls.some((value) => value.includes("finance.yahoo.com/quote/GD")));
    assert.ok(seenUrls.some((value) => value.includes("finance.yahoo.com/quote/BA")));
    assert.equal(result.sourceMode, "live");
    assert.equal(result.quotes.GD.sourceDetail, "yahoo");
    assert.equal(result.quotes.BA.sourceDetail, "yahoo");
    assert.equal(result.sourceMeta.effectiveProvider, "yahoo");
    assert.equal(result.sourceMeta.providerSlots[0].provider, "twelve");
    assert.equal(result.sourceMeta.providerSlots[0].status, "error");
    assert.equal(result.sourceMeta.providerSlots[1].provider, "yahoo");
    assert.equal(result.sourceMeta.providerSlots[1].status, "ok");
    assert.equal(result.sourceMeta.providerSlots[1].requestUrls.length, 2);
    assert.equal(result.sourceMeta.providerSlots[1].transport, "web");
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

test("market provider router skips twelve when minute credits cannot cover the whole lot and falls back to yahoo", async () => {
  apiQuotaTracker.reset({
    twelveDailyLimit: 800,
    twelveDailyBudget: 600,
    twelveMinuteLimit: 8
  });
  apiQuotaTracker.recordCall("twelve", {
    status: "success",
    headers: {
      "api-credits-used": "7",
      "api-credits-left": "1"
    },
    units: 7
  });

  const tickers = ["GD", "BA", "NOC", "LMT", "RTX", "XOM", "CVX"];
  const originalFetch = global.fetch;
  let twelveCalls = 0;
  const seenYahooUrls = [];
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("api.twelvedata.com/quote")) {
      twelveCalls += 1;
      return jsonResponse({}, 404);
    }
    if (value.includes("finance.yahoo.com/quote/")) {
      seenYahooUrls.push(value);
      const ticker = value.split("/quote/")[1]?.split(/[/?#]/)[0] || "GD";
      return htmlResponse(
        buildYahooPriceOnlyHtml({
          ticker,
          price: 200 + seenYahooUrls.length
        })
      );
    }
    return jsonResponse({}, 404);
  };

  try {
    const result = await fetchMarketQuotes({
      provider: "twelve",
      fallbackProvider: "yahoo",
      twelveApiKey: "demo",
      twelveBaseUrl: "https://api.twelvedata.com",
      yahooBaseUrl: "https://finance.yahoo.com",
      yahooUserAgent: "ogid/1.0",
      tickers,
      timeoutMs: 500,
      requestReserve: 1
    });

    assert.equal(twelveCalls, 0);
    assert.equal(seenYahooUrls.length, tickers.length);
    assert.equal(result.sourceMode, "live");
    assert.equal(result.sourceMeta.effectiveProvider, "yahoo");
    assert.equal(result.sourceMeta.providersSkipped[0].provider, "twelve");
    assert.equal(result.sourceMeta.providersSkipped[0].reason, "insufficient-minute-credits");
    assert.equal(result.sourceMeta.providersSkipped[0].skipWindow, "minute");
    assert.equal(result.sourceMeta.providersSkipped[0].estimatedUnits, tickers.length);
    assert.equal(result.sourceMeta.providersSkipped[0].remainingMinute, 1);
    assert.equal(result.sourceMeta.providerSlots[0].status, "skipped");
    assert.equal(result.sourceMeta.providerSlots[0].errorCode, "insufficient-minute-credits");
    assert.equal(result.sourceMeta.providerSlots[0].skipWindow, "minute");
    assert.equal(result.sourceMeta.providerSlots[0].estimatedUnits, tickers.length);
    assert.equal(result.sourceMeta.providerSlots[1].status, "ok");
    assert.deepEqual(result.sourceMeta.providerSlots[1].returnedTickers.sort(), [...tickers].sort());
  } finally {
    global.fetch = originalFetch;
  }
});

test("market provider router uses stale quotes before deterministic fallback when providers are exhausted", async () => {
  apiQuotaTracker.reset({
    twelveDailyLimit: 1,
    twelveMinuteLimit: 1,
    yahooDailyLimit: 2
  });
  apiQuotaTracker.recordCall("twelve", { status: "success", units: 1 });
  apiQuotaTracker.recordCall("yahoo", { status: "success", units: 2 });

  const result = await fetchMarketQuotes({
    provider: "twelve",
    fallbackProvider: "yahoo",
    twelveApiKey: "demo",
    yahooBaseUrl: "https://finance.yahoo.com",
    tickers: ["GD", "BA"],
    timeoutMs: 500,
    staleTtlMs: 60_000,
    requestReserve: 0,
    previousQuotes: {
      GD: {
        price: 299.5,
        changePct: 0.5,
        asOf: new Date().toISOString(),
        source: "twelve",
        synthetic: false,
        dataMode: "live",
        sourceDetail: "twelve"
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
    ["twelve", "yahoo"]
  );
  assert.equal(result.sourceMeta.providerSlots[0].status, "skipped");
  assert.equal(result.sourceMeta.providerSlots[1].status, "skipped");
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
