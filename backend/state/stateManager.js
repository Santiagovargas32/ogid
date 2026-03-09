import { buildBaselineCountryMap } from "../utils/countryCatalog.js";
import { buildInitialMarketState } from "../services/market/marketStateService.js";

const MAX_TIMESERIES_POINTS = 30;
const MAX_IMPACT_HISTORY_POINTS = 120;
const DEFAULT_REFRESH_STATUS = Object.freeze({
  inProgress: false,
  lastTrigger: "initial-state",
  lastRequestedAt: null,
  lastCompletedAt: null,
  lastDurationMs: null,
  lastRefreshId: null
});

function calculateDistribution(countries) {
  const values = Object.values(countries);
  const distribution = {
    Critical: 0,
    Elevated: 0,
    Monitoring: 0,
    Stable: 0
  };

  for (const country of values) {
    distribution[country.level] += 1;
  }

  return distribution;
}

function toHotspots(countries) {
  return Object.values(countries)
    .sort((a, b) => b.score - a.score)
    .map((country) => ({
      iso2: country.iso2,
      country: country.country,
      lat: country.lat,
      lng: country.lng,
      score: country.score,
      level: country.level,
      metrics: country.metrics,
      topTags: country.topTags,
      updatedAt: country.updatedAt
    }));
}

function createCountryState(timestamp) {
  const base = buildBaselineCountryMap();
  return Object.fromEntries(
    Object.values(base).map((country) => [
      country.iso2,
      {
        iso2: country.iso2,
        country: country.country,
        lat: country.lat,
        lng: country.lng,
        score: 0,
        level: "Stable",
        trend: "Stable",
        metrics: {
          newsVolume: 0,
          negativeSentiment: 0,
          conflictTagWeight: 0
        },
        topTags: [],
        updatedAt: timestamp
      }
    ])
  );
}

function resolveInputMode(newsMode, marketMode) {
  if (newsMode === "live" && marketMode === "live") {
    return "live";
  }
  if (newsMode === "fallback" && marketMode === "fallback") {
    return "fallback";
  }
  return "mixed";
}

function qualityRecord({ mode, provider, reason, inputMode = null }) {
  return {
    mode,
    provider,
    reason: reason || null,
    synthetic: mode !== "live",
    inputMode
  };
}

function buildDataQuality({ newsMode, newsMeta, marketMode, marketMeta }) {
  const inputMode = resolveInputMode(newsMode, marketMode);
  const combinedProvider = `${newsMeta?.provider || "unknown"}+${marketMeta?.provider || "unknown"}`;
  const mixedReason = inputMode === "mixed" ? "mixed-live-fallback" : null;

  return {
    news: qualityRecord({
      mode: newsMode,
      provider: newsMeta?.provider || "unknown",
      reason: newsMeta?.reason
    }),
    market: qualityRecord({
      mode: marketMode,
      provider: marketMeta?.provider || "unknown",
      reason: marketMeta?.reason
    }),
    insights: qualityRecord({
      mode: inputMode,
      provider: combinedProvider,
      reason: mixedReason,
      inputMode
    }),
    impact: qualityRecord({
      mode: inputMode,
      provider: combinedProvider,
      reason: mixedReason,
      inputMode
    })
  };
}

function toImpactHistoryEntry(impact, timestamp) {
  if (!impact?.items?.length) {
    return null;
  }

  return {
    timestamp,
    inputMode: impact.inputMode || "live",
    items: impact.items.map((item) => ({
      ticker: item.ticker,
      impactScore: item.impactScore,
      eventScore: item.eventScore,
      priceReaction: item.priceReaction,
      level: item.level
    }))
  };
}

class StateManager {
  constructor() {
    this.state = this.createInitialState({
      refreshIntervalMs: 30_000,
      watchlistCountries: ["US", "IL", "IR"],
      marketTickers: ["GD", "BA", "NOC"],
      impactWindowMin: 120
    });
  }

  createInitialState({ refreshIntervalMs, watchlistCountries, marketTickers, impactWindowMin }) {
    const now = new Date().toISOString();
    const countries = createCountryState(now);
    const market = buildInitialMarketState(marketTickers);
    const dataQuality = buildDataQuality({
      newsMode: "fallback",
      newsMeta: { provider: "seed", reason: "initial-state" },
      marketMode: "fallback",
      marketMeta: { provider: "seed", reason: "initial-state" }
    });

    return {
      meta: {
        initializedAt: now,
        lastRefreshAt: null,
        refreshIntervalMs,
        watchlistCountries,
        sourceMode: "fallback",
        sourceMeta: { provider: "seed", reason: "initial-state" },
        dataQuality,
        refreshStatus: structuredClone(DEFAULT_REFRESH_STATUS)
      },
      news: [],
      signalCorpus: [],
      countries,
      hotspots: toHotspots(countries),
      insights: [],
      predictions: {
        updatedAt: null,
        inputMode: "fallback",
        sectors: [],
        tickers: []
      },
      timeseries: [],
      market,
      mapAssets: {
        generatedAt: null,
        staticPoints: [],
        movingSeeds: [],
        meta: {
          generatedAt: null,
          rssGeneratedAt: null,
          corpusSize: 0,
          matchedAssets: 0,
          statusCounts: {
            confirmed: 0,
            "country-inferred": 0,
            seeded: 0
          }
        }
      },
      impact: {
        updatedAt: null,
        windowMin: impactWindowMin,
        inputMode: "fallback",
        items: [],
        sectorBreakdown: [],
        scatterPoints: []
      },
      impactHistory: []
    };
  }

  reset({
    refreshIntervalMs = 30_000,
    watchlistCountries = ["US", "IL", "IR"],
    marketTickers = ["GD", "BA", "NOC"],
    impactWindowMin = 120
  } = {}) {
    this.state = this.createInitialState({
      refreshIntervalMs,
      watchlistCountries,
      marketTickers,
      impactWindowMin
    });
    return this.getSnapshot();
  }

  getSnapshot() {
    const { signalCorpus: _signalCorpus, ...snapshot } = this.state;
    return structuredClone(snapshot);
  }

  getMeta() {
    return this.state.meta;
  }

  getSignalCorpus() {
    return structuredClone(this.state.signalCorpus || []);
  }

  setRefreshStatus(nextStatus = {}) {
    const refreshStatus = {
      ...(this.state.meta.refreshStatus || DEFAULT_REFRESH_STATUS),
      ...nextStatus
    };

    this.state = {
      ...this.state,
      meta: {
        ...this.state.meta,
        refreshStatus
      }
    };

    return this.getMeta();
  }

  updateIntel({
    news,
    countries,
    hotspots,
    insights,
    predictions,
    market,
    impact,
    signalCorpus,
    sourceMode,
    sourceMeta,
    newsSourceMode,
    newsSourceMeta,
    watchlistCountries,
    refreshedAt
  }) {
    const timestamp = refreshedAt || new Date().toISOString();
    const nextCountries = countries || this.state.countries;
    const nextNews = news ?? this.state.news;
    const nextSignalCorpus = signalCorpus ?? this.state.signalCorpus ?? nextNews;
    const nextMarket = market ?? this.state.market;
    const nextImpact = impact ?? this.state.impact;

    const resolvedNewsMode = newsSourceMode || sourceMode || this.state.meta.sourceMode || "fallback";
    const resolvedNewsMeta = newsSourceMeta || sourceMeta || this.state.meta.sourceMeta || { provider: "unknown" };
    const resolvedMarketMode = nextMarket?.sourceMode || this.state.market?.sourceMode || "fallback";
    const resolvedMarketMeta = nextMarket?.sourceMeta || this.state.market?.sourceMeta || { provider: "unknown" };

    const distribution = calculateDistribution(nextCountries);
    const nextTimeseries = [
      ...this.state.timeseries,
      {
        timestamp,
        totalArticles: nextNews.length,
        maxScore: Math.max(...Object.values(nextCountries).map((country) => country.score), 0),
        ...distribution
      }
    ].slice(-MAX_TIMESERIES_POINTS);

    const nextHistoryEntry = toImpactHistoryEntry(nextImpact, timestamp);
    const impactHistory = nextHistoryEntry
      ? [...this.state.impactHistory, nextHistoryEntry].slice(-MAX_IMPACT_HISTORY_POINTS)
      : this.state.impactHistory;

    this.state = {
      ...this.state,
      news: nextNews,
      signalCorpus: nextSignalCorpus,
      countries: nextCountries,
      hotspots: hotspots ?? toHotspots(nextCountries),
      insights: insights ?? this.state.insights,
      predictions: predictions ?? this.state.predictions,
      timeseries: nextTimeseries,
      market: nextMarket,
      impact: nextImpact,
      impactHistory,
      mapAssets: this.state.mapAssets,
      meta: {
        ...this.state.meta,
        lastRefreshAt: timestamp,
        watchlistCountries: watchlistCountries || this.state.meta.watchlistCountries,
        sourceMode: resolvedNewsMode,
        sourceMeta: resolvedNewsMeta,
        dataQuality: buildDataQuality({
          newsMode: resolvedNewsMode,
          newsMeta: resolvedNewsMeta,
          marketMode: resolvedMarketMode,
          marketMeta: resolvedMarketMeta
        })
      }
    };

    return this.getSnapshot();
  }

  setMapAssets(mapAssets = null) {
    if (!mapAssets || typeof mapAssets !== "object") {
      return this.getSnapshot();
    }

    this.state = {
      ...this.state,
      mapAssets
    };

    return this.getSnapshot();
  }
}

const stateManager = new StateManager();

export default stateManager;
