// Application policy lives in code. Environment variables select deployment
// endpoints, credentials and access; tests and tools may pass explicit overrides.
function freeze(value) {
  if(value && typeof value === "object") { for(const child of Object.values(value))freeze(child);Object.freeze(value); }
  return value;
}
export const RUNTIME_POLICY = freeze({
  refreshIntervalMs: 30000,
  watchlistCountries: [
    "US",
    "IL",
    "IR",
    "RU",
    "CN",
    "UA",
    "TW",
    "KP",
    "KR",
    "IN",
    "PK",
    "TR",
    "SY",
    "IQ",
    "YE",
    "SD",
    "VE",
    "CO"
  ],
  wsHeartbeatMs: 15000,
  wsTransportLimits: {
    maxMessageBytes: 65536,
    maxBufferedBytes: 262144,
    maxQueueBytes: 262144,
    maxQueueItems: 64,
    slowClientMs: 10000,
    closeGraceMs: 5000
  },
  manualRefresh: {
    cooldownMs: 120000,
    perClientWindowMs: 900000,
    perClientMax: 3
  },
  news: {
    query: "geopolitics OR conflict OR sanctions OR military",
    language: "en",
    pageSize: 50,
    timeoutMs: 9000,
    intervalMs: 60000,
    backoffMaxMs: 300000,
    analyzeLimit: 3000,
    displayLimit: 100,
    projectionIntervalMs: 60000,
    rssPollIntervalMs: 60000,
    rssFeedsPerCycle: 18,
    freshnessMs: 600000,
    dayTimeZone: "Europe/Madrid",
    candidateWindowHours: 48,
    maxPerSource: 3,
    maxSimilarHeadline: 1,
    rssAggregateIntervalMs: 30000,
    rssAggregateFeedsPerRun: 18,
    rssAggregateMaxItems: 900,
    rssPipelineMode: "canonical",
    rssGlobalConcurrency: 4,
    rssHostConcurrency: 1,
    rssCycleDeadlineMs: 25000,
    rssMaxResponseBytes: 2000000,
    rssMaxItemsPerFeed: 200,
    sourceAllowlist: [],
    domainAllowlist: [],
    retentionDays: 365,
    intervalByBandMs: {
      GREEN: 600000,
      YELLOW: 1200000,
      RED: 2700000,
      CRITICAL: 7200000
    },
    pageSizeByBand: {
      GREEN: 100,
      YELLOW: 75,
      RED: 40,
      CRITICAL: 20
    }
  },
  awareness: {
    timeoutMs: 9000,
    globalConcurrency: 2,
    hostConcurrency: 1,
    persistent403Threshold: 2,
    forbiddenCooldownMs: 3600000
  },
  ai: {
    features: [
      "market-explanation"
    ],
    timeoutMs: 180000,
    maxRetries: 1,
    maxConcurrency: 2,
    maxQueueSize: 20,
    maxJobsPerCycle: 1,
    maxInputChars: 6000,
    maxOutputTokens: 4096,
    dailyRequestBudget: 50,
    dailyTokenBudget: 100000,
    jsonMode: "auto",
    structuredOutputMode: "guided-json"
  },
  market: {
    timeoutMs: 10000,
    offHoursStrategy: "keep",
    watchlistRollout: 1,
    refreshIntervalMs: 60000,
    minTickerTtlMs: 45000,
    batchChunkSize: 25,
    staleTtlMs: 14400000,
    requestReserve: 1,
    historyPersist: true,
    activeIntervalMs: 300000,
    offHoursIntervalMs: 1800000,
    impactWindowMin: 120,
    twelveEnablePrepost: false,
    yahooUserAgent: "ogid/1.0",
    intervalByBandMs: {
      GREEN: {
        activeIntervalMs: 300000,
        offHoursIntervalMs: 1800000
      },
      YELLOW: {
        activeIntervalMs: 300000,
        offHoursIntervalMs: 1800000
      },
      RED: {
        activeIntervalMs: 900000,
        offHoursIntervalMs: 1800000
      },
      CRITICAL: {
        activeIntervalMs: 7200000,
        offHoursIntervalMs: 1800000
      }
    },
    dailyCandles: {
      enabled: true,
      adjustmentMode: "splits",
      retentionDays: 3650,
      backfillMaxDays: 30,
      equityDelayMinutes: 15,
      cryptoCloseDelayMinutes: 5
    },
    intradayCandles: {
      enabled: true,
      interval: "5min",
      pollIntervalMs: 900000,
      adjustmentMode: "splits"
    }
  },
  apiLimits: {
    newsapiDailyLimit: 100,
    newsapiDailyBudget: 90,
    gnewsDailyLimit: 100,
    gnewsDailyBudget: 90,
    mediastackMonthlyLimit: 100,
    mediastackMonthlyBudget: 80,
    rssDailyLimit: null,
    rssDailyBudget: null,
    gdeltDailyLimit: null,
    gdeltDailyBudget: null,
    yahooDailyLimit: null,
    yahooDailyBudget: null
  },
  research: {
    sec: {
      tickMs: 60000,
      maxRequestsPerCycle: 4,
      requestSpacingMs: 250,
      timeoutMs: 15000,
      maxResponseBytes: 33554432,
      submissionsIntervalMs: 900000,
      companyFactsIntervalMs: 21600000
    }
  },
  storage: {
    enabled: true,
    businessEnabled: true,
    requireImport: false,
    maxInFlight: 8,
    maxCpuInFlight: 1,
    queueMaxItems: 128,
    queueMaxBytes: 33554432,
    maxCommandBytes: 8388608,
    timeoutMs: 30000,
    queueTimeoutMs: 90000,
    startupTimeoutMs: 300000,
    shutdownTimeoutMs: 300000,
    busyTimeoutMs: 2000,
    providerTimeoutMs: 280000,
    diagnosticsIntervalMs: 300000,
    readPageRows: 128,
    readPageBytes: 1048576,
    commitBatchRows: 10,
    commitBatchBytes: 131072,
    maintenanceTimeoutMs: 300000,
    commandTimeouts: {
      "agent.snapshot": 300000,
      "agent.read": 90000,
      "domain.call:market:analyze": 90000,
      "domain.call:awareness:getSnapshot": 90000,
      "scenarios.prepare": 90000,
      "rss.fetch": 90000,
      "news.collect": 180000,
      "news.supplemental": 180000,
      "domain.configure": 300000,
      "domain.call:news:getProjection": 90000,
      "domain.call:news:getFeed": 90000,
      "domain.call:news:getLiveFeed": 90000,
      "domain.call:news:search": 90000,
      "domain.call:news:getItem": 90000,
      "domain.call:news:getHistory": 90000,
      "domain.call:news:coverage": 90000,
      "domain.call:conditions:getSnapshot": 90000,
      "domain.call:technical:get": 90000,
      "domain.call:portfolio:getContext": 90000,
      "domain.call:events:search": 90000,
      "domain.call:forecasts:evaluate": 90000,
      "domain.call:indicators:calculate": 90000,
      "domain.call:advanced:getSnapshot": 180000,
      "domain.call:map:getLayerBundle": 180000,
      "domain.call:map:getConfig": 180000
    },
    networkTimeoutMs: 180000
  }
});
