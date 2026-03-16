import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { MarketHistoryStore } from "../services/market/marketHistoryStore.js";

test("market history store persists snapshot and per-ticker history, then hydrates state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ogid-market-history-"));
  const store = new MarketHistoryStore({
    enabled: true,
    rootDir: tempRoot,
    tickers: ["GD", "BA"]
  });

  const marketState = {
    provider: "web+fmp",
    sourceMode: "live",
    sourceMeta: {
      provider: "web+fmp",
      effectiveProvider: "web",
      configuredProvider: "web",
      configuredFallbackProvider: "fmp",
      coverageByMode: {
        live: 1,
        webDelayed: 1,
        historicalEod: 0,
        routerStale: 0,
        syntheticFallback: 0
      }
    },
    updatedAt: "2026-03-16T18:45:00.000Z",
    quotes: {
      GD: {
        price: 300.5,
        changePct: 0.5,
        asOf: "2026-03-16T18:45:00.000Z",
        source: "web",
        synthetic: false,
        dataMode: "web-delayed"
      },
      BA: {
        price: 205.22,
        changePct: 0.8,
        asOf: "2026-03-16T18:45:00.000Z",
        source: "fmp",
        synthetic: false,
        dataMode: "live"
      }
    }
  };

  try {
    await store.persistMarketState({}, marketState);
    await store.persistMarketState(marketState, marketState);

    const loaded = await store.loadMarketState();
    assert.ok(loaded);
    assert.equal(loaded.provider, "web+fmp");
    assert.equal(loaded.quotes.GD.price, 300.5);
    assert.equal(loaded.quotes.BA.source, "fmp");
    assert.equal(Array.isArray(loaded.timeseries.GD), true);
    assert.equal(loaded.timeseries.GD.length, 1);
    assert.equal(loaded.timeseries.BA.length, 1);

    let hydratedMarket = null;
    const fakeStateManager = {
      hydrateMarketState(value) {
        hydratedMarket = value;
      }
    };
    await store.hydrateState(fakeStateManager);

    assert.ok(hydratedMarket);
    assert.equal(hydratedMarket.quotes.GD.dataMode, "web-delayed");
    assert.equal(hydratedMarket.timeseries.GD[0].price, 300.5);
    assert.ok(store.getStatus().lastSavedAt);
    assert.ok(store.getStatus().lastLoadedAt);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
