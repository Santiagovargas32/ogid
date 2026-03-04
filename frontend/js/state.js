const appState = {
  meta: {
    initializedAt: null,
    lastRefreshAt: null,
    refreshIntervalMs: 30_000,
    sourceMode: "initializing",
    sourceMeta: {},
    dataQuality: {}
  },
  news: [],
  countries: {},
  hotspots: [],
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
    updatedAt: null
  },
  impact: {
    items: [],
    windowMin: 120,
    updatedAt: null,
    sectorBreakdown: [],
    scatterPoints: []
  },
  impactHistory: []
};

const subscribers = new Set();

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
    appState.market = payload.market;
  }
  if (payload.impact && typeof payload.impact === "object") {
    appState.impact = payload.impact;
  }
  if (Array.isArray(payload.impactHistory)) {
    appState.impactHistory = payload.impactHistory;
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
