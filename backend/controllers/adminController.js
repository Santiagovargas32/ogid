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

function normalizeCoverageByMode(coverage = {}) {
  return {
    live: Number(coverage.live || 0),
    webDelayed: Number(coverage.webDelayed || 0),
    historicalEod: Number(coverage.historicalEod || 0),
    routerStale: Number(coverage.routerStale || 0),
    syntheticFallback: Number(coverage.syntheticFallback || 0)
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

function buildMarketSampleQuotes(quotes = {}, orderedTickers = [], maxItems = 5) {
  const sourceQuotes = quotes && typeof quotes === "object" ? quotes : {};
  const orderedUniverse = [
    ...new Set(
      [...(orderedTickers || []), ...Object.keys(sourceQuotes)]
        .map((ticker) => String(ticker || "").toUpperCase())
        .filter(Boolean)
    )
  ];

  return orderedUniverse
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

function buildProviderSpecificSampleQuotes(quotes = {}, orderedTickers = [], provider = "", maxItems = 5) {
  const normalizedProvider = String(provider || "").toLowerCase();
  const filteredQuotes = Object.fromEntries(
    Object.entries(quotes || {}).filter(([, quote]) => String(quote?.source || "").toLowerCase() === normalizedProvider)
  );
  return buildMarketSampleQuotes(filteredQuotes, orderedTickers, maxItems);
}

function buildProviderChain(provider = "", fallbackProvider = "") {
  return [provider, fallbackProvider].filter(Boolean).join("+") || null;
}

function buildFallbackSlot({ role, provider, marketConfig = {}, status = "idle", marketSnapshot = {}, quotaSnapshot = null } = {}) {
  const configuredBaseUrl = provider === "twelve" ? marketConfig.twelveBaseUrl : marketConfig.yahooBaseUrl;
  return {
    role,
    provider,
    transport: provider === "twelve" ? "api" : "web",
    configuredBaseUrl: configuredBaseUrl || null,
    status,
    requestMode: status === "disabled" ? "disabled" : status === "idle" ? "standby" : "unavailable",
    returnedTickers: [],
    missingTickers: [],
    score: 0,
    latencyMs: 0,
    quotaSnapshot: quotaSnapshot || apiQuotaTracker.getProviderSnapshot(provider),
    requestUrls: [],
    httpStatus: null,
    errorCode: null,
    errorMessage: null,
    responsePreview: null,
    sampleQuotes: buildProviderSpecificSampleQuotes(marketSnapshot?.quotes || {}, marketConfig?.tickers || [], provider, 5),
    lastAttemptAt: null,
    lastSuccessAt: null
  };
}

function normalizeProviderSlots({ marketEnabled, marketSnapshot = {}, marketConfig = {} } = {}) {
  const sourceMeta = marketSnapshot?.sourceMeta || {};
  const configuredProvider = marketConfig?.provider || null;
  const configuredFallbackProvider = marketConfig?.fallbackProvider || null;
  const existingSlots = Array.isArray(sourceMeta.providerSlots) ? sourceMeta.providerSlots : [];
  const slotByProvider = new Map(
    existingSlots
      .filter((slot) => slot?.provider)
      .map((slot) => [
        String(slot.provider).toLowerCase(),
        {
          ...slot,
          sampleQuotes:
            Array.isArray(slot.sampleQuotes) && slot.sampleQuotes.length
              ? slot.sampleQuotes
              : buildProviderSpecificSampleQuotes(
                  marketSnapshot?.quotes || {},
                  marketConfig?.tickers || [],
                  slot.provider,
                  5
                )
        }
      ])
  );

  const slots = [];
  if (configuredProvider) {
    slots.push(
      slotByProvider.get(configuredProvider) ||
        buildFallbackSlot({
          role: "primary",
          provider: configuredProvider,
          marketConfig,
          marketSnapshot,
          status: marketEnabled ? "idle" : "disabled"
        })
    );
  }
  if (configuredFallbackProvider) {
    slots.push(
      slotByProvider.get(configuredFallbackProvider) ||
        buildFallbackSlot({
          role: "fallback",
          provider: configuredFallbackProvider,
          marketConfig,
          marketSnapshot,
          status: marketEnabled ? "idle" : "disabled"
        })
    );
  }

  return slots;
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
      fallbackIntervalMs: config.news?.intervalMs,
      fallbackPageSize: config.news?.pageSize
    });
  const marketDelayMs = orchestrator?.resolveNextMarketDelayMs?.() ?? config.market?.activeIntervalMs ?? null;
  const newsDelayMs = orchestrator?.resolveNextNewsDelayMs?.() ?? config.news?.intervalMs ?? null;
  const marketQuotaBand = resolveBandByProviderSnapshots(marketProviderSnapshots);
  const marketEnabled = config.market?.enabled !== false;
  const marketDisabledReason = config.market?.disabledReason || "market-provider-empty";
  const marketSnapshot = intelSnapshot?.market || {};
  const marketSourceMeta = marketSnapshot?.sourceMeta || {};
  const marketCoverageByMode = marketEnabled
    ? normalizeCoverageByMode(marketSourceMeta?.coverageByMode || buildCoverageByMode(marketSnapshot?.quotes || {}))
    : { ...EMPTY_MARKET_COVERAGE };
  const marketProviderErrors = marketEnabled ? marketSourceMeta?.providerErrors || marketSourceMeta?.errors || [] : [];
  const marketProvidersUsed = marketEnabled ? marketSourceMeta?.providersUsed || [] : [];
  const marketUnresolvedTickers = marketEnabled ? marketSourceMeta?.unresolvedTickers || [] : [];
  const marketSampleQuotes = marketEnabled
    ? buildMarketSampleQuotes(marketSnapshot?.quotes || {}, config.market?.tickers || [], 5)
    : [];
  const historicalPersistence = orchestrator?.getMarketHistoryStatus?.() || {
    enabled: false,
    lastLoadedAt: null,
    lastSavedAt: null,
    snapshotPath: null
  };
  const providerChain = marketEnabled
    ? marketSourceMeta?.providerChain || config.market?.providerChain || buildProviderChain(config.market?.provider, config.market?.fallbackProvider)
    : null;
  const providerSlots = normalizeProviderSlots({
    marketEnabled,
    marketSnapshot,
    marketConfig: config.market || {}
  });
  const effectiveProvider = marketEnabled ? marketSourceMeta?.effectiveProvider || null : null;

  res.json({
    ok: true,
    data: {
      generatedAt: new Date().toISOString(),
      market: {
        enabled: marketEnabled,
        disabledReason: marketEnabled ? null : marketDisabledReason,
        quotaBand: marketEnabled ? marketQuotaBand : null,
        offHoursStrategy: marketEnabled ? config.market?.offHoursStrategy || "keep" : null,
        nextDelayMs: marketEnabled ? marketDelayMs : null,
        nextRecommendedRunAt:
          marketEnabled && Number.isFinite(marketDelayMs) ? new Date(Date.now() + marketDelayMs).toISOString() : null,
        lastStartedAt: marketCycle.lastStartedAt || null,
        lastCompletedAt: marketCycle.lastCompletedAt || null,
        lastDurationMs: marketCycle.lastDurationMs ?? null,
        lastStatus: marketEnabled ? marketCycle.lastStatus || "idle" : marketCycle.lastStatus || "disabled",
        provider: providerChain || (marketEnabled ? config.market?.provider || "unknown" : "disabled"),
        providerChain,
        configuredProvider: marketEnabled ? config.market?.provider || null : null,
        configuredFallbackProvider: marketEnabled ? config.market?.fallbackProvider || null : null,
        effectiveProvider,
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
        persistenceEligible: marketEnabled ? marketSourceMeta?.persistenceEligible === true : false,
        persistReason: marketEnabled ? marketSourceMeta?.persistReason || null : null,
        providerSlots,
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
        batchSize: marketSourceMeta?.batchSize ?? config.market?.batchChunkSize ?? null,
        lastUpstreamError: marketEnabled ? marketSourceMeta?.lastUpstreamError || null : null,
        snapshots: marketEnabled ? marketProviderSnapshots : []
      },
      news: {
        quotaBand: newsPolicy.band,
        nextDelayMs: newsDelayMs,
        nextRecommendedRunAt: Number.isFinite(newsDelayMs) ? new Date(Date.now() + newsDelayMs).toISOString() : null,
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
        limit: config.news?.rssAggregateMaxItems
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
