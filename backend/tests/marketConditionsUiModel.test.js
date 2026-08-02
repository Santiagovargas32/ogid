import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MARKET_CONDITIONS_WINDOW_MIN,
  availabilityReasonDetails,
  inputStatusLabel,
  normalizeAvailability,
  normalizeInputStatus,
  normalizeMarketConditions,
  normalizePressure,
  scoreAriaLabel,
  scoreDisplay
} from "../../frontend/js/marketConditionsModel.js";

function payload(overrides = {}) {
  return {
    schemaVersion: "market-conditions-snapshot-v1",
    methodVersion: "market-conditions-v1",
    generatedAt: "2026-08-02T12:00:00.000Z",
    revisions: { news: 4, market: 8 },
    window: { minutes: 240, label: "4h", indicatorInterval: "1h" },
    quality: {
      status: "observed",
      coveragePct: 88,
      latestNewsAgeMin: 9,
      latestCandleAgeMin: 12
    },
    market: {
      stabilityScore: 74,
      band: "favorable",
      components: [{ key: "price_stress", label: "Price stress", score: 68 }],
      drivers: [{ label: "Broad market breadth", direction: "positive", evidenceCount: 3 }]
    },
    symbols: [{
      instrumentId: "us-equity-spy",
      ticker: "SPY",
      displayName: "SPDR S&P 500 ETF Trust",
      assetType: "etf",
      sector: "Broad Market",
      operabilityScore: 71,
      operabilityBand: "favorable",
      directionScore: 19,
      pressure: { positive: 2, neutral: 1, negative: 1 },
      availability: {
        analyzable: true,
        primaryReason: null,
        reasonCodes: [],
        sessionState: "open",
        ingestionState: "enabled",
        requiredClosedCandles: 2,
        availableClosedCandles: 4
      },
      metrics: { windowReturnPct: 0.42, rsi: 54, couplingCount: 2 },
      drivers: [{ key: "observed-news-price-reaction", direction: "positive", strength: 30 }],
      quality: { status: "observed", coveragePct: 92, lastCandleAgeMin: 7 }
    }],
    countryContext: {
      contextWindow: "current-intelligence-cycle",
      items: [{ iso2: "US", country: "United States", level: "Monitoring", trend: "Flat", summary: "Policy event risk remains monitored.", drivers: ["Fed schedule", "Rates"] }]
    },
    sourceSummary: [{ provider: "rss", sourceName: "Federal Reserve", count: 3 }],
    limitations: [],
    ...overrides
  };
}

test("market conditions UI model normalizes the v1 contract without converting missing scores to zero", () => {
  const result = normalizeMarketConditions(payload({
    quality: { status: "insufficient_data", coveragePct: 0 },
    market: { stabilityScore: 92, band: "favorable", components: [], drivers: [] },
    symbols: [{
      ticker: "BTC-USD",
      operabilityScore: 95,
      directionScore: 80,
      pressure: { positive: 80, neutral: 20, negative: 0 },
      quality: { status: "insufficient_data" }
    }]
  }));

  assert.equal(result.quality.status, "insufficient");
  assert.equal(result.market.stabilityScore, null);
  assert.equal(result.market.band, "insufficient");
  assert.equal(result.symbols[0].operabilityScore, null);
  assert.equal(result.symbols[0].directionScore, null);
  assert.equal(result.symbols[0].pressure, null);
  assert.equal(scoreDisplay(result.market.stabilityScore), "--");
  assert.equal(inputStatusLabel("insufficient_data"), "Inputs: insufficient");
});

test("market conditions UI model preserves signed direction and creates exact donut percentages", () => {
  const result = normalizeMarketConditions(payload());
  const symbol = result.symbols[0];

  assert.equal(symbol.directionScore, 19);
  assert.equal(symbol.directionBand, "neutral");
  assert.deepEqual(symbol.pressure, {
    positive: 50,
    neutral: 25,
    negative: 25,
    total: 100,
    positiveEnd: 50,
    neutralEnd: 75
  });
  assert.equal(symbol.quality.latestCandleAgeMin, 7);
  assert.equal(symbol.drivers[0].label, "observed news price reaction");
  assert.equal(result.quality.latestNewsAgeMin, 9);
  assert.equal(result.quality.latestCandleAgeMin, 12);
  assert.equal(scoreDisplay(19, { signed: true }), "+19");
  assert.match(scoreAriaLabel("SPY direction", 19, "neutral", { signed: true }), /minus 100 to 100 scale/);
});

test("pressure normalization rounds deterministically and always sums to 100", () => {
  const pressure = normalizePressure({ positive: 1, neutral: 1, negative: 1 });
  assert.deepEqual(
    { positive: pressure.positive, neutral: pressure.neutral, negative: pressure.negative },
    { positive: 34, neutral: 33, negative: 33 }
  );
  assert.equal(pressure.positive + pressure.neutral + pressure.negative, 100);
  assert.equal(normalizePressure({ positive: 0, neutral: 0, negative: 0 }), null);
});

test("partial or stale inputs cannot be rendered as favorable and invalid windows fail to the safe 4h view", () => {
  const partial = normalizeMarketConditions(payload({ quality: { status: "partial" } }));
  assert.equal(partial.market.stabilityScore, 74);
  assert.equal(partial.market.band, "caution");

  const invalid = normalizeMarketConditions(payload({ window: { minutes: 999 } }));
  assert.equal(invalid.window.minutes, DEFAULT_MARKET_CONDITIONS_WINDOW_MIN);
  assert.equal(invalid.contractValid, false);
  assert.match(invalid.limitations.join(" "), /Unsupported or missing analysis window/);
  assert.equal(normalizeInputStatus("stale"), "stale");
});

test("availability normalizes additive aliases without merging availability into quality", () => {
  const availability = normalizeAvailability({
    analyzable: false,
    reason: "off-hours",
    reasons: ["stale-candles"],
    session: "market-closed",
    ingestion: "active",
    lastObservedCandleAt: "2026-08-01T20:00:00.000Z",
    expectedCandleAt: "2026-08-03T13:35:00.000Z",
    nextSessionAt: "2026-08-03T13:30:00.000Z",
    requiredCandles: 2,
    availableCandles: 1
  }, { quality: { status: "observed" }, symbol: {} });

  assert.deepEqual(availability, {
    analyzable: false,
    primaryReason: "market_closed",
    reasonCodes: ["market_closed", "stale_local_data"],
    sessionState: "closed",
    ingestionState: "enabled",
    lastCandleAt: "2026-08-01T20:00:00.000Z",
    expectedLatestCandleAt: "2026-08-03T13:35:00.000Z",
    nextEligibleAt: "2026-08-03T13:30:00.000Z",
    requiredClosedCandles: 2,
    availableClosedCandles: 1
  });
});

test("availability exposes explicit explanations and blocked states cannot leak scores", () => {
  const expected = {
    market_closed: "Market closed",
    stale_local_data: "Stale local data",
    no_5m_history: "No 5m history",
    outside_intraday_limit: "Outside intraday limit",
    warming_up: "Warming up",
    automatic_ingestion_unsupported: "Ingestion unsupported"
  };

  for (const [reason, label] of Object.entries(expected)) {
    const details = availabilityReasonDetails(reason);
    assert.equal(details.label, label);
    assert.ok(details.message.length > 20);
  }

  const result = normalizeMarketConditions(payload({
    symbols: [{
      ticker: "CL=F",
      operabilityScore: 88,
      directionScore: -40,
      pressure: { positive: 0, neutral: 0, negative: 0 },
      availability: {
        analyzable: false,
        primaryReason: "no_5m_history",
        reasonCodes: ["no_5m_history"],
        sessionState: "unsupported",
        ingestionState: "unsupported",
        requiredClosedCandles: 2,
        availableClosedCandles: 0
      },
      quality: { status: "observed", coveragePct: 0 }
    }]
  }));

  assert.equal(result.symbols[0].availability.primaryReason, "no_5m_history");
  assert.equal(result.symbols[0].quality.status, "observed");
  assert.equal(result.symbols[0].operabilityScore, null);
  assert.equal(result.symbols[0].directionScore, null);
  assert.equal(result.symbols[0].pressure, null);
  assert.equal(scoreDisplay(result.symbols[0].operabilityScore), "--");
});

test("stale availability retains numeric scores but cannot remain favorable", () => {
  const result = normalizeMarketConditions(payload({
    symbols: [{
      ticker: "SPY",
      operabilityScore: 82,
      operabilityBand: "favorable",
      directionScore: -24,
      pressure: { positive: 10, neutral: 30, negative: 60 },
      availability: {
        analyzable: false,
        primaryReason: "stale_local_data",
        reasonCodes: ["stale_local_data"],
        sessionState: "open",
        ingestionState: "enabled",
        requiredClosedCandles: 2,
        availableClosedCandles: 0
      },
      quality: { status: "observed", coveragePct: 75 }
    }]
  }));

  const symbol = result.symbols[0];
  assert.equal(symbol.availability.analyzable, false);
  assert.equal(symbol.quality.status, "observed");
  assert.equal(symbol.operabilityScore, 82);
  assert.equal(symbol.operabilityBand, "caution");
  assert.equal(symbol.directionScore, -24);
  assert.equal(symbol.pressure.total, 100);
});

test("market closed suppresses current operability while retaining stale direction context", () => {
  const result = normalizeMarketConditions(payload({
    symbols: [{
      ticker: "SPY",
      operabilityScore: 72,
      directionScore: 12,
      pressure: { positive: 32, neutral: 51, negative: 17 },
      availability: {
        analyzable: false,
        primaryReason: "stale_local_data",
        reasonCodes: ["stale_local_data", "market_closed"],
        sessionState: "closed",
        ingestionState: "enabled",
        requiredClosedCandles: 2,
        availableClosedCandles: 48
      },
      quality: { status: "stale", coveragePct: 75 }
    }]
  }));

  const symbol = result.symbols[0];
  assert.equal(symbol.operabilityScore, null);
  assert.equal(symbol.operabilityBand, "insufficient");
  assert.equal(symbol.directionScore, 12);
  assert.equal(symbol.pressure.total, 100);
});
