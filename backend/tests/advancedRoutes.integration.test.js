import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../server.js";

test("advanced map and intelligence routes return bounded additive payloads", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const value = String(url);
    if (value.includes("127.0.0.1") || value.includes("localhost")) {
      return originalFetch(url, options);
    }

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <item>
            <title>Cyber protest escalates in Kyiv</title>
            <description>Missile defense units remain on alert.</description>
            <link>https://example.com/kyiv</link>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
        </channel>
      </rss>`,
      {
        status: 200,
        headers: {
          "content-type": "application/xml"
        }
      }
    );
  };

  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    news: {
      newsApiKey: "",
      rssFeeds: [{ label: "Test Feed", url: "https://example.com/rss.xml" }],
      timeoutMs: 200
    },
    market: {
      refreshIntervalMs: 300_000,
      apiKey: "",
      fmpApiKey: "",
      requestReserve: 0
    }
  });

  await runtime.start();

  try {
    await runtime.orchestrator.runCycle("advanced-routes-bootstrap");
    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const configResponse = await fetch(`${baseUrl}/api/map/config`);
    const configPayload = await configResponse.json();
    assert.equal(configResponse.status, 200);
    assert.equal(configPayload.ok, true);
    assert.equal(configPayload.data.layers.length, 45);

    const layersResponse = await fetch(`${baseUrl}/api/map/layers?layers=conflicts,cyber_incidents&timeWindow=24h`);
    const layersPayload = await layersResponse.json();
    assert.equal(layersResponse.status, 200);
    assert.equal(layersPayload.ok, true);
    assert.equal(layersPayload.data.layers.length, 2);

    const aggregateResponse = await fetch(`${baseUrl}/api/news/aggregate?limit=20`);
    const aggregatePayload = await aggregateResponse.json();
    assert.equal(aggregateResponse.status, 200);
    assert.equal(aggregatePayload.ok, true);
    assert.ok(aggregatePayload.data.meta.catalogSize >= 435);

    const ciiResponse = await fetch(`${baseUrl}/api/country-instability`);
    const ciiPayload = await ciiResponse.json();
    assert.equal(ciiResponse.status, 200);
    assert.equal(ciiPayload.ok, true);
    assert.ok(Array.isArray(ciiPayload.data.ranking));

    const hotspotsResponse = await fetch(`${baseUrl}/api/intel/hotspots-v2`);
    const hotspotsPayload = await hotspotsResponse.json();
    assert.equal(hotspotsResponse.status, 200);
    assert.equal(hotspotsPayload.ok, true);
    assert.ok(Array.isArray(hotspotsPayload.data.hotspots));

    const anomaliesResponse = await fetch(`${baseUrl}/api/intel/anomalies`);
    const anomaliesPayload = await anomaliesResponse.json();
    assert.equal(anomaliesResponse.status, 200);
    assert.equal(anomaliesPayload.ok, true);
    assert.ok(Array.isArray(anomaliesPayload.data.items));
  } finally {
    global.fetch = originalFetch;
    await runtime.stop();
  }
});
