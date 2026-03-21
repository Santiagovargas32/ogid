import test from "node:test";
import assert from "node:assert/strict";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { fetchYahooQuotes } from "../services/market/providers/yahooProvider.js";

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

test("yahoo provider parses embedded quote payloads from page HTML", async () => {
  apiQuotaTracker.reset({
    yahooDailyLimit: 10
  });

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);
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

    return htmlResponse("<html></html>", 404);
  };

  try {
    const result = await fetchYahooQuotes({
      baseUrl: "https://finance.yahoo.com",
      userAgent: "ogid/1.0",
      tickers: ["GD"],
      timeoutMs: 500,
      timestamp: "2026-03-16T18:45:00.000Z",
      session: { open: true, state: "open", checkedAt: "2026-03-16T18:45:00.000Z" }
    });

    assert.deepEqual(Object.keys(result.quotes), ["GD"]);
    assert.equal(result.quotes.GD.source, "yahoo");
    assert.equal(result.quotes.GD.price, 300.5);
    assert.equal(result.quotes.GD.previousClose, 299.75);
    assert.equal(result.returnedTickers[0], "GD");
    assert.equal(result.errors.length, 0);
    assert.equal(result.requestUrls.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("yahoo provider reports markup failures as parse errors", async () => {
  apiQuotaTracker.reset({
    yahooDailyLimit: 10
  });

  const originalFetch = global.fetch;
  global.fetch = async () => htmlResponse("<html><body>missing payload</body></html>");

  try {
    const result = await fetchYahooQuotes({
      baseUrl: "https://finance.yahoo.com",
      tickers: ["GD"],
      timeoutMs: 500
    });

    assert.equal(result.returnedTickers.length, 0);
    assert.equal(result.missingTickers[0], "GD");
    assert.equal(result.errors[0].code, "yahoo-embedded-json-missing");
  } finally {
    global.fetch = originalFetch;
  }
});

test("yahoo provider marks individual ticker failures while keeping successful pages", async () => {
  apiQuotaTracker.reset({
    yahooDailyLimit: 10
  });

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);
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
      return htmlResponse("<html><body>broken</body></html>");
    }
    return htmlResponse("<html></html>", 404);
  };

  try {
    const result = await fetchYahooQuotes({
      baseUrl: "https://finance.yahoo.com",
      userAgent: "ogid/1.0",
      tickers: ["GD", "BA"],
      timeoutMs: 500
    });

    assert.deepEqual(Object.keys(result.quotes), ["GD"]);
    assert.deepEqual(result.missingTickers, ["BA"]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, "yahoo-embedded-json-missing");
  } finally {
    global.fetch = originalFetch;
  }
});

test("yahoo provider reports timeouts as request failures", async () => {
  apiQuotaTracker.reset({
    yahooDailyLimit: 10
  });

  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        const error = new Error("Aborted");
        error.name = "AbortError";
        reject(error);
      };

      if (options.signal?.aborted) {
        abort();
        return;
      }

      options.signal?.addEventListener("abort", abort, { once: true });
      setTimeout(() => resolve(htmlResponse("<html></html>")), 100);
    });

  try {
    const result = await fetchYahooQuotes({
      baseUrl: "https://finance.yahoo.com",
      tickers: ["GD"],
      timeoutMs: 10
    });

    assert.equal(result.errors[0].code, "yahoo-timeout");
    assert.equal(result.returnedTickers.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
