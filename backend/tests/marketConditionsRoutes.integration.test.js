import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../server.js";

function fixtureSnapshot({ windowMin, countries }) {
  return {
    schemaVersion: "market-conditions-snapshot-v1",
    methodVersion: "market-conditions-v1.1",
    generatedAt: "2026-08-02T12:00:00.000Z",
    revisions: { news: 4, market: 7, awareness: 2, watchlist: "fixture", candles: "fixture" },
    window: { minutes: windowMin, label: `${windowMin}m`, from: null, to: null, indicatorInterval: "5min" },
    filters: { countries },
    market: { stabilityScore: null, band: "insufficient", components: [], drivers: [] },
    symbols: [],
    countryContext: { contextWindow: "current-intelligence-cycle", items: [] },
    quality: { status: "insufficient_data", coveragePct: 0, limitations: ["No local candles."] },
    sourceSummary: [],
    limitations: ["Decision support only."]
  };
}

test("market conditions route accepts only supported windows and stays local", async () => {
  const calls = [];
  const marketConditionsService = {
    getSnapshot(options) {
      calls.push(options);
      return fixtureSnapshot(options);
    }
  };
  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    marketConditionsService,
    market: { enabled: false, provider: "", fallbackProvider: "", historyPersist: false }
  });

  await runtime.start();
  try {
    const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    for (const windowMin of [15, 60, 240, 1_440]) {
      const response = await fetch(`${baseUrl}/api/market/conditions?windowMin=${windowMin}&countries=US,IL`);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.data.window.minutes, windowMin);
      assert.deepEqual(payload.data.filters.countries, ["US", "IL"]);
    }

    const invalid = await fetch(`${baseUrl}/api/market/conditions?windowMin=30`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_MARKET_CONDITIONS_WINDOW");

    const unexpected = await fetch(`${baseUrl}/api/market/conditions?windowMin=240&tickers=SPY`);
    assert.equal(unexpected.status, 404);
    assert.equal(calls.length, 4);
  } finally {
    await runtime.stop();
  }
});
