import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { MarketHistoryStore } from "../services/market/marketHistoryStore.js";
import stateManager from "../state/stateManager.js";

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
        dataMode: "observed"
      },
      BA: {
        price: 205.22,
        changePct: 0.8,
        asOf: "2026-03-16T18:45:00.000Z",
        source: "yahoo",
        synthetic: false,
        dataMode: "observed"
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
    assert.equal(hydratedMarket.quotes.GD.dataMode, "observed");
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
        dataMode: "stale"
      },
      BA: {
        price: 205.22,
        changePct: 0.8,
        asOf: "2026-03-16T18:50:00.000Z",
        source: "fallback",
        synthetic: true,
        dataMode: "synthetic"
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
        dataMode: "observed"
      },
      BA: {
        price: 205.22,
        changePct: 0.8,
        asOf: "2026-03-16T18:50:00.000Z",
        source: "fallback",
        synthetic: true,
        dataMode: "synthetic"
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

test("market history store sanitizes legacy request credentials on load and at rest", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ogid-market-history-"));
  const store = new MarketHistoryStore({ enabled: true, rootDir: tempRoot, tickers: [] });
  try {
    await store.ensureDirectories();
    await writeFile(path.join(tempRoot, "snapshot.json"), JSON.stringify({
      providerSchemaVersion: 3,
      provider: "market-router",
      sourceMeta: { requestUrl: "https://example.test/quotes?apikey=legacy-secret" },
      tickers: [],
      quotes: {}
    }), "utf8");
    const loaded = await store.loadSnapshot();
    assert.equal(new URL(loaded.sourceMeta.requestUrl).searchParams.get("apikey"), "***");
    const persisted = await readFile(path.join(tempRoot, "snapshot.json"), "utf8");
    assert.equal(persisted.includes("legacy-secret"), false);
    assert.equal(persisted.includes("apikey=***"), true);
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
});

test("changing the watchlist prunes restored market state and fails closed on derived projections", () => {
  stateManager.reset({ marketTickers: ["GD", "BA"] });
  stateManager.hydrateMarketState({
    revision: "stale-revision",
    updatedAt: "2026-07-10T12:00:00Z",
    sourceMeta: {
      provider: "market-router",
      totalTickers: 2,
      unresolvedTickers: ["BA"],
      providerSlots: [{ returnedTickers: ["GD", "BA"] }],
    },
    quotes: { GD: { price: 300, source: "twelve", dataMode: "observed" }, BA: { price: 220, source: "twelve", dataMode: "observed" } },
    timeseries: {
      GD: [{ timestamp: "2026-07-10T12:00:00Z", price: 300 }],
      BA: [{ timestamp: "2026-07-10T12:00:00Z", price: 220 }],
    }
  });
  stateManager.updateIntel({
    predictions: {
      updatedAt: "2026-07-10T12:00:00Z",
      sectors: [{ sector: "industrials", tickers: ["GD", "BA"], score: 10 }],
      tickers: [{ ticker: "GD", predictionScore: 5 }, { ticker: "BA", predictionScore: 15 }],
      predictionScoreByTicker: { GD: 5, BA: 15 },
    },
    impact: {
      updatedAt: "2026-07-10T12:00:00Z",
      items: [
        { ticker: "GD", sector: "industrials", eventScore: 3, impactScore: 4 },
        { ticker: "BA", sector: "industrials", eventScore: 5, impactScore: 6 },
      ],
      sectorBreakdown: [{ sector: "industrials", tickers: ["GD", "BA"], itemCount: 2 }],
      scatterPoints: [{ ticker: "GD" }, { ticker: "BA" }],
      couplingSeries: [{ ticker: "GD" }, { ticker: "BA" }],
    },
    refreshedAt: "2026-07-10T12:00:00Z",
  });
  stateManager.setMarketTickers(["gd", "GD"]);
  const snapshot = stateManager.getSnapshot();
  assert.deepEqual(Object.keys(snapshot.market.quotes), ["GD"]);
  assert.deepEqual(Object.keys(snapshot.market.timeseries), ["GD"]);
  assert.deepEqual(snapshot.meta.marketTickers, ["GD"]);
  assert.equal(snapshot.market.revision, null);
  assert.equal(snapshot.market.updatedAt, null);
  assert.equal(snapshot.market.sourceMeta.reason, "watchlist-selection-changed");
  assert.deepEqual(snapshot.market.sourceMeta.requestedTickers, ["GD"]);
  assert.deepEqual(snapshot.market.sourceMeta.returnedTickers, ["GD"]);
  assert.equal(JSON.stringify(snapshot.market.sourceMeta).includes("BA"), false);
  assert.deepEqual(snapshot.predictions.sectors, []);
  assert.deepEqual(snapshot.predictions.tickers, []);
  assert.deepEqual(snapshot.predictions.predictionScoreByTicker, {});
  assert.deepEqual(snapshot.impact.items, []);
  assert.deepEqual(snapshot.impact.sectorBreakdown, []);
  assert.deepEqual(snapshot.impact.scatterPoints, []);
  assert.deepEqual(snapshot.impact.couplingSeries, []);
  assert.equal(snapshot.impactHistory.length, 1);
  assert.deepEqual(snapshot.impactHistory[0].items.map((item) => item.ticker), ["GD"]);
});

test("market history store migrates a recognized unversioned snapshot without making it live", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ogid-market-history-"));
  const store = new MarketHistoryStore({ enabled: true, rootDir: tempRoot, tickers: ["GD"] });
  try {
    await store.ensureDirectories();
    await writeFile(path.join(tempRoot, "snapshot.json"), JSON.stringify({
      provider: "market-router", updatedAt: "2025-01-02T15:00:00.000Z", tickers: ["GD", "UNKNOWN"],
      quotes: { GD: { price: 250.5, changePct: 1.2, asOf: "2025-01-02T14:59:00.000Z", source: "twelve", dataMode: "live" }, UNKNOWN: { price: 1 } }
    }), "utf8");
    const loaded = await store.loadMarketState();
    assert.equal(loaded.quotes.GD.price, 250.5);
    assert.equal(loaded.quotes.GD.asOf, "2025-01-02T14:59:00.000Z");
    assert.equal(loaded.quotes.GD.instrumentId, "us-equity-general-dynamics");
    assert.equal(loaded.quotes.GD.dataMode, "stale");
    assert.equal(loaded.quotes.UNKNOWN, undefined);
    assert.deepEqual(loaded.sourceMeta.unknownLegacySymbols, ["UNKNOWN"]);
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
});
