const appState = {
  meta: {
    initializedAt: null,
    lastRefreshAt: null,
    refreshIntervalMs: 30_000,
    sourceMode: "initializing",
    sourceMeta: {},
    dataQuality: {},
    refreshStatus: {
      inProgress: false,
      lastTrigger: "initializing",
      lastRequestedAt: null,
      lastCompletedAt: null,
      lastDurationMs: null,
      lastRefreshId: null
    }
  },
  news: [],
  countries: {},
  hotspots: [],
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
  insights: [],
  predictions: {
    updatedAt: null,
    inputMode: "fallback",
    sectors: [],
    tickers: []
  },
  timeseries: [],
  market: {
    quotes: {},
    timeseries: {},
    sourceMode: "fallback",
    updatedAt: null,
    revision: null,
    session: {
      open: false,
      state: "closed",
      checkedAt: null,
      timezone: "America/New_York"
    }
  },
  impact: {
    items: [],
    windowMin: 120,
    updatedAt: null,
    sectorBreakdown: [],
    scatterPoints: []
  },
  impactHistory: [],
  ai: {
    schemaVersion: "ai-projection-v1",
    mode: "off",
    provider: "none",
    enabled: false,
    updatedAt: null,
    articleSummaries: {},
    countryInsights: {},
    marketExplanations: {},
    status: { queueDepth: 0, active: 0, features: [], counts: {} }
  }
};

const subscribers = new Set();

function mergeMarketPayload(previousMarket = {}, nextMarket = {}) {
  const merged = {
    ...previousMarket,
    ...nextMarket
  };

  if (nextMarket.quotes && typeof nextMarket.quotes === "object") {
    merged.quotes = {
      ...(previousMarket.quotes || {}),
      ...nextMarket.quotes
    };
  }

  if (nextMarket.timeseries && typeof nextMarket.timeseries === "object") {
    merged.timeseries = {
      ...(previousMarket.timeseries || {}),
      ...nextMarket.timeseries
    };
  }

  return merged;
}

function notify() {
  const snapshot = structuredClone(appState);
  for (const subscriber of subscribers) {
    subscriber(snapshot);
  }
}

function applyPayload(payload = {}) {
  if (payload.meta) {
    appState.meta = payload.meta;
  }
  if (Array.isArray(payload.news)) {
    appState.news = payload.news;
  }
  if (payload.countries && typeof payload.countries === "object") {
    appState.countries = payload.countries;
  }
  if (Array.isArray(payload.hotspots)) {
    appState.hotspots = payload.hotspots;
  }
  if (payload.mapAssets && typeof payload.mapAssets === "object") {
    appState.mapAssets = payload.mapAssets;
  }
  if (Array.isArray(payload.insights)) {
    appState.insights = payload.insights;
  }
  if (payload.predictions && typeof payload.predictions === "object") {
    appState.predictions = payload.predictions;
  }
  if (Array.isArray(payload.timeseries)) {
    appState.timeseries = payload.timeseries;
  }
  if (payload.market && typeof payload.market === "object") {
    appState.market = mergeMarketPayload(appState.market, payload.market);
  }
  if (payload.impact && typeof payload.impact === "object") {
    appState.impact = payload.impact;
  }
  if (Array.isArray(payload.impactHistory)) {
    appState.impactHistory = payload.impactHistory;
  }
  if (payload.ai && typeof payload.ai === "object") {
    appState.ai = payload.ai;
  }
}

export function subscribe(listener) {
  subscribers.add(listener);
  listener(structuredClone(appState));
  return () => subscribers.delete(listener);
}

export function getState() {
  return structuredClone(appState);
}

export function setSnapshot(snapshot) {
  applyPayload(snapshot);
  notify();
}

export function applyUpdate(update) {
  applyPayload(update);
  notify();
}
