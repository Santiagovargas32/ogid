import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppServer } from "../server.js";

const tsla = {
  instrumentId: "yahoo-tsla-test",
  symbol: "TSLA",
  canonicalSymbol: "TSLA",
  displayName: "Tesla, Inc.",
  assetType: "equity",
  sector: "Consumer Cyclical",
  industry: "Auto Manufacturers",
  exchange: "Nasdaq",
  mic: null,
  currency: "USD",
  timezone: "America/New_York",
  country: "US",
  enabled: true,
  rolloutBatch: 1,
  refreshTier: "background",
  minRefreshIntervalMs: 23_400_000,
  verificationStatus: "verified",
  sessionPolicy: "exchange-hours",
  providerSymbols: { yahoo: "TSLA" },
  aliases: ["TSLA"],
  metadataSource: { provider: "test" },
};

test("dynamic market API searches, persists a selection and serves Yahoo-backed OHLCV", async () => {
  const historyDir = mkdtempSync(join(tmpdir(), "ogid-market-dynamic-"));
  let runtime;
  const marketDataService = {
    searchSymbols: async () => [tsla],
    resolveInstrument: async () => tsla,
    fetchYahooBars: async () => {
      await runtime.app.locals.dailyCandleStore.upsert([{
        schemaVersion: 1,
        instrumentId: tsla.instrumentId,
        interval: "1day",
        openTime: "2026-07-14T00:00:00.000Z",
        closeTime: "2026-07-15T00:00:00.000Z",
        open: 310,
        high: 320,
        low: 305,
        close: 318,
        volume: 1_000,
        currency: "USD",
        exchange: "Nasdaq",
        session: "exchange-hours",
        source: "yahoo",
        providerSymbol: "TSLA",
        fetchedAt: "2026-07-16T12:00:00.000Z",
        adjusted: true,
        dataMode: "observed",
        quality: "valid",
        methodVersion: "daily-candle-v1",
        provenance: { provider: "yahoo", providerSymbol: "TSLA", adjustmentMode: "splits", fetchedAt: "2026-07-16T12:00:00.000Z" },
      }], { now: new Date("2026-07-16T12:00:00.000Z") });
      return { stale: false, cached: false, error: null, bars: [] };
    },
  };
  runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    marketDataService,
    market: { provider: "yahoo", fallbackProvider: "", tickers: [], historyDir, historyPersist: false, dailyCandles: { enabled: true, adjustmentMode: "splits", retentionDays: 3650, backfillMaxDays: 30 } },
  });
  await runtime.start();
  try {
    const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    const search = await fetch(`${baseUrl}/api/market/instruments/search?q=Tesla&limit=5`).then((response) => response.json());
    assert.equal(search.data.instruments[0].instrumentId, tsla.instrumentId);

    const updateResponse = await fetch(`${baseUrl}/api/market/watchlist`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instrumentIds: [tsla.instrumentId] }),
    });
    const update = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.deepEqual(update.data.selectedSymbols, ["TSLA"]);
    assert.equal(update.data.instruments[0].sector, "Consumer Cyclical");

    const candlesResponse = await fetch(`${baseUrl}/api/market/candles?instrumentId=${tsla.instrumentId}&interval=1day&limit=20`);
    const candles = await candlesResponse.json();
    assert.equal(candlesResponse.status, 200);
    assert.equal(candles.data.status, "fresh");
    assert.equal(candles.data.candles[0].close, 318);
  } finally {
    await runtime.stop();
    rmSync(historyDir, { recursive: true, force: true });
  }
});
