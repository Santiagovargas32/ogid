import apiQuotaTracker, { WINDOW_MS } from "../services/admin/apiQuotaTrackerService.js";
import { buildCoverageByMode } from "../services/market/quoteMetadata.js";
import { resolveBandByProviderSnapshots, resolveNewsPolicy, resolveQuotaBandFromSnapshot } from "../services/refreshPolicyService.js";
import stateManager from "../state/stateManager.js";
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

  res.json({
    ok: true,
    data: {
      generatedAt: new Date().toISOString(),
      market: {
        quotaBand: marketQuotaBand,
        nextDelayMs: marketDelayMs,
        nextRecommendedRunAt: new Date(Date.now() + marketDelayMs).toISOString(),
        provider: intelSnapshot?.market?.sourceMeta?.provider || intelSnapshot?.market?.provider || "unknown",
        requestMode: intelSnapshot?.market?.sourceMeta?.requestMode || "unavailable",
        providersSkipped: intelSnapshot?.market?.sourceMeta?.providersSkipped || [],
        usedStaleQuotes: intelSnapshot?.market?.sourceMeta?.usedStaleQuotes || [],
        coverageByMode:
          intelSnapshot?.market?.sourceMeta?.coverageByMode ||
          buildCoverageByMode(intelSnapshot?.market?.quotes || {}),
        providerErrors:
          intelSnapshot?.market?.sourceMeta?.providerErrors ||
          intelSnapshot?.market?.sourceMeta?.errors ||
          [],
        batchSize: intelSnapshot?.market?.sourceMeta?.batchSize || config.market?.batchChunkSize || 25,
        lastUpstreamError: intelSnapshot?.market?.sourceMeta?.lastUpstreamError || null,
        snapshots: marketProviderSnapshots
      },
      news: {
        quotaBand: newsPolicy.band,
        nextDelayMs: newsDelayMs,
        nextRecommendedRunAt: new Date(Date.now() + newsDelayMs).toISOString(),
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
