import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../server.js";

test("REST API exposes health and snapshot payloads", async () => {
  const runtime = createAppServer({
    port: 0,
    refreshIntervalMs: 300_000,
    market: { refreshIntervalMs: 300_000, apiKey: "" },
    news: { newsApiKey: "" },
    apiLimits: {
      newsapiDailyLimit: 10,
      gnewsDailyLimit: 10,
      mediastackDailyLimit: 10,
      alphavantageDailyLimit: 10
    }
  });

  await runtime.start();

  try {
    await runtime.orchestrator.runCycle("test-bootstrap");
    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const healthPayload = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.data.status, "ok");

    const snapshotResponse = await fetch(`${baseUrl}/api/intel/snapshot?countries=US,IL,IR`);
    const snapshotPayload = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotPayload.ok, true);
    assert.ok(Array.isArray(snapshotPayload.data.hotspots));
    assert.ok(snapshotPayload.data.hotspots.length <= 3);
    assert.equal(snapshotPayload.data.meta.sourceMode, "fallback");
    assert.ok(snapshotPayload.data.meta.dataQuality);
    assert.ok(snapshotPayload.data.predictions);

    const quotesResponse = await fetch(`${baseUrl}/api/market/quotes?tickers=GD,BA,NOC`);
    const quotesPayload = await quotesResponse.json();
    assert.equal(quotesResponse.status, 200);
    assert.equal(quotesPayload.ok, true);
    assert.ok(quotesPayload.data.quotes.GD);

    const newsResponse = await fetch(`${baseUrl}/api/intel/news?countries=US,IL,IR&limit=25&sources=fallback`);
    const newsPayload = await newsResponse.json();
    assert.equal(newsResponse.status, 200);
    assert.equal(newsPayload.ok, true);
    assert.ok(Array.isArray(newsPayload.data.news));
    assert.ok(newsPayload.data.news.every((article) => article.dataMode === "fallback"));
    assert.ok(
      newsPayload.data.news.every((article) =>
        (article.countryMentions || []).some((iso2) => ["US", "IL", "IR"].includes(iso2))
      )
    );

    const impactResponse = await fetch(`${baseUrl}/api/market/impact?tickers=GD,BA,NOC&countries=US,IL,IR`);
    const impactPayload = await impactResponse.json();
    assert.equal(impactResponse.status, 200);
    assert.equal(impactPayload.ok, true);
    assert.ok(Array.isArray(impactPayload.data.impact.items));
    assert.ok(Array.isArray(impactPayload.data.impact.sectorBreakdown));
    assert.ok(Array.isArray(impactPayload.data.impact.scatterPoints));

    const analyticsResponse = await fetch(`${baseUrl}/api/market/analytics?tickers=GD,BA,NOC&countries=US,IL,IR`);
    const analyticsPayload = await analyticsResponse.json();
    assert.equal(analyticsResponse.status, 200);
    assert.equal(analyticsPayload.ok, true);
    assert.ok(Array.isArray(analyticsPayload.data.impactHistory));
    assert.ok(Array.isArray(analyticsPayload.data.sectorBreakdown));
    assert.ok(Array.isArray(analyticsPayload.data.scatterPoints));
    assert.ok(Array.isArray(analyticsPayload.data.couplingSeries));
    assert.ok(Array.isArray(analyticsPayload.data.predictedSectorDirection));
    assert.ok(Array.isArray(analyticsPayload.data.tickerOutlookMatrix));
    assert.ok(analyticsPayload.data.predictions);

    const limitsResponse = await fetch(`${baseUrl}/api/admin/api-limits`);
    const limitsPayload = await limitsResponse.json();
    assert.equal(limitsResponse.status, 200);
    assert.equal(limitsPayload.ok, true);
    assert.equal(Array.isArray(limitsPayload.data.providers), true);
    assert.ok(limitsPayload.data.providers.some((provider) => provider.provider === "newsapi"));
  } finally {
    await runtime.stop();
  }
});
