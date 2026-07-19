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

function buildInitialAdminState() {
  return {
    intelRawNews: {
      generatedAt: null,
      items: [],
      summary: {
        rawTotal: 0,
        selectedTotal: 0,
        queryLengthTotal: 0,
        rawCountByProvider: {},
        selectedCountByProvider: {},
        queryLengthByProvider: {}
      }
    }
  };
}

function buildInitialAiState() {
  return {
    schemaVersion: "ai-projection-v1",
    mode: "off",
    provider: "none",
    enabled: false,
    updatedAt: null,
    articleSummaries: {},
    countryInsights: {},
    marketExplanations: {},
    status: {
      queueDepth: 0,
      active: 0,
      features: [],
      counts: {}
    }
  };
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
      marketTickers: [],
      impactWindowMin: 120,
      marketEnabled: true,
      marketDisabledReason: null
    });
  }

  createInitialState({
    refreshIntervalMs,
    watchlistCountries,
    marketTickers,
    impactWindowMin,
    marketWatchlistRollout,
    marketEnabled = true,
    marketDisabledReason = null
  }) {
    const now = new Date().toISOString();
    const countries = createCountryState(now);
    const market = buildInitialMarketState(marketTickers, {
      enabled: marketEnabled,
      disabledReason: marketDisabledReason,
      watchlistRollout: marketWatchlistRollout
    });
    const dataQuality = buildDataQuality({
      newsMode: "fallback",
      newsMeta: { provider: "seed", reason: "initial-state" },
      marketMode: market.sourceMode || "fallback",
      marketMeta: market.sourceMeta || { provider: "seed", reason: "initial-state" }
    });

    return {
      meta: {
        initializedAt: now,
        lastRefreshAt: null,
        refreshIntervalMs,
        watchlistCountries,
        marketTickers: [...marketTickers],
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
      impactHistory: [],
      ai: buildInitialAiState(),
      admin: buildInitialAdminState()
    };
  }

  reset({
    refreshIntervalMs = 30_000,
    watchlistCountries = ["US", "IL", "IR"],
    marketTickers = [],
    marketWatchlistRollout = undefined,
    impactWindowMin = 120,
    marketEnabled = true,
    marketDisabledReason = null
  } = {}) {
    this.state = this.createInitialState({
      refreshIntervalMs,
      watchlistCountries,
      marketTickers,
      marketWatchlistRollout,
      impactWindowMin,
      marketEnabled,
      marketDisabledReason
    });
    return this.getSnapshot();
  }

  getSnapshot() {
    const { signalCorpus: _signalCorpus, admin: _admin, ...snapshot } = this.state;
    return structuredClone(snapshot);
  }

  getMeta() {
    return this.state.meta;
  }

  setMarketTickers(tickers = []) {
    const active = new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || "").trim().toUpperCase()).filter(Boolean));
    const previousActive = new Set((this.state.meta?.marketTickers || []).map((ticker) => String(ticker || "").trim().toUpperCase()).filter(Boolean));
    const selectionChanged = active.size !== previousActive.size || [...active].some((ticker) => !previousActive.has(ticker));
    const filterByTicker = (values = {}) => Object.fromEntries(Object.entries(values)
      .map(([ticker, value]) => [String(ticker || "").trim().toUpperCase(), value])
      .filter(([ticker]) => active.has(ticker)));
    const hasActiveTicker = (item) => active.has(String(item?.ticker || "").trim().toUpperCase());
    const predictionTickers = (this.state.predictions?.tickers || []).filter(hasActiveTicker);
    const predictionScores = filterByTicker(this.state.predictions?.predictionScoreByTicker);
    const predictionSectors = (this.state.predictions?.sectors || [])
      .map((sector) => ({
        ...sector,
        tickers: (sector?.tickers || []).filter((ticker) => active.has(String(ticker || "").trim().toUpperCase()))
      }))
      .filter((sector) => sector.tickers.length > 0);
    const impactItems = (this.state.impact?.items || []).filter(hasActiveTicker);
    const sectorBreakdown = [...impactItems.reduce((sectors, item) => {
      const sector = item?.sector || "broad";
      const entry = sectors.get(sector) || { sector, eventScore: 0, impactScore: 0, itemCount: 0, tickers: new Set() };
      entry.eventScore = Number((entry.eventScore + Number(item?.eventScore || 0)).toFixed(2));
      entry.impactScore = Number((entry.impactScore + Number(item?.impactScore || 0)).toFixed(2));
      entry.itemCount += 1;
      entry.tickers.add(String(item?.ticker || "").trim().toUpperCase());
      sectors.set(sector, entry);
      return sectors;
    }, new Map()).values()]
      .map((entry) => ({ ...entry, tickers: [...entry.tickers].sort() }))
      .sort((left, right) => right.impactScore - left.impactScore);
    const impactHistory = (this.state.impactHistory || [])
      .map((entry) => ({ ...entry, items: (entry?.items || []).filter(hasActiveTicker) }))
      .filter((entry) => entry.items.length > 0);
    const marketQuotes = filterByTicker(this.state.market?.quotes);
    const marketTimeseries = filterByTicker(this.state.market?.timeseries);
    const marketSourceMeta = selectionChanged
      ? {
          provider: this.state.market?.sourceMeta?.provider || this.state.market?.provider || "market-router",
          reason: "watchlist-selection-changed",
          requestMode: "watchlist-pending-refresh",
          enabled: this.state.market?.sourceMeta?.enabled !== false,
          requestedTickers: [...active],
          returnedTickers: Object.keys(marketQuotes),
          missingTickers: [...active].filter((ticker) => !marketQuotes[ticker]),
          marketSession: this.state.market?.session || null
        }
      : this.state.market?.sourceMeta;
    this.state = {
      ...this.state,
      meta: { ...this.state.meta, marketTickers: [...active] },
      market: {
        ...this.state.market,
        revision: selectionChanged ? null : this.state.market?.revision,
        updatedAt: selectionChanged ? null : this.state.market?.updatedAt,
        sourceMeta: marketSourceMeta,
        quotes: marketQuotes,
        timeseries: marketTimeseries
      },
      predictions: {
        ...this.state.predictions,
        updatedAt: selectionChanged ? null : this.state.predictions?.updatedAt,
        sectors: selectionChanged ? [] : predictionSectors,
        tickers: selectionChanged ? [] : predictionTickers,
        predictionScoreByTicker: selectionChanged ? {} : predictionScores
      },
      impact: {
        ...this.state.impact,
        updatedAt: selectionChanged ? null : this.state.impact?.updatedAt,
        items: selectionChanged ? [] : impactItems,
        sectorBreakdown: selectionChanged ? [] : sectorBreakdown,
        scatterPoints: selectionChanged ? [] : (this.state.impact?.scatterPoints || []).filter(hasActiveTicker),
        couplingSeries: selectionChanged ? [] : (this.state.impact?.couplingSeries || []).filter(hasActiveTicker)
      },
      impactHistory
    };
    return this.getSnapshot();
  }

  getSignalCorpus() {
    return structuredClone(this.state.signalCorpus || []);
  }

  getAdminIntelRawNews() {
    return structuredClone(this.state.admin?.intelRawNews || buildInitialAdminState().intelRawNews);
  }

  setAiProjection(nextValue = {}) {
    this.state = {
      ...this.state,
      ai: {
        ...buildInitialAiState(),
        ...(nextValue || {}),
        articleSummaries: nextValue?.articleSummaries || {},
        countryInsights: nextValue?.countryInsights || {},
        marketExplanations: nextValue?.marketExplanations || {},
        status: {
          ...buildInitialAiState().status,
          ...(nextValue?.status || {})
        }
      }
    };
    return structuredClone(this.state.ai);
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

  setAdminIntelRawNews(nextValue = {}) {
    this.state = {
      ...this.state,
      admin: {
        ...(this.state.admin || buildInitialAdminState()),
        intelRawNews: {
          generatedAt: nextValue.generatedAt || null,
          items: Array.isArray(nextValue.items) ? nextValue.items : [],
          summary: {
            ...buildInitialAdminState().intelRawNews.summary,
            ...(nextValue.summary || {})
          }
        }
      }
    };

    return this.getAdminIntelRawNews();
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

  hydrateMarketState(market = null) {
    if (!market || typeof market !== "object") {
      return this.getSnapshot();
    }

    const nextMarket = {
      ...this.state.market,
      ...market,
      quotes: market.quotes || this.state.market?.quotes || {},
      timeseries: market.timeseries || this.state.market?.timeseries || {}
    };

    this.state = {
      ...this.state,
      market: nextMarket,
      meta: {
        ...this.state.meta,
        dataQuality: buildDataQuality({
          newsMode: this.state.meta?.sourceMode || "fallback",
          newsMeta: this.state.meta?.sourceMeta || { provider: "unknown" },
          marketMode: nextMarket?.sourceMode || "fallback",
          marketMeta: nextMarket?.sourceMeta || { provider: "unknown" }
        })
      }
    };

    return this.getSnapshot();
  }
}

const stateManager = new StateManager();

export default stateManager;
