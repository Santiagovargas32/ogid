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

const log = createLogger("backend/services/refreshOrchestratorService");

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
  constructor({ stateManager, socketServer, config }) {
    this.stateManager = stateManager;
    this.socketServer = socketServer;
    this.config = config;
    this.newsInFlight = false;
    this.marketInFlight = false;
    this.newsTimerHandle = null;
    this.marketTimerHandle = null;
    this.stopped = true;
    this.newsBackoffMs = 0;
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

  getMarketRemainingQuota() {
    const providers = [this.config.market?.provider, this.config.market?.fallbackProvider]
      .map((provider) => String(provider || "").toLowerCase())
      .filter(Boolean);
    const uniqueProviders = [...new Set(providers)];
    const values = uniqueProviders
      .map((provider) => apiQuotaTracker.getProviderSnapshot(provider)?.effectiveRemaining)
      .filter((value) => Number.isFinite(value));

    if (!values.length) {
      return null;
    }

    return Math.min(...values);
  }

  resolveNextMarketDelayMs() {
    return resolveMarketIntervalMs({
      activeIntervalMs: this.config.market?.activeIntervalMs || this.config.market?.refreshIntervalMs || 120_000,
      offHoursIntervalMs: this.config.market?.offHoursIntervalMs || 900_000,
      quotaRemaining: this.getMarketRemainingQuota()
    });
  }

  scheduleNextNewsCycle(trigger = "interval-news") {
    if (this.stopped) {
      return;
    }

    clearTimeout(this.newsTimerHandle);
    const baseIntervalMs = this.getNewsBaseIntervalMs();
    const delayMs = Math.min(baseIntervalMs + this.newsBackoffMs, this.getNewsBackoffMaxMs());
    this.newsTimerHandle = setTimeout(async () => {
      await this.runNewsCycle(trigger);
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

  async runNewsCycle(trigger = "scheduled-news") {
    if (this.newsInFlight) {
      log.warn("news_cycle_skipped", { reason: "in-flight", trigger });
      return;
    }

    this.newsInFlight = true;
    const startedAt = Date.now();

    try {
      const previousSnapshot = this.stateManager.getSnapshot();
      const newsResult = await fetchRawNews(this.config.news);
      const normalizedNews = normalizeArticles(newsResult.articles, "newsapi");
      const riskResult = computeCountryRisk({
        articles: normalizedNews,
        previousCountries: previousSnapshot.countries
      });

      const inputMode = resolveInputMode(newsResult.sourceMode, previousSnapshot.market?.sourceMode);
      const impact = computeMarketImpact({
        articles: normalizedNews,
        countries: riskResult.countries,
        marketQuotes: previousSnapshot.market?.quotes || {},
        tickers: this.config.market.tickers,
        countryFilter: this.config.watchlistCountries,
        windowMin: this.config.market.impactWindowMin,
        inputMode,
        impactHistory: previousSnapshot.impactHistory || [],
        predictionScores: previousSnapshot.predictions?.predictionScoreByTicker || {}
      });
      const predictions = generatePredictions({
        articles: normalizedNews,
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
        news: normalizedNews,
        countries: riskResult.countries,
        hotspots: riskResult.hotspots,
        insights,
        predictions,
        impact,
        newsSourceMode: newsResult.sourceMode,
        newsSourceMeta: newsResult.sourceMeta,
        watchlistCountries: this.config.watchlistCountries
      });

      this.socketServer.broadcast("update", this.buildUpdatePayload(snapshot), snapshot.meta);
      this.newsBackoffMs = 0;

      log.info("news_cycle_completed", {
        trigger,
        sourceMode: snapshot.meta.sourceMode,
        providerUsed: newsResult.sourceMeta?.provider || "unknown",
        attempts: newsResult.sourceMeta?.attempts || [],
        articleCount: snapshot.news.length,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const baseIntervalMs = this.getNewsBaseIntervalMs();
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

  async runMarketCycle(trigger = "scheduled-market") {
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

      const marketResult = await fetchMarketQuotes(this.config.market);
      const marketState = mergeMarketState(previousSnapshot.market, marketResult);
      const inputMode = resolveInputMode(previousSnapshot.meta?.sourceMode, marketState.sourceMode);

      const predictions = generatePredictions({
        articles: previousSnapshot.news,
        countries: previousSnapshot.countries,
        marketQuotes: marketState.quotes,
        tickers: this.config.market.tickers,
        inputMode
      });
      const impact = computeMarketImpact({
        articles: previousSnapshot.news,
        countries: previousSnapshot.countries,
        marketQuotes: marketState.quotes,
        tickers: this.config.market.tickers,
        countryFilter: this.config.watchlistCountries,
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

      this.socketServer.broadcast("update", this.buildUpdatePayload(snapshot), snapshot.meta);

      log.info("market_cycle_completed", {
        trigger,
        sourceMode: marketState.sourceMode,
        providerUsed: marketResult.sourceMeta?.provider || marketState.provider || "unknown",
        liveCount: marketResult.sourceMeta?.liveCount ?? 0,
        fallbackCount: (marketResult.sourceMeta?.totalTickers ?? Object.keys(marketState.quotes || {}).length) -
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

  start() {
    this.stopped = false;

    if (!this.newsTimerHandle) {
      this.runNewsCycle("startup-news")
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
