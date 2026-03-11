import apiQuotaTracker, { WINDOW_MS } from "../services/admin/apiQuotaTrackerService.js";
import { buildCoverageByMode } from "../services/market/quoteMetadata.js";
import { normalizeAdminArticles } from "../services/normalizeService.js";
import { resolveBandByProviderSnapshots, resolveNewsPolicy, resolveQuotaBandFromSnapshot } from "../services/refreshPolicyService.js";
import stateManager from "../state/stateManager.js";
import { AppError } from "../utils/error.js";
import { parsePositiveInt } from "../utils/filters.js";
import { getRecentLogs } from "../utils/logger.js";

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
  if (scope.includes("alphavantage")) {
    return "alphavantage";
  }
  if (scope.includes("fmp")) {
    return "fmp";
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
        provider: marketEnabled ? intelSnapshot?.market?.sourceMeta?.provider || intelSnapshot?.market?.provider || "unknown" : "disabled",
        sourceMode: marketEnabled ? intelSnapshot?.market?.sourceMode || "fallback" : "disabled",
        requestMode: marketEnabled ? intelSnapshot?.market?.sourceMeta?.requestMode || "unavailable" : "disabled",
        providersSkipped: marketEnabled ? intelSnapshot?.market?.sourceMeta?.providersSkipped || [] : [],
        usedStaleQuotes: marketEnabled ? intelSnapshot?.market?.sourceMeta?.usedStaleQuotes || [] : [],
        coverageByMode:
          marketEnabled
            ? intelSnapshot?.market?.sourceMeta?.coverageByMode ||
              buildCoverageByMode(intelSnapshot?.market?.quotes || {})
            : { live: 0, historicalEod: 0, routerStale: 0, syntheticFallback: 0 },
        providerErrors:
          marketEnabled
            ? intelSnapshot?.market?.sourceMeta?.providerErrors ||
              intelSnapshot?.market?.sourceMeta?.errors ||
              []
            : [],
        batchSize: intelSnapshot?.market?.sourceMeta?.batchSize || config.market?.batchChunkSize || 25,
        lastUpstreamError: marketEnabled ? intelSnapshot?.market?.sourceMeta?.lastUpstreamError || null : null,
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
