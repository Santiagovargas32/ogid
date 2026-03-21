import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { MarketHistoryStore } from "../services/market/marketHistoryStore.js";

test("market history store persists snapshot and per-ticker history, then hydrates state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ogid-market-history-"));
  const store = new MarketHistoryStore({
    enabled: true,
    rootDir: tempRoot,
    tickers: ["GD", "BA"]
  });

  const marketState = {
    provider: "twelve+yahoo",
    sourceMode: "live",
    sourceMeta: {
      provider: "twelve+yahoo",
      providerChain: "twelve+yahoo",
      effectiveProvider: "twelve",
      configuredProvider: "twelve",
      configuredFallbackProvider: "yahoo",
      coverageByMode: {
        live: 2,
        webDelayed: 0,
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
        source: "twelve",
        synthetic: false,
        dataMode: "live"
      },
      BA: {
        price: 205.22,
        changePct: 0.8,
        asOf: "2026-03-16T18:45:00.000Z",
        source: "yahoo",
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
    assert.equal(loaded.provider, "twelve+yahoo");
    assert.equal(loaded.quotes.GD.price, 300.5);
    assert.equal(loaded.quotes.BA.source, "yahoo");
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
    assert.equal(hydratedMarket.quotes.GD.dataMode, "live");
    assert.equal(hydratedMarket.timeseries.GD[0].price, 300.5);
    assert.ok(store.getStatus().lastSavedAt);
    assert.ok(store.getStatus().lastLoadedAt);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("market history store skips fallback-only snapshots and persists only provider-backed quotes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ogid-market-history-"));
  const store = new MarketHistoryStore({
    enabled: true,
    rootDir: tempRoot,
    tickers: ["GD", "BA"]
  });

  const fallbackOnlyState = {
    provider: "twelve+yahoo",
    sourceMode: "fallback",
    sourceMeta: {
      provider: "twelve+yahoo"
    },
    updatedAt: "2026-03-16T18:50:00.000Z",
    session: {
      open: false,
      state: "closed",
      checkedAt: "2026-03-16T18:50:00.000Z",
      timezone: "America/New_York"
    },
    quotes: {
      GD: {
        price: 300.5,
        changePct: 0.5,
        asOf: "2026-03-16T18:50:00.000Z",
        source: "twelve",
        sourceDetail: "twelve",
        synthetic: false,
        dataMode: "router-stale"
      },
      BA: {
        price: 205.22,
        changePct: 0.8,
        asOf: "2026-03-16T18:50:00.000Z",
        source: "fallback",
        synthetic: true,
        dataMode: "synthetic-fallback"
      }
    }
  };

  const mixedState = {
    ...fallbackOnlyState,
    sourceMode: "mixed",
    sourceMeta: {
      provider: "twelve+yahoo"
    },
    updatedAt: "2026-03-16T19:00:00.000Z",
    session: {
      open: true,
      state: "open",
      checkedAt: "2026-03-16T19:00:00.000Z",
      timezone: "America/New_York"
    },
    quotes: {
      GD: {
        price: 301.15,
        changePct: 0.72,
        asOf: "2026-03-16T19:00:00.000Z",
        source: "twelve",
        sourceDetail: "twelve",
        synthetic: false,
        dataMode: "live"
      },
      BA: {
        price: 205.22,
        changePct: 0.8,
        asOf: "2026-03-16T18:50:00.000Z",
        source: "fallback",
        synthetic: true,
        dataMode: "synthetic-fallback"
      }
    }
  };

  try {
    const skippedStatus = await store.persistMarketState({}, fallbackOnlyState);
    assert.equal(skippedStatus.lastPersistenceEligible, false);
    assert.equal(skippedStatus.lastSkipReason, "fallback-only");

    const skippedSnapshot = await store.loadSnapshot();
    assert.equal(skippedSnapshot, null);

    await store.persistMarketState(fallbackOnlyState, mixedState, { trigger: "manual-market-refresh" });

    const loaded = await store.loadMarketState();
    assert.ok(loaded);
    assert.deepEqual(Object.keys(loaded.quotes), ["GD"]);
    assert.equal(loaded.quotes.GD.sourceDetail, "twelve");
    assert.equal(loaded.sourceMeta.persistenceEligible, true);
    assert.equal(loaded.sourceMeta.persistReason, "startup-provider-backed");
    assert.deepEqual(loaded.sourceMeta.persistence.providerBackedTickers, ["GD"]);
    assert.equal(loaded.timeseries.GD.length, 1);
    assert.equal(loaded.timeseries.BA.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("market history store ignores snapshots from the legacy provider schema", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ogid-market-history-"));
  const store = new MarketHistoryStore({
    enabled: true,
    rootDir: tempRoot,
    tickers: ["GD"]
  });

  try {
    await store.ensureDirectories();
    await writeFile(
      path.join(tempRoot, "snapshot.json"),
      JSON.stringify({
        provider: "web+fmp",
        sourceMeta: {
          provider: "web+fmp"
        },
        tickers: ["GD"],
        quotes: {
          GD: {
            price: 300.5,
            changePct: 0.5,
            asOf: "2026-03-16T18:45:00.000Z",
            source: "web",
            dataMode: "live"
          }
        }
      }),
      "utf8"
    );

    const loaded = await store.loadMarketState();
    assert.equal(loaded, null);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
