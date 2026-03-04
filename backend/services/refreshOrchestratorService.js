import { createLogger } from "../utils/logger.js";
import { fetchRawNews } from "./newsService.js";
import { normalizeArticles } from "./normalizeService.js";
import { computeCountryRisk } from "./riskEngineService.js";
import { generateInsights } from "./insightService.js";
import { fetchAlphaVantageQuotes } from "./market/alphaVantageService.js";
import { mergeMarketState } from "./market/marketStateService.js";
import { computeMarketImpact } from "./market/impactEngineService.js";
import { generatePredictions } from "./market/predictionEngineService.js";

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
    this.newsIntervalHandle = null;
    this.marketIntervalHandle = null;
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
        inputMode
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

      log.info("news_cycle_completed", {
        trigger,
        sourceMode: snapshot.meta.sourceMode,
        providerUsed: newsResult.sourceMeta?.provider || "unknown",
        attempts: newsResult.sourceMeta?.attempts || [],
        articleCount: snapshot.news.length,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      log.error("news_cycle_failed", {
        trigger,
        message: error.message,
        stack: error.stack
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
      const marketResult = await fetchAlphaVantageQuotes(this.config.market);
      const marketState = mergeMarketState(previousSnapshot.market, marketResult);
      const inputMode = resolveInputMode(previousSnapshot.meta?.sourceMode, marketState.sourceMode);

      const impact = computeMarketImpact({
        articles: previousSnapshot.news,
        countries: previousSnapshot.countries,
        marketQuotes: marketState.quotes,
        tickers: this.config.market.tickers,
        countryFilter: this.config.watchlistCountries,
        windowMin: this.config.market.impactWindowMin,
        inputMode
      });
      const predictions = generatePredictions({
        articles: previousSnapshot.news,
        countries: previousSnapshot.countries,
        marketQuotes: marketState.quotes,
        tickers: this.config.market.tickers,
        inputMode
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

  start() {
    if (!this.newsIntervalHandle) {
      this.runNewsCycle("startup-news").catch((error) => {
        log.error("news_cycle_startup_failed", { message: error.message });
      });

      this.newsIntervalHandle = setInterval(() => {
        this.runNewsCycle("interval-news").catch((error) => {
          log.error("news_cycle_interval_failed", { message: error.message });
        });
      }, this.config.refreshIntervalMs);
    }

    if (!this.marketIntervalHandle) {
      this.runMarketCycle("startup-market").catch((error) => {
        log.error("market_cycle_startup_failed", { message: error.message });
      });

      this.marketIntervalHandle = setInterval(() => {
        this.runMarketCycle("interval-market").catch((error) => {
          log.error("market_cycle_interval_failed", { message: error.message });
        });
      }, this.config.market.refreshIntervalMs);
    }
  }

  stop() {
    if (this.newsIntervalHandle) {
      clearInterval(this.newsIntervalHandle);
      this.newsIntervalHandle = null;
    }

    if (this.marketIntervalHandle) {
      clearInterval(this.marketIntervalHandle);
      this.marketIntervalHandle = null;
    }
  }
}

export default RefreshOrchestratorService;
