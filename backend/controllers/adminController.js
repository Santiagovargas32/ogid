import apiQuotaTracker, { MINUTE_WINDOW_MS, WINDOW_MS } from "../services/admin/apiQuotaTrackerService.js";
import { buildCoverageByMode } from "../services/market/quoteMetadata.js";
import { normalizeAdminArticles } from "../services/normalizeService.js";
import { resolveBandByProviderSnapshots, resolveNewsPolicy, resolveQuotaBandFromSnapshot } from "../services/refreshPolicyService.js";
import stateManager from "../state/stateManager.js";
import { AppError } from "../utils/error.js";
import { parsePositiveInt } from "../utils/filters.js";
import { getRecentLogs } from "../utils/logger.js";

const EMPTY_MARKET_COVERAGE = Object.freeze({
  live: 0,
  webDelayed: 0,
  historicalEod: 0,
  routerStale: 0,
  syntheticFallback: 0
});

function inferCycleFromScope(scope = "", message = "") {
  const normalizedScope = String(scope || "").toLowerCase();
  const normalizedMessage = String(message || "").toLowerCase();
  if (normalizedScope.includes("news") || normalizedMessage.includes("news_") || normalizedScope.includes("rssprovider")) {
    return "news";
  }
  if (normalizedScope.includes("market") || normalizedMessage.includes("market_")) {
    return "market";
  }
  return "system";
}

function inferProviderFromLog(entry = {}) {
  if (entry.provider) {
    return entry.provider;
  }
  const scope = String(entry.scope || "").toLowerCase();
  const message = String(entry.message || entry.details || entry.reason || "").toLowerCase();
  if (scope.includes("twelve") || message.includes("twelve")) {
    return "twelve";
  }
  if (scope.includes("yahoo") || message.includes("yahoo")) {
    return "yahoo";
  }
  if (scope.includes("fmp")) {
    return "fmp";
  }
  if (scope.includes("webquoteprovider")) {
    return "web";
  }
  if (scope.includes("gdelt")) {
    return "gdelt";
  }
  if (scope.includes("rss")) {
    return "rss";
  }
  if (scope.includes("gnews")) {
    return "gnews";
  }
  if (scope.includes("newsapi")) {
    return "newsapi";
  }
  if (scope.includes("mediastack")) {
    return "mediastack";
  }
  return "unknown";
}

function inferCode(entry = {}) {
  return entry.code || entry.reason || entry.errorCode || entry.message || "unknown-error";
}

function buildRecentCycleErrors(limit = 12) {
  return getRecentLogs({ limit: Math.max(limit * 2, 24) })
    .filter((entry) => {
      const scope = String(entry.scope || "").toLowerCase();
      return scope.includes("backend/services/");
    })
    .slice(-limit)
    .map((entry) => ({
      cycle: inferCycleFromScope(entry.scope, entry.message),
      provider: inferProviderFromLog(entry),
      code: inferCode(entry),
      message: entry.message || entry.details || entry.reason || "unknown-error",
      at: entry.timestamp
    }));
}

function sumCountRecord(record = {}) {
  return Object.values(record || {}).reduce((total, value) => total + (Number(value) || 0), 0);
}

function normalizeCoverageByMode(coverage = {}) {
  return {
    live: Number(coverage.live || 0),
    webDelayed: Number(coverage.webDelayed || 0),
    historicalEod: Number(coverage.historicalEod || 0),
    routerStale: Number(coverage.routerStale || 0),
    syntheticFallback: Number(coverage.syntheticFallback || 0)
  };
}

function buildMarketSampleQuotes(quotes = {}, orderedTickers = [], maxItems = 5) {
  const sourceQuotes = quotes && typeof quotes === "object" ? quotes : {};
  const preferredTickers = [...new Set((orderedTickers || []).map((ticker) => String(ticker || "").toUpperCase()).filter(Boolean))];
  const remainingTickers = Object.keys(sourceQuotes)
    .map((ticker) => String(ticker || "").toUpperCase())
    .filter((ticker) => !preferredTickers.includes(ticker));
  const orderedUniverse = [...preferredTickers, ...remainingTickers];
  const webTickers = orderedUniverse.filter((ticker) => {
    const quote = sourceQuotes[ticker];
    return quote?.source === "web" || quote?.dataMode === "web-delayed";
  });
  const nonWebTickers = orderedUniverse.filter((ticker) => !webTickers.includes(ticker));

  return [...webTickers, ...nonWebTickers]
    .map((ticker) => {
      const quote = sourceQuotes[ticker];
      if (!quote) {
        return null;
      }

      return {
        ticker,
        price: Number.isFinite(Number(quote.price)) ? Number(quote.price) : null,
        asOf: quote.asOf || quote.updatedAt || null,
        source: quote.source || null,
        sourceDetail: quote.sourceDetail || null,
        dataMode: quote.dataMode || null,
        providerScore: Number.isFinite(Number(quote.providerScore)) ? Number(quote.providerScore) : null,
        providerLatencyMs: Number.isFinite(Number(quote.providerLatencyMs)) ? Number(quote.providerLatencyMs) : null,
        marketState: quote.marketState || null
      };
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function resolveMarketProviderStatus({
  marketEnabled,
  diagnostic = {},
  fallbackProviderUsed = false,
  usedStaleQuotes = [],
  syntheticFallbackCount = 0,
  providerErrors = []
}) {
  if (!marketEnabled) {
    return "disabled";
  }

  if (!diagnostic) {
    return "idle";
  }

  if (diagnostic.providerDisabledReason) {
    return "disabled";
  }

  const returnedCount = Number((diagnostic.returnedTickers || []).length || 0);
  if (!diagnostic.lastAttemptAt && returnedCount <= 0) {
    return "idle";
  }

  if (returnedCount <= 0) {
    return "error";
  }

  if (
    fallbackProviderUsed ||
    Number((diagnostic.missingTickers || []).length || 0) > 0 ||
    usedStaleQuotes.length > 0 ||
    syntheticFallbackCount > 0 ||
    (providerErrors || []).length > 0
  ) {
    return "partial";
  }

  return "ok";
}

function buildProviderSpecificSampleQuotes(quotes = {}, orderedTickers = [], provider = "web", maxItems = 5) {
  const targetProvider = String(provider || "").toLowerCase();
  const filteredQuotes = Object.fromEntries(
    Object.entries(quotes || {}).filter(([, quote]) => String(quote?.source || "").toLowerCase() === targetProvider)
  );
  return buildMarketSampleQuotes(filteredQuotes, orderedTickers, maxItems);
}

function resolveConfiguredMarketSource(providerKey = "", marketConfig = {}) {
  const targetProvider = String(providerKey || "").toLowerCase();
  if (targetProvider === "web") {
    return marketConfig.webSource || "twelve";
  }

  if (targetProvider === "fmp") {
    return marketConfig.fmpStableBaseUrl || marketConfig.fmpBaseUrl || "https://financialmodelingprep.com/stable";
  }

  return null;
}

function resolveWebSourceAttempts(sourceDiagnostic = {}, marketSnapshot = {}) {
  if (Array.isArray(sourceDiagnostic?.sourceAttempts) && sourceDiagnostic.sourceAttempts.length) {
    return sourceDiagnostic.sourceAttempts;
  }

  if (Array.isArray(marketSnapshot?.sourceMeta?.sourceAttempts) && marketSnapshot.sourceMeta.sourceAttempts.length) {
    return marketSnapshot.sourceMeta.sourceAttempts;
  }

  return [];
}

function resolveWebSourceSnapshots(sourceDiagnostic = {}, marketSnapshot = {}) {
  if (sourceDiagnostic?.sourceSnapshots && typeof sourceDiagnostic.sourceSnapshots === "object") {
    return sourceDiagnostic.sourceSnapshots;
  }

  if (marketSnapshot?.sourceMeta?.sourceSnapshots && typeof marketSnapshot.sourceMeta.sourceSnapshots === "object") {
    return marketSnapshot.sourceMeta.sourceSnapshots;
  }

  return {};
}

function buildMarketProviderDiagnostics({
  providerKey,
  marketEnabled,
  providerDiagnostics = {},
  marketConfig = {},
  marketSnapshot = {},
  coverageByMode,
  providerErrors = []
}) {
  const targetProvider = String(providerKey || "").toLowerCase();
  const sourceDiagnostic = providerDiagnostics?.[targetProvider] || null;
  const providersUsed = marketEnabled ? marketSnapshot?.sourceMeta?.providersUsed || [] : [];
  const fallbackProviderUsed = providersUsed.some((provider) => String(provider || "").toLowerCase() !== targetProvider);
  const providerSpecificErrors = (providerErrors || []).filter(
    (error) => String(error?.provider || "").toLowerCase() === targetProvider
  );
  const sampleQuotes = marketEnabled
    ? buildProviderSpecificSampleQuotes(marketSnapshot?.quotes || {}, marketConfig?.tickers || [], targetProvider, 5)
    : [];
  const configuredSource = resolveConfiguredMarketSource(targetProvider, marketConfig);
  const sourceAttempts = targetProvider === "web" ? resolveWebSourceAttempts(sourceDiagnostic, marketSnapshot) : [];
  const sourceSnapshots = targetProvider === "web" ? resolveWebSourceSnapshots(sourceDiagnostic, marketSnapshot) : {};

  const enrichedDiagnostic = {
    configuredSource,
    configuredProvider: marketConfig.provider || null,
    configuredFallbackProvider: marketConfig.fallbackProvider || null,
    primaryProvider: marketConfig.provider || null,
    returnedCount: Number(sourceDiagnostic?.returnedTickers?.length || sourceDiagnostic?.returnedCount || 0),
    returnedTickers: sourceDiagnostic?.returnedTickers || [],
    coverageByMode,
    providersUsed,
    providersSkipped: marketSnapshot?.sourceMeta?.providersSkipped || [],
    unresolvedTickers: marketSnapshot?.sourceMeta?.unresolvedTickers || [],
    errors: providerSpecificErrors,
    sampleQuotes,
    effectiveSource:
      sourceDiagnostic?.effectiveSource ||
      (targetProvider === "web" ? marketSnapshot?.sourceMeta?.effectiveSource || null : null),
    sourceAttempts,
    sourceSnapshots,
    ...sourceDiagnostic
  };

  return {
    ...enrichedDiagnostic,
    status: resolveMarketProviderStatus({
      marketEnabled,
      diagnostic: enrichedDiagnostic,
      fallbackProviderUsed,
      usedStaleQuotes: marketSnapshot?.sourceMeta?.usedStaleQuotes || [],
      syntheticFallbackCount: Number(coverageByMode?.syntheticFallback || 0),
      providerErrors: providerSpecificErrors
    })
  };
}

function paginateItems(items = [], page = 1, pageSize = 100) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * pageSize;

  return {
    items: items.slice(startIndex, startIndex + pageSize),
    pagination: {
      page: currentPage,
      pageSize,
      totalItems,
      totalPages
    }
  };
}

export function getApiLimits(_req, res) {
  res.json({
    ok: true,
    data: {
      window: {
        day: {
          hours: 24,
          ms: WINDOW_MS
        },
        minute: {
          minutes: 1,
          ms: MINUTE_WINDOW_MS
        },
        hours: 24,
        ms: WINDOW_MS
      },
      providers: apiQuotaTracker.getSnapshot().map((provider) => ({
        ...provider,
        quotaBand: resolveQuotaBandFromSnapshot(provider)
      })),
      generatedAt: new Date().toISOString()
    }
  });
}

export function getPipelineStatus(_req, res) {
  const orchestrator = res.app.locals.orchestrator;
  const config = res.app.locals.config;
  const intelSnapshot = stateManager.getSnapshot();
  const marketProviderSnapshots = orchestrator?.getMarketProviderSnapshots?.() || [];
  const newsProviderSnapshots = orchestrator?.getNewsProviderSnapshots?.() || [];
  const newsCycle = orchestrator?.getNewsCycleTelemetry?.() || {};
  const marketCycle = orchestrator?.getMarketCycleTelemetry?.() || {};
  const newsPolicy =
    orchestrator?.resolveCurrentNewsPolicy?.() ||
    resolveNewsPolicy({
      providerSnapshots: newsProviderSnapshots,
      intervalByBandMs: config.news?.intervalByBandMs || {},
      pageSizeByBand: config.news?.pageSizeByBand || {},
      fallbackIntervalMs: config.news?.intervalMs || 30_000,
      fallbackPageSize: config.news?.pageSize || 50
    });
  const marketDelayMs = orchestrator?.resolveNextMarketDelayMs?.() || config.market?.activeIntervalMs || 180_000;
  const newsDelayMs = orchestrator?.resolveNextNewsDelayMs?.() || config.news?.intervalMs || 30_000;
  const marketQuotaBand = resolveBandByProviderSnapshots(marketProviderSnapshots);
  const marketEnabled = config.market?.enabled !== false;
  const marketDisabledReason = config.market?.disabledReason || "market-provider-empty";
  const marketSnapshot = intelSnapshot?.market || {};
  const marketSourceMeta = marketSnapshot?.sourceMeta || {};
  const marketCoverageByMode = marketEnabled
    ? normalizeCoverageByMode(
        marketSourceMeta?.coverageByMode ||
          buildCoverageByMode(marketSnapshot?.quotes || {})
      )
    : { ...EMPTY_MARKET_COVERAGE };
  const marketProviderErrors = marketEnabled
    ? marketSourceMeta?.providerErrors ||
      marketSourceMeta?.errors ||
      []
    : [];
  const marketProvidersUsed = marketEnabled ? marketSourceMeta?.providersUsed || [] : [];
  const marketUnresolvedTickers = marketEnabled ? marketSourceMeta?.unresolvedTickers || [] : [];
  const marketSampleQuotes = marketEnabled
    ? buildMarketSampleQuotes(marketSnapshot?.quotes || {}, config.market?.tickers || [], 5)
    : [];
  const sourceDiagnostics = marketEnabled ? marketSourceMeta?.providerDiagnostics || {} : {};
  const marketWebDiagnostics = buildMarketProviderDiagnostics({
    providerKey: "web",
    marketEnabled,
    providerDiagnostics: sourceDiagnostics,
    marketConfig: config.market || {},
    marketSnapshot,
    coverageByMode: marketCoverageByMode,
    providerErrors: marketProviderErrors
  });
  const marketApiDiagnostics = buildMarketProviderDiagnostics({
    providerKey: "fmp",
    marketEnabled,
    providerDiagnostics: sourceDiagnostics,
    marketConfig: config.market || {},
    marketSnapshot,
    coverageByMode: marketCoverageByMode,
    providerErrors: marketProviderErrors
  });
  const historicalPersistence = orchestrator?.getMarketHistoryStatus?.() || {
    enabled: false,
    lastLoadedAt: null,
    lastSavedAt: null,
    snapshotPath: null
  };
  const effectiveSource = marketEnabled
    ? marketSourceMeta?.effectiveSource || marketWebDiagnostics.effectiveSource || null
    : null;
  const sourceAttempts = marketEnabled ? marketSourceMeta?.sourceAttempts || marketWebDiagnostics.sourceAttempts || [] : [];
  const sourceSnapshots = marketEnabled
    ? marketSourceMeta?.sourceSnapshots || marketWebDiagnostics.sourceSnapshots || {}
    : {};

  res.json({
    ok: true,
    data: {
      generatedAt: new Date().toISOString(),
      market: {
        enabled: marketEnabled,
        disabledReason: marketEnabled ? null : marketDisabledReason,
        quotaBand: marketEnabled ? marketQuotaBand : null,
        nextDelayMs: marketEnabled ? marketDelayMs : null,
        nextRecommendedRunAt: marketEnabled && marketDelayMs ? new Date(Date.now() + marketDelayMs).toISOString() : null,
        lastStartedAt: marketCycle.lastStartedAt || null,
        lastCompletedAt: marketCycle.lastCompletedAt || null,
        lastDurationMs: marketCycle.lastDurationMs ?? null,
        lastStatus: marketEnabled ? marketCycle.lastStatus || "idle" : marketCycle.lastStatus || "disabled",
        provider: marketEnabled ? marketSourceMeta?.provider || marketSnapshot?.provider || "unknown" : "disabled",
        configuredProvider: marketEnabled ? config.market?.provider || null : null,
        configuredFallbackProvider: marketEnabled ? config.market?.fallbackProvider || null : null,
        effectiveProvider:
          marketEnabled
            ? marketSourceMeta?.effectiveProvider ||
              marketApiDiagnostics.effectiveProvider ||
              marketWebDiagnostics.effectiveProvider ||
              marketSnapshot?.provider ||
              null
            : null,
        effectiveSource,
        providerScore: marketEnabled ? marketSourceMeta?.providerScore ?? null : null,
        providerLatencyMs: marketEnabled ? marketSourceMeta?.providerLatencyMs ?? null : null,
        revision: marketEnabled ? marketSnapshot?.revision || null : null,
        session: marketSnapshot?.session || marketSourceMeta?.marketSession || null,
        sourceMode: marketEnabled ? marketSnapshot?.sourceMode || "fallback" : "disabled",
        requestMode: marketEnabled ? marketSourceMeta?.requestMode || "unavailable" : "disabled",
        providersUsed: marketProvidersUsed,
        providersSkipped: marketEnabled ? marketSourceMeta?.providersSkipped || [] : [],
        unresolvedTickers: marketUnresolvedTickers,
        usedStaleQuotes: marketEnabled ? marketSourceMeta?.usedStaleQuotes || [] : [],
        coverageByMode: marketCoverageByMode,
        providerErrors: marketProviderErrors,
        sampleQuotes: marketSampleQuotes,
        sourceAttempts,
        sourceSnapshots,
        persistenceEligible: marketEnabled ? marketSourceMeta?.persistenceEligible === true : false,
        persistReason: marketEnabled ? marketSourceMeta?.persistReason || null : null,
        webDiagnostics: marketWebDiagnostics,
        providerDiagnostics: {
          web: marketWebDiagnostics,
          fmp: marketApiDiagnostics
        },
        routerDecision: marketEnabled
          ? marketSourceMeta?.routerDecision || {
              attemptedOrder: [],
              providersSkipped: [],
              usedStaleQuotes: [],
              syntheticFallbackTickers: [],
              fallbackReason: null
            }
          : {
              attemptedOrder: [],
              providersSkipped: [],
              usedStaleQuotes: [],
              syntheticFallbackTickers: [],
              fallbackReason: "market-provider-empty"
            },
        historicalPersistence,
        batchSize: marketSourceMeta?.batchSize || config.market?.batchChunkSize || 25,
        lastUpstreamError: marketEnabled ? marketSourceMeta?.lastUpstreamError || null : null,
        snapshots: marketEnabled ? marketProviderSnapshots : []
      },
      news: {
        quotaBand: newsPolicy.band,
        nextDelayMs: newsDelayMs,
        nextRecommendedRunAt: new Date(Date.now() + newsDelayMs).toISOString(),
        lastStartedAt: newsCycle.lastStartedAt || null,
        lastCompletedAt: newsCycle.lastCompletedAt || null,
        lastDurationMs: newsCycle.lastDurationMs ?? null,
        lastStatus: newsCycle.lastStatus || "idle",
        provider: intelSnapshot?.meta?.sourceMeta?.provider || "unknown",
        pageSize: newsPolicy.pageSize,
        providersSkipped: intelSnapshot?.meta?.sourceMeta?.providersSkipped || [],
        attempts: intelSnapshot?.meta?.sourceMeta?.attempts || [],
        rawCountByProvider: intelSnapshot?.meta?.sourceMeta?.rawCountByProvider || {},
        selectedCountByProvider: intelSnapshot?.meta?.sourceMeta?.selectedCountByProvider || {},
        selectionBySourceName: intelSnapshot?.meta?.sourceMeta?.selectionBySourceName || [],
        latestSelectedArticleAgeMin: intelSnapshot?.meta?.sourceMeta?.latestSelectedArticleAgeMin ?? null,
        selectionConfig: intelSnapshot?.meta?.sourceMeta?.selectionConfig || null,
        rssFeedStatus: intelSnapshot?.meta?.sourceMeta?.rssFeedStatus || [],
        queryLengthByProvider: intelSnapshot?.meta?.sourceMeta?.queryLengthByProvider || {},
        snapshots: newsProviderSnapshots
      },
      recentCycleErrors: buildRecentCycleErrors()
    }
  });
}

export async function getNewsRaw(req, res) {
  const dataset = String(req.query.dataset || "intel").trim().toLowerCase();
  const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 10_000 });
  const pageSize = parsePositiveInt(req.query.pageSize, 100, { min: 10, max: 250 });

  if (!["intel", "rss-aggregate"].includes(dataset)) {
    throw new AppError("Unsupported admin raw dataset.", 400, "INVALID_DATASET", {
      dataset
    });
  }

  if (dataset === "intel") {
    const intelRawNews = stateManager.getAdminIntelRawNews();
    const paginated = paginateItems(intelRawNews.items || [], page, pageSize);

    res.json({
      ok: true,
      data: {
        dataset,
        generatedAt: intelRawNews.generatedAt || null,
        summary: {
          rawTotal: Number(intelRawNews.summary?.rawTotal || 0),
          selectedTotal: Number(intelRawNews.summary?.selectedTotal || 0),
          queryLengthTotal: Number(intelRawNews.summary?.queryLengthTotal || 0),
          rawCountByProvider: intelRawNews.summary?.rawCountByProvider || {},
          selectedCountByProvider: intelRawNews.summary?.selectedCountByProvider || {},
          queryLengthByProvider: intelRawNews.summary?.queryLengthByProvider || {}
        },
        pagination: paginated.pagination,
        items: paginated.items
      }
    });
    return;
  }

  const config = res.app.locals.config;
  const aggregator = res.app.locals.rssAggregator;
  const aggregateSnapshot = aggregator
    ? await aggregator.getSnapshot({
        force: false,
        limit: config.news?.rssAggregateMaxItems || 900
      })
    : { generatedAt: null, items: [] };
  const normalizedItems = normalizeAdminArticles(aggregateSnapshot.items || [], "rss-aggregate");
  const paginated = paginateItems(normalizedItems, page, pageSize);

  res.json({
    ok: true,
    data: {
      dataset,
      generatedAt: aggregateSnapshot.generatedAt || null,
      summary: {
        rawTotal: normalizedItems.length
      },
      pagination: paginated.pagination,
      items: paginated.items
    }
  });
}
