import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MarketWatchlistService } from "../services/market/marketWatchlistService.js";
import { TWELVE_BASIC_POLICY } from "../services/market/marketCreditScheduler.js";

test("watchlist loads configured instruments and promotes selected verified mappings", () => {
  const service = new MarketWatchlistService({ rolloutBatch: 3, initialReferences: ["GOOGL", "MSFT", "QQQ", "NVDA", "AAPL", "AMD", "ORCL"], creditPolicy: TWELVE_BASIC_POLICY });
  const snapshot = service.snapshot();
  assert.deepEqual(snapshot.selectedSymbols, ["GOOGL", "MSFT", "QQQ", "NVDA", "AAPL", "AMD", "ORCL"]);
  assert.equal(service.selectedInstruments().every((item) => item.refreshTier === "hot"), true);
  assert.equal(snapshot.projection.creditsPerMinuteWorstCase, 7);
  assert.ok(snapshot.projection.baselineCreditsPerDay <= TWELVE_BASIC_POLICY.normalSoftLimit);
});

test("watchlist rejects unknown instruments and accepts an eighth verified instrument", async () => {
  const service = new MarketWatchlistService({ rolloutBatch: 3, initialReferences: ["GD"] });
  await assert.rejects(service.update(["GD", "UNKNOWN"]), /enabled verified/);
  await service.update(["GD", "BA", "NOC", "LMT", "RTX", "XOM", "CVX", "AAPL"]);
  assert.deepEqual(service.selectedSymbols(), ["GD", "BA", "NOC", "LMT", "RTX", "XOM", "CVX", "AAPL"]);
  assert.equal(service.snapshot().maxSelected, null);
});

test("watchlist retains an explicit optional selection limit", async () => {
  const service = new MarketWatchlistService({ rolloutBatch: 3, initialReferences: ["GD"], maxSelected: 2 });
  await assert.rejects(service.update(["GD", "BA", "NOC"]), /up to 2/);
  assert.deepEqual(service.selectedSymbols(), ["GD"]);
});

test("watchlist selection survives restart through atomic persistence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ogid-watchlist-"));
  const persistencePath = path.join(directory, "selection.json");
  try {
    const first = new MarketWatchlistService({ rolloutBatch: 3, initialReferences: ["GD"], persistencePath });
    await first.update(["BTC/USD", "GOOGL"]);
    const restarted = new MarketWatchlistService({ rolloutBatch: 3, initialReferences: ["GD"], persistencePath });
    assert.deepEqual(restarted.selectedSymbols(), ["BTC/USD", "GOOGL"]);
    assert.equal(restarted.selectedInstruments().find((item) => item.canonicalSymbol === "BTC/USD").minRefreshIntervalMs, 14_400_000);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("watchlist verifies and persists a dynamic Yahoo search candidate", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ogid-watchlist-dynamic-"));
  const persistencePath = path.join(directory, "selection.json");
  const candidate = { instrumentId: "yahoo-tsla-test", symbol: "TSLA", canonicalSymbol: "TSLA", displayName: "Tesla, Inc.", assetType: "equity", exchange: "Nasdaq", currency: "USD", sector: "Consumer Cyclical", industry: "Auto Manufacturers" };
  try {
    const service = new MarketWatchlistService({ persistencePath, instrumentResolver: async () => ({ instrumentId: candidate.instrumentId, canonicalSymbol: "TSLA", symbol: "TSLA", displayName: "TSLA", assetType: "equity", sector: null, industry: null, timezone: "America/New_York", country: "US", providerSymbols: { yahoo: "TSLA" }, aliases: ["TSLA"], metadataSource: { provider: "test" }, verificationStatus: "verified", enabled: true }) });
    service.rememberCandidates([candidate]);
    const saved = await service.update([candidate.instrumentId]);
    assert.deepEqual(saved.selectedSymbols, ["TSLA"]);
    const restarted = new MarketWatchlistService({ persistencePath });
    assert.deepEqual(restarted.selectedSymbols(), ["TSLA"]);
    assert.equal(restarted.selectedInstruments()[0].sector, "Consumer Cyclical");
    assert.equal(restarted.selectedInstruments()[0].industry, "Auto Manufacturers");
    assert.equal(restarted.selectedInstruments()[0].exchange, "Nasdaq");
    assert.equal(restarted.selectedInstruments()[0].currency, "USD");
    assert.equal(restarted.selectedInstruments()[0].displayName, "Tesla, Inc.");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
