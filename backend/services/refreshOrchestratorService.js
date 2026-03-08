import { createLogger } from "../utils/logger.js";
import apiQuotaTracker from "./admin/apiQuotaTrackerService.js";
import { fetchRawNews } from "./newsService.js";
import { normalizeArticles } from "./normalizeService.js";
import { computeCountryRisk } from "./riskEngineService.js";
import { generateInsights } from "./insightService.js";
import { mergeMarketState } from "./market/marketStateService.js";
import { computeMarketImpact } from "./market/impactEngineService.js";
import { generatePredictions } from "./market/predictionEngineService.js";
import { fetchMarketQuotes } from "./market/marketProviderRouter.js";
import { resolveMarketIntervalMs } from "./market/marketSessionService.js";
import { resolveBandByProviderSnapshots, resolveNewsPolicy } from "./refreshPolicyService.js";
import { buildIntelNewsSelection } from "./news/newsSelectionService.js";

const log = createLogger("backend/services/refreshOrchestratorService");

function countByProvider(items = [], providerNames = []) {
  const counts = Object.fromEntries(
    (Array.isArray(providerNames) ? providerNames : [])
      .map((provider) => String(provider || "").toLowerCase())
      .filter(Boolean)
      .map((provider) => [provider, 0])
  );

  return items.reduce((accumulator, item) => {
    const provider = String(item?.provider || "unknown").toLowerCase();
    accumulator[provider] = (accumulator[provider] || 0) + 1;
    return accumulator;
  }, counts);
}

function resolveInputMode(newsMode = "fallback", marketMode = "fallback") {
  if (newsMode === "live" && marketMode === "live") {
    return "live";
  }
  if (newsMode === "fallback" && marketMode === "fallback") {
    return "fallback";
  }
  return "mixed";
}

class RefreshOrchestratorService {
  constructor({ stateManager, socketServer, config, rssAggregator = null, signalCorrelator = null }) {
    this.stateManager = stateManager;
    this.socketServer = socketServer;
    this.config = config;
    this.rssAggregator = rssAggregator;
    this.signalCorrelator = signalCorrelator;
    this.newsInFlight = false;
    this.marketInFlight = false;
    this.manualRefreshInFlight = false;
    this.newsTimerHandle = null;
    this.marketTimerHandle = null;
    this.stopped = true;
    this.newsBackoffMs = 0;
  }

  async refreshSecondaryIntel(snapshot) {
    let aggregateNews = { items: [] };

    if (this.rssAggregator) {
      try {
        aggregateNews = await this.rssAggregator.getSnapshot({ force: false, limit: 200 });
      } catch (error) {
        log.warn("rss_aggregate_refresh_skipped", {
          message: error.message
        });
      }
    }

    try {
      this.signalCorrelator?.recordSnapshot(snapshot, aggregateNews);
    } catch (error) {
      log.warn("signal_correlator_record_failed", {
        message: error.message
      });
    }
  }

  buildUpdatePayload(snapshot) {
    return {
      meta: snapshot.meta,
      news: snapshot.news,
      hotspots: snapshot.hotspots,
      countries: snapshot.countries,
      insights: snapshot.insights,
      predictions: snapshot.predictions,
      timeseries: snapshot.timeseries,
      market: snapshot.market,
      impact: snapshot.impact,
      impactHistory: snapshot.impactHistory
    };
  }

  getNewsBaseIntervalMs() {
    return this.config.news?.intervalMs || this.config.refreshIntervalMs || 30_000;
  }

  getNewsBackoffMaxMs() {
    return this.config.news?.backoffMaxMs || 300_000;
  }

  getNewsProviderSnapshots() {
    const providers = this.config.news?.providers || [];
    const uniqueProviders = [...new Set(providers.map((provider) => String(provider || "").toLowerCase()))];
    return uniqueProviders
      .map((provider) => apiQuotaTracker.getProviderSnapshot(provider))
      .filter(Boolean);
  }

  resolveCurrentNewsPolicy() {
    return resolveNewsPolicy({
      providerSnapshots: this.getNewsProviderSnapshots(),
      intervalByBandMs: this.config.news?.intervalByBandMs || {},
      pageSizeByBand: this.config.news?.pageSizeByBand || {},
      fallbackIntervalMs: this.getNewsBaseIntervalMs(),
      fallbackPageSize: this.config.news?.pageSize || 50
    });
  }

  resolveNextNewsDelayMs() {
    const policy = this.resolveCurrentNewsPolicy();
    return policy.intervalMs;
  }

  getMarketProviderSnapshots() {
    const providers = [this.config.market?.provider, this.config.market?.fallbackProvider]
      .map((provider) => String(provider || "").toLowerCase())
      .filter(Boolean);
    const uniqueProviders = [...new Set(providers)];
    return uniqueProviders
      .map((provider) => apiQuotaTracker.getProviderSnapshot(provider))
      .filter(Boolean);
  }

  getMarketRemainingQuota() {
    const values = this.getMarketProviderSnapshots()
      .map((snapshot) => snapshot?.effectiveRemaining)
      .filter((value) => Number.isFinite(value));

    if (!values.length) {
      return null;
    }

    return Math.min(...values);
  }

  resolveNextMarketDelayMs() {
    const quotaBand = resolveBandByProviderSnapshots(this.getMarketProviderSnapshots());
    return resolveMarketIntervalMs({
      activeIntervalMs: this.config.market?.activeIntervalMs || this.config.market?.refreshIntervalMs || 120_000,
      offHoursIntervalMs: this.config.market?.offHoursIntervalMs || 900_000,
      quotaRemaining: this.getMarketRemainingQuota(),
      quotaBand,
      bandIntervals: this.config.market?.intervalByBandMs || {}
    });
  }

  scheduleNextNewsCycle(trigger = "interval-news") {
    if (this.stopped) {
      return;
    }

    clearTimeout(this.newsTimerHandle);
    const baseIntervalMs = this.resolveNextNewsDelayMs();
    const delayMs = Math.min(baseIntervalMs + this.newsBackoffMs, this.getNewsBackoffMaxMs());
    this.newsTimerHandle = setTimeout(async () => {
      await this.runNewsCycle(trigger, { allowExhaustedProviders: false });
      this.scheduleNextNewsCycle("interval-news");
    }, delayMs);
  }

  scheduleNextMarketCycle(trigger = "interval-market") {
    if (this.stopped) {
      return;
    }

    clearTimeout(this.marketTimerHandle);
    const delayMs = this.resolveNextMarketDelayMs();
    this.marketTimerHandle = setTimeout(async () => {
      await this.runMarketCycle(trigger);
      this.scheduleNextMarketCycle("interval-market");
    }, delayMs);
  }

  async runNewsCycle(trigger = "scheduled-news", options = {}) {
    if (this.newsInFlight) {
      log.warn("news_cycle_skipped", { reason: "in-flight", trigger });
      return;
    }

    this.newsInFlight = true;
    const startedAt = Date.now();

    try {
      const previousSnapshot = this.stateManager.getSnapshot();
      const countryFilter = options.countries?.length ? options.countries : this.config.watchlistCountries;
      const policy = this.resolveCurrentNewsPolicy();
      const pageSize = options.forcePageSize || policy.pageSize;
      const newsResult = await fetchRawNews({
        ...this.config.news,
        pageSize,
        countries: countryFilter,
        allowExhaustedProviders: options.allowExhaustedProviders === true
      });
      const normalizedNews = normalizeArticles(newsResult.articles, newsResult.sourceMeta?.provider || "aggregated");
      const selection = buildIntelNewsSelection({
        articles: normalizedNews,
        previousArticles: previousSnapshot.news || [],
        watchlistCountries: countryFilter,
        analyzeLimit: this.config.news?.analyzeLimit || 80,
        candidateWindowHours: this.config.news?.candidateWindowHours || 36,
        maxPerSource: this.config.news?.maxPerSource || 3,
        maxSimilarHeadline: this.config.news?.maxSimilarHeadline || 2
      });
      const signalCorpus = selection.signalCorpus || normalizedNews;
      const selectedNews = selection.displaySelection || [];
      const newsSourceMeta = {
        ...(newsResult.sourceMeta || {}),
        selectedCountByProvider: countByProvider(selectedNews, this.config.news?.providers || []),
        signalCountByProvider: countByProvider(signalCorpus, this.config.news?.providers || []),
        selectionBySourceName: selection.selectionMeta?.selectionBySourceName || [],
        latestSelectedArticleAgeMin: selection.selectionMeta?.latestSelectedArticleAgeMin ?? null,
        selectionConfig: selection.selectionMeta?.selectionConfig || null
      };

      const riskResult = computeCountryRisk({
        articles: signalCorpus,
        previousCountries: previousSnapshot.countries
      });

      const inputMode = resolveInputMode(newsResult.sourceMode, previousSnapshot.market?.sourceMode);
      const impact = computeMarketImpact({
        articles: signalCorpus,
        countries: riskResult.countries,
        marketQuotes: previousSnapshot.market?.quotes || {},
        tickers: this.config.market.tickers,
        countryFilter,
        windowMin: this.config.market.impactWindowMin,
        inputMode,
        impactHistory: previousSnapshot.impactHistory || [],
        predictionScores: previousSnapshot.predictions?.predictionScoreByTicker || {}
      });
      const predictions = generatePredictions({
        articles: signalCorpus,
        countries: riskResult.countries,
        marketQuotes: previousSnapshot.market?.quotes || {},
        tickers: this.config.market.tickers,
        inputMode
      });
      const insights = generateInsights({
        countries: riskResult.countries,
        previousCountries: previousSnapshot.countries,
        inputMode
      });

      const snapshot = this.stateManager.updateIntel({
        news: selectedNews,
        countries: riskResult.countries,
        hotspots: riskResult.hotspots,
        insights,
        predictions,
        impact,
        signalCorpus,
        newsSourceMode: newsResult.sourceMode,
        newsSourceMeta,
        watchlistCountries: this.config.watchlistCountries
      });

      await this.refreshSecondaryIntel(snapshot);
      this.socketServer.broadcast("update", this.buildUpdatePayload(snapshot), snapshot.meta);
      this.newsBackoffMs = 0;

      log.info("news_cycle_completed", {
        trigger,
        sourceMode: snapshot.meta.sourceMode,
        providerUsed: newsResult.sourceMeta?.provider || "unknown",
        attempts: newsResult.sourceMeta?.attempts || [],
        quotaBand: policy.band,
        pageSize,
        candidateCount: signalCorpus.length,
        articleCount: snapshot.news.length,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const baseIntervalMs = this.resolveNextNewsDelayMs();
      const maxExtraBackoff = Math.max(0, this.getNewsBackoffMaxMs() - baseIntervalMs);
      this.newsBackoffMs = Math.min(maxExtraBackoff, this.newsBackoffMs ? this.newsBackoffMs * 2 : baseIntervalMs);

      log.error("news_cycle_failed", {
        trigger,
        message: error.message,
        stack: error.stack,
        nextBackoffMs: this.newsBackoffMs
      });
      this.socketServer.broadcast(
        "error",
        { message: "Refresh cycle failed", details: error.message },
        this.stateManager.getMeta()
      );
    } finally {
      this.newsInFlight = false;
    }
  }

  async runCycle(trigger = "scheduled-news") {
    return this.runNewsCycle(trigger);
  }

  async runMarketCycle(trigger = "scheduled-market", options = {}) {
    if (this.marketInFlight) {
      log.warn("market_cycle_skipped", { reason: "in-flight", trigger });
      return;
    }

    this.marketInFlight = true;
    const startedAt = Date.now();

    try {
      const previousSnapshot = this.stateManager.getSnapshot();
      const minTickerTtlMs = this.config.market?.minTickerTtlMs || 0;
      const marketUpdatedAtMs = new Date(previousSnapshot.market?.updatedAt || 0).getTime();
      const ageMs = Number.isFinite(marketUpdatedAtMs) ? Date.now() - marketUpdatedAtMs : Number.MAX_SAFE_INTEGER;
      if (trigger.startsWith("interval-") && minTickerTtlMs > 0 && ageMs < minTickerTtlMs) {
        log.info("market_cycle_skipped", {
          trigger,
          reason: "min-ticker-ttl",
          ageMs,
          minTickerTtlMs
        });
        return;
      }

      const marketResult = await fetchMarketQuotes({
        ...this.config.market,
        previousQuotes: previousSnapshot.market?.quotes || {},
        previousTimeseries: previousSnapshot.market?.timeseries || {},
        allowExhaustedProviders: options.allowExhaustedProviders === true
      });
      const marketState = mergeMarketState(previousSnapshot.market, marketResult);
      const inputMode = resolveInputMode(previousSnapshot.meta?.sourceMode, marketState.sourceMode);
      const countryFilter = options.countries?.length ? options.countries : this.config.watchlistCountries;

      const predictions = generatePredictions({
        articles: this.stateManager.getSignalCorpus(),
        countries: previousSnapshot.countries,
        marketQuotes: marketState.quotes,
        tickers: this.config.market.tickers,
        inputMode
      });
      const impact = computeMarketImpact({
        articles: this.stateManager.getSignalCorpus(),
        countries: previousSnapshot.countries,
        marketQuotes: marketState.quotes,
        tickers: this.config.market.tickers,
        countryFilter,
        windowMin: this.config.market.impactWindowMin,
        inputMode,
        impactHistory: previousSnapshot.impactHistory || [],
        predictionScores: predictions.predictionScoreByTicker || {}
      });
      const insights = generateInsights({
        countries: previousSnapshot.countries,
        previousCountries: previousSnapshot.countries,
        inputMode
      });

      const snapshot = this.stateManager.updateIntel({
        insights,
        predictions,
        market: marketState,
        impact,
        watchlistCountries: this.config.watchlistCountries
      });

      await this.refreshSecondaryIntel(snapshot);
      this.socketServer.broadcast("update", this.buildUpdatePayload(snapshot), snapshot.meta);

      log.info("market_cycle_completed", {
        trigger,
        sourceMode: marketState.sourceMode,
        providerUsed: marketResult.sourceMeta?.provider || marketState.provider || "unknown",
        liveCount: marketResult.sourceMeta?.liveCount ?? 0,
        fallbackCount:
          (marketResult.sourceMeta?.totalTickers ?? Object.keys(marketState.quotes || {}).length) -
          (marketResult.sourceMeta?.liveCount ?? 0),
        tickerCount: Object.keys(marketState.quotes || {}).length,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      log.error("market_cycle_failed", {
        trigger,
        message: error.message,
        stack: error.stack
      });
      this.socketServer.broadcast(
        "error",
        { message: "Market cycle failed", details: error.message },
        this.stateManager.getMeta()
      );
    } finally {
      this.marketInFlight = false;
    }
  }

  async waitForIdle(maxWaitMs = 20_000) {
    const startedAt = Date.now();
    while (this.newsInFlight || this.marketInFlight) {
      if (Date.now() - startedAt >= maxWaitMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }

  async runManualRefresh({ refreshId = null, trigger = "manual", countries = [] } = {}) {
    this.manualRefreshInFlight = true;
    const requestedAt = new Date().toISOString();
    const startedAt = Date.now();
    const activeCountries = countries?.length ? countries : this.config.watchlistCountries;

    const inProgressMeta = this.stateManager.setRefreshStatus({
      inProgress: true,
      lastTrigger: trigger,
      lastRequestedAt: requestedAt,
      lastRefreshId: refreshId
    });
    this.socketServer.broadcast("update", { meta: inProgressMeta }, inProgressMeta);

    try {
      await this.waitForIdle();
      await this.runNewsCycle(`${trigger}-news`, {
        allowExhaustedProviders: true,
        countries: activeCountries
      });
      await this.runMarketCycle(`${trigger}-market`, {
        countries: activeCountries,
        allowExhaustedProviders: true
      });
    } finally {
      const completedMeta = this.stateManager.setRefreshStatus({
        inProgress: false,
        lastTrigger: trigger,
        lastCompletedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastRefreshId: refreshId
      });
      this.socketServer.broadcast("update", { meta: completedMeta }, completedMeta);
      this.manualRefreshInFlight = false;
    }
  }

  start() {
    this.stopped = false;

    if (!this.newsTimerHandle) {
      this.runNewsCycle("startup-news", { allowExhaustedProviders: false })
        .catch((error) => {
          log.error("news_cycle_startup_failed", { message: error.message });
        })
        .finally(() => {
          this.scheduleNextNewsCycle("interval-news");
        });
    }

    if (!this.marketTimerHandle) {
      this.runMarketCycle("startup-market")
        .catch((error) => {
          log.error("market_cycle_startup_failed", { message: error.message });
        })
        .finally(() => {
          this.scheduleNextMarketCycle("interval-market");
        });
    }
  }

  stop() {
    this.stopped = true;
    if (this.newsTimerHandle) {
      clearTimeout(this.newsTimerHandle);
      this.newsTimerHandle = null;
    }

    if (this.marketTimerHandle) {
      clearTimeout(this.marketTimerHandle);
      this.marketTimerHandle = null;
    }
  }
}

export default RefreshOrchestratorService;
