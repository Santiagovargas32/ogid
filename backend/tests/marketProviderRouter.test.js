import test from "node:test";
import assert from "node:assert/strict";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { fetchMarketQuotes } from "../services/market/marketProviderRouter.js";
import { resetFmpProviderStateForTests } from "../services/market/providers/fmpProvider.js";

test("market provider router returns deterministic fallback when web and fmp are unavailable", async () => {
  resetFmpProviderStateForTests();
  apiQuotaTracker.reset({
    webDailyLimit: 0,
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

test("market provider router merges delayed web quotes with fmp fallback", async () => {
  resetFmpProviderStateForTests();
  apiQuotaTracker.reset({
    webDailyLimit: 0,
    fmpDailyLimit: 250
  });

  const originalFetch = global.fetch;
  const seenUrls = [];
  global.fetch = async (url) => {
    const value = String(url);
    seenUrls.push(value);

    if (value.includes("stooq.com/q/l/")) {
      if (value.includes("s=gd.us%2Cba.us")) {
        return new Response(
          "Symbol,Date,Time,Open,High,Low,Close,Volume,Name",
          {
            status: 200,
            headers: { "content-type": "text/csv" }
          }
        );
      }

      if (value.includes("s=gd.us")) {
        return new Response(
          "Symbol,Date,Time,Open,High,Low,Close,Volume,Name\nGD.US,2026-03-16,18:45:00,300.00,301.00,299.00,300.50,1000,General Dynamics",
          {
            status: 200,
            headers: { "content-type": "text/csv" }
          }
        );
      }

      if (value.includes("s=ba.us")) {
        return new Response(
          "Symbol,Date,Time,Open,High,Low,Close,Volume,Name",
          {
            status: 200,
            headers: { "content-type": "text/csv" }
          }
        );
      }

      return new Response(
        "Symbol,Date,Time,Open,High,Low,Close,Volume,Name\nBA.US,2026-03-16,18:45:00,200.00,201.00,199.00,200.25,1100,Boeing",
        {
          status: 200,
          headers: { "content-type": "text/csv" }
        }
      );
    }

    if (value.includes("stooq.com/q/d/l/")) {
      return new Response(
        "Date,Open,High,Low,Close,Volume\n2026-03-14,296.00,299.00,295.00,298.00,1000\n2026-03-15,298.00,300.00,297.00,299.00,1100",
        {
          status: 200,
          headers: { "content-type": "text/csv" }
        }
      );
    }

    if (value.includes("/stable/batch-quote")) {
      return new Response(
        JSON.stringify([
          {
            symbol: "BA",
            price: 205.22,
            changePercentage: "(+0.80%)"
          }
        ]),
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
      provider: "web",
      fallbackProvider: "fmp",
      webSource: "stooq",
      webBaseUrl: "https://stooq.com",
      webUserAgent: "ogid/1.0",
      fmpApiKey: "test-key",
      fmpBaseUrl: "https://financialmodelingprep.com/api/v3",
      tickers: ["GD", "BA"],
      timeoutMs: 500
    });

    assert.ok(seenUrls.some((value) => value.includes("stooq.com/q/l/")));
    assert.ok(seenUrls.some((value) => value.includes("stooq.com/q/l/?s=gd.us&")));
    assert.ok(
      seenUrls.some((value) => value.includes("/stable/batch-quote") && value.includes("symbols=BA"))
    );
    assert.equal(result.sourceMode, "live");
    assert.equal(result.sourceMeta.totalTickers, 2);
    assert.equal(result.sourceMeta.effectiveProvider, "web");
    assert.deepEqual(result.sourceMeta.providersUsed, ["web", "fmp"]);
    assert.equal(result.quotes.GD.source, "web");
    assert.equal(result.quotes.GD.dataMode, "web-delayed");
    assert.equal(result.quotes.BA.source, "fmp");
    assert.equal(result.quotes.BA.dataMode, "live");
    assert.deepEqual(result.sourceMeta.coverageByMode, {
      live: 1,
      webDelayed: 1,
      historicalEod: 0,
      routerStale: 0,
      syntheticFallback: 0
    });
    assert.equal(result.sourceMeta.fallbackCount, 0);
    assert.equal(result.sourceMeta.providerDiagnostics.web.returnedTickers.includes("GD"), true);
    assert.equal(result.sourceMeta.providerDiagnostics.fmp.returnedTickers.includes("BA"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("market provider router uses stale quotes before deterministic fallback when providers are exhausted", async () => {
  resetFmpProviderStateForTests();
  apiQuotaTracker.reset({
    webDailyLimit: 1,
    fmpDailyLimit: 1
  });
  apiQuotaTracker.recordCall("web", { status: "success" });
  apiQuotaTracker.recordCall("fmp", { status: "success" });

  const result = await fetchMarketQuotes({
    provider: "web",
    fallbackProvider: "fmp",
    webSource: "stooq",
    fmpApiKey: "test-key",
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
        dataMode: "web-delayed"
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
