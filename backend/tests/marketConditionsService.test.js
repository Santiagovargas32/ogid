import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKET_CONDITIONS_METHOD_VERSION,
  MARKET_CONDITIONS_SCHEMA_VERSION,
  MARKET_CONDITIONS_WINDOWS,
  MarketConditionsService,
  buildMarketConditionsCorpus,
  buildMarketConditionsSnapshot,
  classifyDirection,
  classifyMarketStability,
  directionPressure,
  normalizeMarketConditionsWindow
} from "../services/market/marketConditionsService.js";

const AS_OF = "2026-08-01T16:00:00.000Z";

function instrument(index = 1, overrides = {}) {
  return {
    instrumentId: `fixture-instrument-${index}`,
    canonicalSymbol: `T${index}`,
    displayName: `Test instrument ${index}`,
    assetType: "crypto",
    currency: "USD",
    timezone: "UTC",
    sessionPolicy: "24x7",
    verificationStatus: "verified",
    ...overrides
  };
}

function candles(target, { count = 60, interval = "5min", stepMinutes = 5, slope = 0.2, dataMode = "observed", startPrice = 100, asOf = AS_OF } = {}) {
  const stepMs = stepMinutes * 60_000;
  const startMs = Date.parse(asOf) - count * stepMs;
  return Array.from({ length: count }, (_, index) => {
    const close = startPrice + slope * index;
    const openTime = new Date(startMs + index * stepMs).toISOString();
    return {
      schemaVersion: "candle-v1",
      instrumentId: target.instrumentId,
      interval,
      openTime,
      closeTime: new Date(startMs + (index + 1) * stepMs).toISOString(),
      open: close - slope / 2,
      high: Math.max(close, close - slope / 2) + 0.5,
      low: Math.min(close, close - slope / 2) - 0.5,
      close,
      volume: 100 + index,
      currency: target.currency,
      source: "fixture-market",
      adjusted: true,
      dataMode,
      quality: dataMode === "stale" ? "stale-if-error" : "valid",
      provenance: { provider: "fixture-market", adjustmentMode: "splits", stale: dataMode === "stale" }
    };
  });
}

function article(id, minutesAgo = 5, overrides = {}) {
  return {
    id,
    provider: "gnews",
    sourceId: "fixture-wire",
    sourceName: "Fixture Wire",
    title: `Market article ${id}`,
    description: "Observed market information.",
    url: `https://news.example.test/${id}`,
    publishedAt: new Date(Date.parse(AS_OF) - minutesAgo * 60_000).toISOString(),
    receivedAt: new Date(Date.parse(AS_OF) - minutesAgo * 60_000).toISOString(),
    countryMentions: [],
    instrumentIds: [],
    domains: ["financial"],
    financialImportanceScore: 50,
    sentiment: { label: "neutral", score: 0 },
    conflict: { totalWeight: 0, tags: [] },
    synthetic: false,
    dataMode: "observed",
    ...overrides
  };
}

function awareness({ events = [], statuses = [{ sourceId: "active-source", admissionState: "active", enabled: true }] } = {}) {
  return {
    schemaVersion: "awareness-v1",
    revision: 7,
    generatedAt: AS_OF,
    mode: "visible",
    recent: events.filter((event) => event.projection !== "upcoming").map(({ projection: _projection, ...event }) => event),
    upcoming: events.filter((event) => event.projection === "upcoming").map(({ projection: _projection, ...event }) => event),
    sourceStatus: statuses
  };
}

function awarenessEvent(id, sourceId = "active-source", overrides = {}) {
  return {
    eventId: id,
    title: `Official event ${id}`,
    summary: "Official market event.",
    canonicalUrl: `https://official.example.test/${id}`,
    publishedAt: new Date(Date.parse(AS_OF) - 10 * 60_000).toISOString(),
    observedAt: AS_OF,
    status: "released",
    domains: ["financial"],
    countries: [],
    instrumentIds: [],
    importance: "medium",
    source: { sourceId, name: sourceId, role: "official", official: true },
    dataMode: "observed",
    ...overrides
  };
}

function snapshotInput({ instruments = [instrument(1), instrument(2)], series = null, articles = null, awarenessValue = null, couplings = [], sourceQuality = {} } = {}) {
  const resolvedSeries = series || Object.fromEntries(instruments.map((item, index) => [item.instrumentId, {
    interval: "5min",
    candles: candles(item, { slope: index ? -0.2 : 0.2 })
  }]));
  const resolvedArticles = articles || instruments.map((item, index) => article(`n${index + 1}`, 5 + index, { instrumentIds: [item.instrumentId] }));
  return {
    windowMin: 15,
    asOf: AS_OF,
    articles: resolvedArticles,
    awareness: awarenessValue || awareness(),
    instruments,
    quotes: Object.fromEntries(instruments.map((item) => [item.canonicalSymbol, { instrumentId: item.instrumentId, dataMode: "observed", synthetic: false }])),
    seriesByInstrument: resolvedSeries,
    couplings,
    countryInsights: [],
    revisions: { news: "news-1", market: "market-1", awareness: 7, watchlist: "watch-1", candles: "candles-1" },
    sourceQuality
  };
}

test("valid windows and public thresholds are exact", () => {
  assert.equal(MARKET_CONDITIONS_METHOD_VERSION, "market-conditions-v1.1");
  assert.deepEqual(MARKET_CONDITIONS_WINDOWS, [15, 60, 240, 1_440]);
  for (const value of MARKET_CONDITIONS_WINDOWS) assert.equal(normalizeMarketConditionsWindow(value), value);
  assert.throws(() => normalizeMarketConditionsWindow(120), { code: "INVALID_MARKET_CONDITIONS_WINDOW" });
  assert.equal(classifyMarketStability(70), "favorable");
  assert.equal(classifyMarketStability(69), "caution");
  assert.equal(classifyMarketStability(40), "caution");
  assert.equal(classifyMarketStability(39), "adverse");
  assert.equal(classifyMarketStability(95, "partial"), "caution");
  assert.equal(classifyMarketStability(95, "stale"), "caution");
  assert.equal(classifyMarketStability(95, "synthetic"), "insufficient");
  assert.equal(classifyDirection(20), "positive");
  assert.equal(classifyDirection(19), "neutral");
  assert.equal(classifyDirection(-19), "neutral");
  assert.equal(classifyDirection(-20), "negative");
});

test("canonical URL deduplication wins across providers and only active Awareness is admitted", () => {
  const base = article("same", 10, { title: "Same release", url: "https://official.example.test/release?utm_source=wire" });
  const active = awarenessEvent("active", "active-source", { title: "Same release", canonicalUrl: "https://official.example.test/release" });
  const shadow = awarenessEvent("shadow", "shadow-source", { canonicalUrl: "https://shadow.example.test/unique" });
  const result = buildMarketConditionsCorpus({
    articles: [base, article("shadow-projection", 5, { provider: "awareness", sourceId: "shadow-source" })],
    awareness: awareness({
      events: [active, shadow],
      statuses: [
        { sourceId: "active-source", admissionState: "active", enabled: true },
        { sourceId: "shadow-source", admissionState: "shadow", enabled: true }
      ]
    }),
    windowMin: 60,
    asOf: AS_OF
  });
  assert.equal(result.activeSourceCount, 1);
  assert.deepEqual(result.activeEvents.map((event) => event.eventId), ["active"]);
  assert.equal(result.articles.length, 1);
  assert.equal(result.deduplicated, 1);
  assert.equal(result.articles[0].canonicalUrl, "https://official.example.test/release");
});

test("each analysis window limits news independently", () => {
  const values = [article("m10", 10), article("m30", 30), article("m120", 120), article("m600", 600), article("m1500", 1_500)];
  const expected = new Map([[15, 1], [60, 2], [240, 3], [1_440, 4]]);
  for (const [windowMin, count] of expected) {
    const result = buildMarketConditionsCorpus({ articles: values, awareness: { mode: "off" }, windowMin, asOf: AS_OF });
    assert.equal(result.articles.length, count);
  }
});

test("observed trend produces signed scores and deterministic pressure sums to 100", () => {
  const result = buildMarketConditionsSnapshot(snapshotInput());
  assert.equal(result.schemaVersion, MARKET_CONDITIONS_SCHEMA_VERSION);
  assert.equal(result.methodVersion, MARKET_CONDITIONS_METHOD_VERSION);
  assert.equal(result.symbols[0].directionBand, "positive");
  assert.equal(result.symbols[1].directionBand, "negative");
  for (const symbol of result.symbols) {
    assert.ok(symbol.operabilityScore >= 0 && symbol.operabilityScore <= 100);
    assert.ok(symbol.directionScore >= -100 && symbol.directionScore <= 100);
    assert.equal(Object.values(symbol.pressure).reduce((total, value) => total + value, 0), 100);
  }
  assert.equal(JSON.stringify(result).includes('"weight"'), false);
  assert.deepEqual(directionPressure(null), null);
});

test("news sentiment alone never changes direction without sufficient observed reaction", () => {
  const target = instrument(1);
  const baseInput = snapshotInput({
    instruments: [target],
    articles: [article("linked", 10, { instrumentIds: [target.instrumentId], sentiment: { label: "negative", score: -1 }, conflict: { totalWeight: 20, tags: [] } })]
  });
  const withoutReaction = buildMarketConditionsSnapshot(baseInput);
  const positiveNews = buildMarketConditionsSnapshot({ ...baseInput, articles: [{ ...baseInput.articles[0], sentiment: { label: "positive", score: 1 }, conflict: { totalWeight: 0, tags: [] } }] });
  assert.equal(withoutReaction.symbols[0].directionScore, positiveNews.symbols[0].directionScore);
  const withReaction = buildMarketConditionsSnapshot({
    ...baseInput,
    couplings: [{
      newsId: "linked",
      instrumentId: target.instrumentId,
      dataQuality: "observed",
      confounded: false,
      windows: [{ windowMin: 15, rawReturn: -0.08, abnormalReturn: null, dataCoverage: 1, confidenceMethod: { level: "higher" } }]
    }]
  });
  assert.ok(withReaction.symbols[0].directionScore < withoutReaction.symbols[0].directionScore);
  assert.deepEqual(withReaction.symbols[0].evidence.couplingArticleIds, ["linked"]);
});

test("Country Risk is output-only context and cannot alter market or symbol scores", () => {
  const first = buildMarketConditionsSnapshot({ ...snapshotInput(), countryInsights: [{ iso2: "US", country: "United States", level: "Stable", trend: "Flat", summary: "A", drivers: ["one"] }] });
  const second = buildMarketConditionsSnapshot({ ...snapshotInput(), countryInsights: [{ iso2: "US", country: "United States", level: "Critical", trend: "Escalating", summary: "B", drivers: ["two"] }] });
  assert.deepEqual(second.market, first.market);
  assert.deepEqual(second.symbols, first.symbols);
  assert.notDeepEqual(second.countryContext, first.countryContext);
  assert.equal(first.countryContext.windowIndependent, true);
});

test("missing inputs return null rather than fabricated zeros", () => {
  const result = buildMarketConditionsSnapshot({ windowMin: 240, asOf: AS_OF });
  assert.equal(result.market.stabilityScore, null);
  assert.equal(result.market.band, "insufficient");
  assert.equal(result.quality.status, "insufficient_data");
  assert.deepEqual(result.symbols, []);
});

test("synthetic candles never generate scores or a favorable band", () => {
  const target = instrument(1);
  const result = buildMarketConditionsSnapshot(snapshotInput({
    instruments: [target],
    series: { [target.instrumentId]: { interval: "5min", candles: candles(target, { dataMode: "synthetic" }) } },
    articles: [article("synthetic-news", 5, { synthetic: true, dataMode: "synthetic", instrumentIds: [target.instrumentId] })],
    sourceQuality: { news: { synthetic: true }, market: { synthetic: true } }
  }));
  assert.equal(result.market.stabilityScore, null);
  assert.equal(result.market.band, "insufficient");
  assert.equal(result.quality.status, "synthetic");
  assert.equal(result.symbols[0].operabilityScore, null);
  assert.equal(result.symbols[0].directionScore, null);
  assert.equal(result.symbols[0].pressure, null);
  assert.equal(result.symbols[0].quality.status, "synthetic");
});

test("stale observed inputs retain numeric scores but are never favorable", () => {
  const target = instrument(1);
  const result = buildMarketConditionsSnapshot(snapshotInput({
    instruments: [target],
    series: { [target.instrumentId]: { interval: "5min", candles: candles(target, { slope: 0.01, dataMode: "stale" }) } },
    articles: [article("current", 5, { instrumentIds: [target.instrumentId], financialImportanceScore: 5 })]
  }));
  assert.ok(Number.isFinite(result.market.stabilityScore));
  assert.equal(result.quality.status, "stale");
  assert.notEqual(result.market.band, "favorable");
  assert.ok(Number.isFinite(result.symbols[0].operabilityScore));
  assert.equal(result.symbols[0].quality.status, "stale");
  assert.equal(result.symbols[0].availability.analyzable, false);
  assert.equal(result.symbols[0].availability.primaryReason, "stale_local_data");
  assert.notEqual(result.symbols[0].operabilityBand, "favorable");
});

test("automatic recency marks retained numeric scores stale without fabricating a fallback", () => {
  const target = instrument(1);
  const result = buildMarketConditionsSnapshot({
    ...snapshotInput({
      instruments: [target],
      series: { [target.instrumentId]: { interval: "5min", candles: candles(target, { count: 60, asOf: "2026-08-01T15:40:00.000Z" }) } },
      articles: [article("current", 5, { instrumentIds: [target.instrumentId] })]
    }),
    windowMin: 60,
    pollIntervalMs: 5 * 60_000
  });

  assert.equal(result.symbols[0].availability.primaryReason, "stale_local_data");
  assert.equal(result.symbols[0].availability.analyzable, false);
  assert.ok(Number.isFinite(result.symbols[0].directionScore));
  assert.ok(Number.isFinite(result.symbols[0].operabilityScore));
  assert.equal(result.symbols[0].quality.status, "stale");
  assert.notEqual(result.symbols[0].operabilityBand, "favorable");
});

test("rollup gaps and excluded candles reduce coverage even when indicators remain calculable", () => {
  const target = instrument(1);
  const values = candles(target);
  const result = buildMarketConditionsSnapshot(snapshotInput({
    instruments: [target],
    series: {
      [target.instrumentId]: {
        interval: "5min",
        candles: values,
        gaps: [{ reason: "missing_candles" }],
        incompleteBuckets: [{ reason: "bucket_open" }],
        quality: { status: "partial", gapDetected: true, openCandles: 1, outsideSessionCandles: 2 }
      }
    },
    articles: [article("quality", 5, { instrumentIds: [target.instrumentId] })]
  }));
  assert.equal(result.quality.status, "partial");
  assert.equal(result.symbols[0].quality.status, "partial");
  assert.equal(result.symbols[0].quality.gapDetected, true);
  assert.equal(result.symbols[0].quality.openCandles, 1);
  assert.equal(result.symbols[0].quality.outsideSessionCandles, 2);
  assert.equal(result.symbols[0].quality.incompleteBuckets, 1);
  assert.ok(result.symbols[0].quality.limitations.some((item) => item.includes("gaps")));
  assert.equal(result.symbols[0].availability.analyzable, true);
  assert.ok(result.symbols[0].availability.reasonCodes.includes("rollup_gaps"));
  assert.equal(result.quality.latestNewsAgeMin, 5);
  assert.equal(result.quality.latestCandleAgeMin, 0);
  assert.equal(result.symbols[0].quality.lastCandleAgeMin, 0);
});

test("watchlist instruments outside the six-instrument intraday cap remain explicit", () => {
  const instruments = Array.from({ length: 7 }, (_, index) => instrument(index + 1));
  const series = Object.fromEntries(instruments.slice(0, 6).map((item) => [item.instrumentId, { interval: "5min", candles: candles(item) }]));
  const result = buildMarketConditionsSnapshot(snapshotInput({ instruments, series }));
  assert.equal(result.symbols.length, 7);
  assert.equal(result.diagnostics.analyzedInstruments, 6);
  assert.equal(result.diagnostics.selectedInstruments, 7);
  assert.equal(result.symbols[6].operabilityScore, null);
  assert.equal(result.symbols[6].directionScore, null);
  assert.equal(result.symbols[6].quality.status, "insufficient_data");
  assert.deepEqual(result.symbols[6].quality.limitations, ["outside_intraday_limit"]);
  assert.equal(result.symbols[6].availability.analyzable, false);
  assert.equal(result.symbols[6].availability.primaryReason, "outside_intraday_limit");
  assert.equal(result.symbols[6].availability.ingestionState, "not_scheduled");
  assert.ok(result.quality.limitations.some((item) => item.includes("first 6")));
});

test("closed exchange sessions disable current operability but retain calculable direction context", () => {
  const target = instrument(1, {
    canonicalSymbol: "SPY",
    assetType: "etf",
    timezone: "America/New_York",
    sessionPolicy: "exchange-hours"
  });
  const closedAt = "2026-07-31T20:05:00.000Z";
  const result = buildMarketConditionsSnapshot({
    ...snapshotInput({
      instruments: [target],
      series: { [target.instrumentId]: { interval: "5min", candles: candles(target, { count: 60, asOf: "2026-07-31T20:00:00.000Z" }) } }
    }),
    asOf: closedAt,
    windowMin: 15
  });

  assert.equal(result.symbols[0].availability.primaryReason, "market_closed");
  assert.equal(result.symbols[0].availability.sessionState, "closed");
  assert.equal(result.symbols[0].availability.analyzable, false);
  assert.ok(Number.isFinite(result.symbols[0].directionScore));
  assert.equal(result.symbols[0].operabilityScore, null);
});

test("a selected instrument without local five-minute history is explicit and scoreless", () => {
  const target = instrument(1);
  const result = buildMarketConditionsSnapshot(snapshotInput({
    instruments: [target],
    series: { [target.instrumentId]: { interval: "5min", candles: [] } }
  }));

  assert.equal(result.symbols[0].availability.primaryReason, "no_5m_history");
  assert.equal(result.symbols[0].availability.availableClosedCandles, 0);
  assert.equal(result.symbols[0].operabilityScore, null);
  assert.equal(result.symbols[0].directionScore, null);
  assert.equal(result.symbols[0].quality.status, "insufficient_data");
});

test("window return uses first and last close inside the selected horizon", () => {
  const target = instrument(1);
  const series = candles(target, { count: 50, slope: 1 });
  for (const candle of series.filter((item) => Date.parse(item.closeTime) < Date.parse(AS_OF) - 15 * 60_000)) candle.close *= 10;
  const within = series.filter((item) => Date.parse(item.closeTime) >= Date.parse(AS_OF) - 15 * 60_000);
  const expected = (within.at(-1).close / within[0].close - 1) * 100;
  const result = buildMarketConditionsSnapshot(snapshotInput({
    instruments: [target],
    series: { [target.instrumentId]: { interval: "5min", candles: series } },
    articles: [article("return", 5, { instrumentIds: [target.instrumentId] })]
  }));
  assert.equal(result.symbols[0].metrics.windowReturnPct, Number(expected.toFixed(3)));
});

test("service cache is revision-aware, clone-safe and performs zero HTTP", () => {
  const target = instrument(1);
  let marketRevision = "market-1";
  const stateManager = {
    getSnapshot: () => ({
      meta: { lastRefreshAt: "news-1", dataQuality: { news: { synthetic: false }, market: { synthetic: false } } },
      market: { revision: marketRevision, quotes: { T1: { instrumentId: target.instrumentId, dataMode: "observed" } } },
      awareness: awareness(),
      insights: []
    }),
    getMarketSignalCorpus: () => [article("cache", 5, { instrumentIds: [target.instrumentId] })]
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected-http"); };
  try {
    const service = new MarketConditionsService({
      stateManager,
      candleStore: { query: () => { throw new Error("series-resolver-should-own-local-read"); } },
      marketWatchlistService: { selectedInstruments: () => [target] },
      now: () => new Date(AS_OF),
      seriesResolver: () => ({ interval: "5min", candles: candles(target) })
    });
    const first = service.getSnapshot({ windowMin: 15 });
    const originalScore = first.market.stabilityScore;
    first.market.stabilityScore = -999;
    const cached = service.getSnapshot({ windowMin: 15 });
    assert.notStrictEqual(cached, first);
    assert.equal(cached.market.stabilityScore, originalScore);
    marketRevision = "market-2";
    const invalidated = service.getSnapshot({ windowMin: 15 });
    assert.equal(invalidated.revisions.market, "market-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
