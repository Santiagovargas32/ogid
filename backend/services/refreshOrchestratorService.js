import { createLogger } from "../utils/logger.js";
import apiQuotaTracker from "./admin/apiQuotaTrackerService.js";
import { calculateMarketProjection } from "./market/marketProjection.js";
import { fetchRawNews } from "./newsService.js";
import { normalizeAdminArticles, normalizeArticles } from "./normalizeService.js";
import { computeCountryRisk } from "./riskEngineService.js";
import { generateInsights } from "./insightService.js";
import { mergeMarketState, refreshMarketSessionMetadata } from "./market/marketStateService.js";
import { computeMarketImpact } from "./market/impactEngineService.js";
import { generatePredictions } from "./market/predictionEngineService.js";
import { fetchMarketQuotes } from "./market/marketProviderRouter.js";
import { isMarketOpenEt, resolveMarketIntervalMs } from "./market/marketSessionService.js";
import { resolveVerifiedInstrumentReferences } from "./market/instrumentRegistry.js";
import { resolveBandByProviderSnapshots, resolveNewsPolicy } from "./refreshPolicyService.js";
import { buildIntelNewsSelection } from "./news/newsSelectionService.js";
import {
  buildFinancialNewsSelection,
  buildNewsLaneRotation,
  partitionNewsArticles
} from "./news/financialNewsService.js";

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

function createCycleTelemetry() {
  return {
    lastStartedAt: null,
    lastCompletedAt: null,
    lastDurationMs: null,
    lastStatus: "idle",
    lastTrigger: null,
    lastError: null
  };
}

function sumCountRecord(record = {}) {
  return Object.values(record || {}).reduce((total, value) => total + (Number(value) || 0), 0);
}

function normalizeOffHoursStrategy(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["skip", "yahoo", "keep"].includes(normalized) ? normalized : "keep";
}

function isAutomatedMarketTrigger(trigger = "") {
  const normalized = String(trigger || "").trim().toLowerCase();
  return normalized === "startup-market" || normalized.startsWith("interval-market");
}

function mergeArticleCorpora(...corpora) {
  const seen = new Set();
  return corpora.flat().filter((article) => {
    const key = String(article?.id || article?.url || article?.title || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

class RefreshOrchestratorService {
  constructor({
    stateManager,
    socketServer,
    config,
    rssAggregator = null,
    signalCorrelator = null,
    mapLayerService = null,
    marketHistoryStore = null,
    dailyCandleService = null,
    intradayCandleService = null,
    aiCoordinator = null,
    newsArchive = null,
    awarenessService = null
  }) {
    this.stateManager = stateManager;
    this.socketServer = socketServer;
    this.config = config;
    this.rssAggregator = rssAggregator;
    this.signalCorrelator = signalCorrelator;
    this.mapLayerService = mapLayerService;
    this.marketHistoryStore = marketHistoryStore;
    this.dailyCandleService = dailyCandleService;
    this.intradayCandleService = intradayCandleService;
    this.aiCoordinator = aiCoordinator;
    this.newsArchive = newsArchive;
    this.awarenessService = awarenessService;
    this.pendingCycles = new Set();
    this.newsTask = null;
    this.marketTask = null;
    this.rssSelectionPending = false;
    this.cycleMetrics = { newsJoined: 0, marketJoined: 0, rssCoalesced: 0 };
    this.newsInFlight = false;
    this.marketInFlight = false;
    this.manualRefreshInFlight = false;
    this.newsTimerHandle = null;
    this.marketTimerHandle = null;
    this.stopped = true;
    this.newsBackoffMs = 0;
    this.newsCycleTelemetry = createCycleTelemetry();
    this.marketCycleTelemetry = createCycleTelemetry();
    this.newsLaneOffset = 0;
    this.financialQueryPackOffset = 0;
    this.financialTickerOffset = 0;
    if (!this.isMarketEnabled()) {
      this.markMarketTelemetryDisabled();
    }
  }

  isMarketEnabled() {
    return this.config.market?.enabled !== false;
  }

  markMarketTelemetryDisabled() {
    this.marketCycleTelemetry = {
      ...this.marketCycleTelemetry,
      lastStatus: "disabled",
      lastError: this.config.market?.disabledReason || "market-provider-empty"
    };
  }

  async resolveAggregateNewsSnapshot() {
    if (this.newsArchive?.getFeed) return this.newsArchive.getFeed({limit:this.config.news?.rssAggregateMaxItems || 900});
    if (!this.rssAggregator) {
      return { items: [] };
    }

    try {
      return await this.rssAggregator.getSnapshot({
        force: false,
        stored: true,
        limit: this.config.news?.rssAggregateMaxItems
      });
    } catch (error) {
      log.warn("rss_aggregate_refresh_skipped", {
        message: error.message
      });
      return { items: [] };
    }
  }

  async refreshSecondaryIntel(snapshot, aggregateNews = { items: [] }) {
    const resolvedAggregateNews = aggregateNews || { items: [] };
    const correlatorSnapshot = {
      ...snapshot,
      signalCorpus: this.stateManager.getSignalCorpus()
    };

    try {
      await this.signalCorrelator?.recordSnapshot(correlatorSnapshot, resolvedAggregateNews);
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
      mapAssets: snapshot.mapAssets,
      insights: snapshot.insights,
      predictions: snapshot.predictions,
      timeseries: snapshot.timeseries,
      market: snapshot.market,
      impact: snapshot.impact,
      impactHistory: snapshot.impactHistory,
      ai: snapshot.ai,
      awareness: snapshot.awareness
    };
  }

  buildMarketUpdatePayload(snapshot) {
    // The existing update envelope supports partial state (manual refresh and AI
    // already use it). News/countries/map assets are unchanged by market cycles.
    return { meta:snapshot.meta, market:snapshot.market, insights:snapshot.insights,
      predictions:snapshot.predictions, impact:snapshot.impact, impactHistory:snapshot.impactHistory };
  }

  trackBackground(task) {
    if (!task) return;
    this.pendingCycles.add(task);
    task.then(() => this.pendingCycles.delete(task), () => this.pendingCycles.delete(task));
  }

  getNewsBaseIntervalMs() {
    return this.config.news?.intervalMs ?? this.config.refreshIntervalMs ?? null;
  }

  getNewsBackoffMaxMs() {
    return this.config.news?.backoffMaxMs ?? this.getNewsBaseIntervalMs() ?? null;
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
      fallbackPageSize: this.config.news?.pageSize ?? null
    });
  }

  resolveNextNewsDelayMs() {
    if (this.config.news?.collectInWorker) return this.config.news.projectionIntervalMs || 60000;
    const policy = this.resolveCurrentNewsPolicy();
    return policy.intervalMs;
  }

  getMarketQuotaProviders() {
    if (!this.isMarketEnabled()) {
      return [];
    }

    const providers = [this.config.market?.provider, this.config.market?.fallbackProvider]
      .map((provider) => String(provider || "").toLowerCase())
      .filter(Boolean);

    return [...new Set(providers.filter(Boolean))];
  }

  getMarketProviderSnapshots() {
    if (!this.isMarketEnabled()) {
      return [];
    }

    return this.getMarketQuotaProviders()
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
    if (!this.isMarketEnabled()) {
      return null;
    }

    const quotaBand = resolveBandByProviderSnapshots(this.getMarketProviderSnapshots());
    return resolveMarketIntervalMs({
      activeIntervalMs: this.config.market?.activeIntervalMs ?? this.config.market?.refreshIntervalMs ?? null,
      offHoursIntervalMs:
        this.config.market?.offHoursIntervalMs ??
        this.config.market?.activeIntervalMs ??
        this.config.market?.refreshIntervalMs ??
        null,
      quotaRemaining: this.getMarketRemainingQuota(),
      quotaBand,
      bandIntervals: this.config.market?.intervalByBandMs || {}
    });
  }

  resolveMarketCycleDate(value = null) {
    const parsed = value instanceof Date ? value : new Date(value || Date.now());
    return Number.isFinite(parsed.getTime()) ? parsed : new Date();
  }

  shouldSkipAutomatedOffHoursMarketCycle(trigger = "", options = {}) {
    const strategy = normalizeOffHoursStrategy(this.config.market?.offHoursStrategy);
    if (strategy !== "skip" || !isAutomatedMarketTrigger(trigger)) {
      return false;
    }

    const hasAlwaysOpenInstrument = resolveVerifiedInstrumentReferences(this.config.market?.tickers || [])
      .instruments.some((instrument) => instrument.sessionPolicy === "24x7");
    return !hasAlwaysOpenInstrument && !isMarketOpenEt(this.resolveMarketCycleDate(options.now));
  }

  getNewsCycleTelemetry() {
    return structuredClone(this.newsCycleTelemetry);
  }

  getMarketCycleTelemetry() {
    return structuredClone(this.marketCycleTelemetry);
  }

  getMarketHistoryStatus() {
    return this.marketHistoryStore?.getStatus?.() || {
      enabled: false,
      lastLoadedAt: null,
      lastSavedAt: null,
      snapshotPath: null
    };
  }

  scheduleNextNewsCycle(trigger = "interval-news") {
    if (this.stopped) {
      return;
    }

    clearTimeout(this.newsTimerHandle);
    const baseIntervalMs = this.resolveNextNewsDelayMs() ?? this.getNewsBaseIntervalMs() ?? 0;
    const backoffCapMs = this.getNewsBackoffMaxMs() ?? baseIntervalMs;
    const delayMs = this.config.news?.collectInWorker
      ? baseIntervalMs
      : baseIntervalMs + Math.min(this.newsBackoffMs, Math.max(0, backoffCapMs - baseIntervalMs));
    this.nextNewsRunAt=new Date(Date.now()+delayMs).toISOString();
    this.onSchedule?.("news",{nextRunAt:this.nextNewsRunAt,intervalMs:delayMs});
    this.newsTimerHandle = setTimeout(async () => {
      this.nextNewsRunAt=null;
      try { await this.runNewsCycle(trigger, { allowExhaustedProviders: false }); }
      catch (error) { log.error("news_scheduler_failed", { message: error.message }); }
      finally { this.scheduleNextNewsCycle("interval-news"); }
    }, delayMs);
  }

  scheduleNextMarketCycle(trigger = "interval-market") {
    if (this.stopped || !this.isMarketEnabled()) {
      return;
    }

    clearTimeout(this.marketTimerHandle);
    const delayMs = this.resolveNextMarketDelayMs();
    this.nextMarketRunAt=new Date(Date.now()+delayMs).toISOString();
    for(const id of ["market","market.analysis"])this.onSchedule?.(id,{nextRunAt:this.nextMarketRunAt,intervalMs:delayMs});
    this.marketTimerHandle = setTimeout(async () => {
      this.nextMarketRunAt=null;
      try { await this.runMarketCycle(trigger); }
      catch (error) { log.error("market_scheduler_failed", { message: error.message }); }
      finally { this.scheduleNextMarketCycle("interval-market"); }
    }, delayMs);
  }

  runNewsCycle(trigger = "scheduled-news", options = {}) {
    if (this.newsTask) {
      this.cycleMetrics.newsJoined++;
      if (options.rssOnly) { this.rssSelectionPending = true; this.cycleMetrics.rssCoalesced++; }
      return this.newsTask;
    }
    const task = (async () => {
      await this.executeNewsCycle(trigger, options);
      // An RSS notification arriving during a provider fetch must use the newest
      // stored corpus after that fetch completes, without concurrent state writes.
      while (this.rssSelectionPending) {
        this.rssSelectionPending = false;
        await this.executeNewsCycle("rss-selected-coalesced", { rssOnly: true });
      }
    })().finally(() => { this.newsTask = null; });
    this.newsTask = task;
    this.pendingCycles.add(task);
    task.then(() => this.pendingCycles.delete(task), () => this.pendingCycles.delete(task));
    return task;
  }

  async executeNewsCycle(trigger, options) {
    if (this.newsInFlight) {
      log.warn("news_cycle_skipped", { reason: "in-flight", trigger });
      return;
    }

    this.newsInFlight = true;
    const startedAt = Date.now();
    this.newsCycleTelemetry = {
      ...this.newsCycleTelemetry,
      lastStartedAt: new Date(startedAt).toISOString(),
      lastStatus: "running",
      stage:"fetching",
      lastTrigger: trigger,
      lastError: null
    };

    try {
      let previousSnapshot = this.stateManager.getSnapshot();
      const countryFilter = options.countries?.length ? options.countries : this.config.watchlistCountries;
      const policy = this.resolveCurrentNewsPolicy();
      const pageSize = options.forcePageSize || policy.pageSize;
      const awarenessMode = this.awarenessService?.mode || "off";
      const awarenessCollectionEnabled = awarenessMode === "shadow" || awarenessMode === "visible";
      const awarenessVisible = awarenessMode === "visible";
      const queryLane = awarenessCollectionEnabled
        ? buildNewsLaneRotation({ slots: 1, offset: this.newsLaneOffset })[0] || "geopolitical"
        : "legacy";
      const advanceProviderLane = !this.config.news?.collectInWorker || (!options.storageOnly && (options.allowExhaustedProviders === true || Date.now() >= (this.nextPaidCollectAt || 0)));
      if (awarenessCollectionEnabled && advanceProviderLane) this.newsLaneOffset = (this.newsLaneOffset + 1) % 10;
      const financialPackKeys = ["macro", "market", "corporate-watchlist", "regulatory"];
      const financialQueryPackKey = financialPackKeys[this.financialQueryPackOffset % financialPackKeys.length];
      if (queryLane === "financial" && advanceProviderLane) this.financialQueryPackOffset += 1;
      const financialTickerOffset = this.financialTickerOffset;
      const acquisitionOptions = {
        ...this.config.news,
        rssSnapshot: await this.resolveAggregateNewsSnapshot(),
        ...(options.rssOnly ? {providers:["rss"]} : {}),
        pageSize,
        countries: countryFilter,
        awarenessMode,
        queryLane,
        financialQueryPackKey,
        financialTickerOffset,
        allowExhaustedProviders: options.allowExhaustedProviders === true
      };
      const newsResult = this.config.news?.collectInWorker
        ? await this.collectStoredNews(acquisitionOptions, policy, options)
        : await fetchRawNews(acquisitionOptions);
      this.newsCycleTelemetry.stage="archiving";
      this.latestNewsAcquisition={...newsResult.sourceMeta,acquiredAt:newsResult.sourceMeta?.acquiredAt || this.latestNewsAcquisition?.acquiredAt || (newsResult.sourceMeta?.storageOnly ? null : new Date().toISOString())};
      this.stateManager.setAdminIntelRawNews({generatedAt:new Date().toISOString(),items:normalizeAdminArticles(newsResult.rawArticles || [],newsResult.sourceMeta?.provider || "aggregated"),summary:{rawTotal:(newsResult.rawArticles || []).length,selectedTotal:0,queryLengthTotal:sumCountRecord(newsResult.sourceMeta?.queryLengthByProvider),rawCountByProvider:newsResult.sourceMeta?.rawCountByProvider || {},queryLengthByProvider:newsResult.sourceMeta?.queryLengthByProvider || {}}});
      if (queryLane === "financial" && financialQueryPackKey === "corporate-watchlist") {
        const tickerCount = Math.max(1, this.config.news?.marketTickers?.length || 0);
        const coveredCounts = Object.values(newsResult.sourceMeta?.financialTickerCoverageByProvider || {})
          .map((coverage) => Number(coverage?.queriedTickers?.length || 0))
          .filter((count) => count > 0);
        const rotationStep = coveredCounts.length ? Math.min(...coveredCounts) : 1;
        this.financialTickerOffset = (this.financialTickerOffset + rotationStep) % tickerCount;
      }
      previousSnapshot = this.stateManager.getSnapshot();
      const normalizedNews = mergeArticleCorpora(
        normalizeArticles(newsResult.articles, newsResult.sourceMeta?.provider || "aggregated"),
        this.stateManager.getSignalCorpus().filter(a => options.rssOnly ? a.provider !== "rss" : a.provider === "rss")
      );
      const newsBranches = awarenessCollectionEnabled
        ? partitionNewsArticles(normalizedNews)
        : { geopolitical: normalizedNews, financial: [], hybrid: [] };
      const rawIntelNews = normalizeAdminArticles(newsResult.rawArticles || [], newsResult.sourceMeta?.provider || "aggregated");
      const geopoliticalAwareness = this.awarenessService?.getGeopoliticalArticles?.() || [];
      const shadowFinancialCycle = awarenessMode === "shadow" && queryLane === "financial";
      if (!this.config.news?.collectInWorker && !options.rssOnly) await this.newsArchive?.ingest((newsResult.rawArticles?.length ? newsResult.rawArticles : normalizedNews).filter(a => a.provider !== "rss"), { lane: queryLane, awarenessMode });
      if (this.newsArchive?.getProjection && awarenessVisible && geopoliticalAwareness.length) await this.newsArchive.ingest(geopoliticalAwareness,{awarenessMode});
      this.newsCycleTelemetry.stage="selection";
      const storedProjection = this.newsArchive?.getProjection ? await this.newsArchive.getProjection({countries:countryFilter,awarenessMode,tickers:this.config.market.tickers,impactWindowMin:this.config.market.impactWindowMin}) : null;
      const selection = storedProjection ? {signalCorpus:storedProjection.signalCorpus,displaySelection:storedProjection.news,selectionMeta:storedProjection.selectionMeta} : shadowFinancialCycle
        ? {
            signalCorpus: this.stateManager.getSignalCorpus(),
            displaySelection: previousSnapshot.news || [],
            selectionMeta: previousSnapshot.meta?.sourceMeta || {}
          }
        : buildIntelNewsSelection({
            articles: mergeArticleCorpora(
              awarenessVisible ? newsBranches.geopolitical : normalizedNews,
              geopoliticalAwareness
            ),
            previousArticles: previousSnapshot.news || [],
            watchlistCountries: countryFilter,
            analyzeLimit: this.config.news?.analyzeLimit || 80,
            displayLimit: this.config.news?.displayLimit || 100,
            candidateWindowHours: this.config.news?.candidateWindowHours || 36,
            maxPerSource: this.config.news?.maxPerSource || 3,
            maxSimilarHeadline: this.config.news?.maxSimilarHeadline || 2
          });
      const signalCorpus = selection.signalCorpus || (awarenessVisible ? newsBranches.geopolitical : normalizedNews);
      const selectedNews = selection.displaySelection || [];
      const financialSelection = storedProjection?.financialSelection || buildFinancialNewsSelection({
        articles: awarenessCollectionEnabled
          ? mergeArticleCorpora(newsBranches.financial, awarenessVisible ? this.stateManager.getMarketSignalCorpus() : [])
          : [],
        candidateWindowHours: Math.max(36, this.config.news?.candidateWindowHours || 36),
        analyzeLimit: this.config.news?.analyzeLimit || 80,
        displayLimit: 40,
        maxPerSource: 4
      });
      if (awarenessCollectionEnabled) {
        await this.awarenessService?.ingestFinancialArticles?.(financialSelection.items || [], {
          backfill: trigger === "startup-news",
          trigger
        });
      }
      const marketSignalCorpus = storedProjection?.marketSignalCorpus || (awarenessVisible
        ? mergeArticleCorpora(
            signalCorpus,
            financialSelection.signalCorpus || [],
            this.awarenessService?.getMarketArticles?.() || []
          )
        : signalCorpus);
      const newsSourceMeta = {
        ...(newsResult.sourceMeta || {}),
        rssIngestion: this.rssAggregator ? (({feedStatus, ...summary}) => summary)(this.rssAggregator.getStatus?.() || {}) : null,
        selectedCountByProvider: countByProvider(selectedNews, this.config.news?.providers || []),
        signalCountByProvider: countByProvider(signalCorpus, this.config.news?.providers || []),
        selectionBySourceName: selection.selectionMeta?.selectionBySourceName || [],
        latestSelectedArticleAgeMin: selection.selectionMeta?.latestSelectedArticleAgeMin ?? null,
        selectionConfig: selection.selectionMeta?.selectionConfig || null,
        queryLane,
        awarenessMode,
        financialQueryPackKey: queryLane === "financial" ? financialQueryPackKey : null,
        financialTickerOffset: queryLane === "financial" && financialQueryPackKey === "corporate-watchlist" ? financialTickerOffset : null,
        branchCounts: {
          geopolitical: newsBranches.geopolitical.length,
          financial: newsBranches.financial.length,
          hybrid: newsBranches.hybrid.length
        },
        financialSelection: financialSelection.diagnostics
      };
      if(storedProjection) { newsSourceMeta.corpus=storedProjection.meta; newsSourceMeta.provider="sqlite"; newsSourceMeta.reason=storedProjection.sourceMode==="stale" ? "provider-data-stale" : storedProjection.sourceMode==="unavailable" ? "no-valid-stored-news" : null; newsSourceMeta.branchCounts={geopolitical:storedProjection.meta.geopoliticalCandidateCount,financial:storedProjection.meta.financialCandidateCount,hybrid:null}; }
      this.latestNewsAcquisition={...newsSourceMeta,acquiredAt:this.latestNewsAcquisition?.acquiredAt};
      this.stateManager.setAdminIntelRawNews({
        generatedAt: new Date().toISOString(),
        items: rawIntelNews,
        summary: {
          rawTotal: sumCountRecord(newsSourceMeta.rawCountByProvider),
          selectedTotal: selectedNews.length,
          queryLengthTotal: sumCountRecord(newsSourceMeta.queryLengthByProvider),
          rawCountByProvider: newsSourceMeta.rawCountByProvider || {},
          selectedCountByProvider: newsSourceMeta.selectedCountByProvider || {},
          queryLengthByProvider: newsSourceMeta.queryLengthByProvider || {}
        }
      });

      const riskResult = storedProjection?.riskResult || computeCountryRisk({
        articles: signalCorpus,
        previousCountries: previousSnapshot.countries
      });

      const inputMode = resolveInputMode(newsResult.sourceMode, previousSnapshot.market?.sourceMode);
      const selectedMarketInstruments = this.config.market.watchlistService?.selectedInstruments?.() || [];
      const impact = storedProjection?.impact || computeMarketImpact({
        articles: marketSignalCorpus,
        countries: riskResult.countries,
        marketQuotes: previousSnapshot.market?.quotes || {},
        tickers: this.config.market.tickers,
        instruments: selectedMarketInstruments,
        countryFilter,
        windowMin: this.config.market.impactWindowMin,
        inputMode,
        impactHistory: previousSnapshot.impactHistory || [],
        predictionScores: previousSnapshot.predictions?.predictionScoreByTicker || {}
      });
      const predictions = storedProjection?.predictions || generatePredictions({
        articles: marketSignalCorpus,
        countries: riskResult.countries,
        marketQuotes: previousSnapshot.market?.quotes || {},
        tickers: this.config.market.tickers,
        instruments: selectedMarketInstruments,
        inputMode
      });
      const insights = storedProjection?.insights || generateInsights({
        countries: riskResult.countries,
        previousCountries: previousSnapshot.countries,
        inputMode
      });

      let snapshot = this.stateManager.updateIntel({
        news: selectedNews,
        countries: riskResult.countries,
        hotspots: riskResult.hotspots,
        insights,
        predictions,
        impact,
        signalCorpus,
        marketSignalCorpus,
        newsSourceMode: storedProjection?.sourceMode || newsResult.sourceMode,
        newsSourceMeta,
        watchlistCountries: this.config.watchlistCountries
      });

      this.socketServer.broadcast("update", this.buildUpdatePayload(snapshot), snapshot.meta);
      if(options.skipSecondary) { this.newsCycleTelemetry={...this.newsCycleTelemetry,lastCompletedAt:new Date().toISOString(),lastDurationMs:Date.now()-startedAt,lastStatus:"ok",stage:"completed"}; return snapshot; }

      this.newsCycleTelemetry.stage="rss-aggregate";
      const aggregateNews = await this.resolveAggregateNewsSnapshot();
      this.newsCycleTelemetry.stage="context";
      await this.newsArchive?.recordContext(snapshot);
      this.newsCycleTelemetry.stage="scenarios";
      await this.researchCycle?.(snapshot);
      await this.storageFlush?.();
      this.newsCycleTelemetry.stage="signals";
      await this.refreshSecondaryIntel(snapshot, aggregateNews);
      void Promise.resolve(this.aiCoordinator?.reconcileNewsSnapshot?.({
        snapshot,
        signalCorpus,
        displaySelection: selectedNews,
        rawArticles: newsResult.articles || [],
        instruments: selectedMarketInstruments
      })).catch((error) => log.warn("ai_news_reconcile_failed", { message: error.message }));
      this.newsBackoffMs = 0;

      log.info("news_cycle_completed", {
        trigger,
        sourceMode: snapshot.meta.sourceMode,
        qualityReasons:snapshot.meta.sourceMeta?.corpus?.staleReasons||[],
        lastSuccessfulCheckAt:snapshot.meta.sourceMeta?.corpus?.lastSuccessfulCheckAt||null,
        providerUsed: newsResult.sourceMeta?.provider || "unknown",
        attempts: newsResult.sourceMeta?.attempts || [],
        quotaBand: policy.band,
        pageSize,
        candidateCount: signalCorpus.length,
        articleCount: snapshot.news.length,
        durationMs: Date.now() - startedAt
      });
      this.newsCycleTelemetry = {
        ...this.newsCycleTelemetry,
        lastCompletedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastStatus: "ok",
        stage:"completed",
        lastError: null
      };
    } catch (error) {
      const baseIntervalMs = this.resolveNextNewsDelayMs() ?? this.getNewsBaseIntervalMs() ?? 0;
      const backoffCapMs = this.getNewsBackoffMaxMs() ?? baseIntervalMs;
      const maxExtraBackoff = Math.max(0, backoffCapMs - baseIntervalMs);
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
      this.newsCycleTelemetry = {
        ...this.newsCycleTelemetry,
        lastCompletedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastStatus: "error",
        failedStage:this.newsCycleTelemetry.stage,
        lastError: error.message
      };
    } finally {
      this.newsInFlight = false;
    }
  }

  async runCycle(trigger = "scheduled-news") {
    await this.rssAggregator?.refresh();
    return this.runNewsCycle(trigger);
  }

  async collectStoredNews(input, policy, options = {}) {
    const now=Date.now(), force=options.allowExhaustedProviders === true;
    const providers=(this.config.news.providers || []).filter(provider => !options.storageOnly && (provider === "rss" ? force || now >= (this.nextRssCollectAt || 0) : force || now >= (this.nextPaidCollectAt || 0)));
    if(!providers.length) return {articles:[],rawArticles:[],sourceMode:"stored",sourceMeta:{...(this.latestNewsAcquisition || {}),storageOnly:true}};
    if(providers.includes("rss")) this.nextRssCollectAt=now+(this.config.news.rssPollIntervalMs || 60000);
    if(providers.some(provider => provider!=="rss")) this.nextPaidCollectAt=now+(policy.intervalMs || this.getNewsBaseIntervalMs() || 600000);
    const result=await this.config.news.collectInWorker({providers,pageSize:input.pageSize,countries:input.countries,queryLane:input.queryLane,awarenessMode:input.awarenessMode,financialQueryPackKey:input.financialQueryPackKey,financialTickerOffset:input.financialTickerOffset,marketTickers:input.marketTickers,queryPacks:input.queryPacks,queryPackGroups:input.queryPackGroups,allowExhaustedProviders:input.allowExhaustedProviders});
    this.providerAttempts ||= new Map();
    for(const attempt of result.sourceMeta?.attempts || []) this.providerAttempts.set(attempt.provider,{...attempt,lastAttemptAt:result.sourceMeta.acquiredAt || new Date().toISOString()});
    result.sourceMeta={...result.sourceMeta,attempts:[...this.providerAttempts.values()]};
    for(const [provider,quota] of Object.entries(result.quotas || {})) { apiQuotaTracker.ensureProvider(provider); Object.assign(apiQuotaTracker.providers[provider],quota); }
    return result;
  }

  runMarketCycle(trigger = "scheduled-market", options = {}) {
    if (this.marketTask) { this.cycleMetrics.marketJoined++; return this.marketTask; }
    const task = this.executeMarketCycle(trigger, options).finally(() => { this.marketTask = null; });
    this.marketTask = task;
    this.pendingCycles.add(task);
    task.then(() => this.pendingCycles.delete(task), () => this.pendingCycles.delete(task));
    return task;
  }

  async executeMarketCycle(trigger, options) {
    if (!this.isMarketEnabled()) {
      log.info("market_cycle_skipped", {
        trigger,
        reason: this.config.market?.disabledReason || "market-provider-empty"
      });
      this.markMarketTelemetryDisabled();
      return;
    }

    if (this.marketInFlight) {
      log.warn("market_cycle_skipped", { reason: "in-flight", trigger });
      return;
    }

    this.marketInFlight = true;
    const startedAt = Date.now();
    this.marketCycleTelemetry = {
      ...this.marketCycleTelemetry,
      lastStartedAt: new Date(startedAt).toISOString(),
      lastStatus: "running",
      lastTrigger: trigger,
      lastError: null
    };

    try {
      if (this.shouldSkipAutomatedOffHoursMarketCycle(trigger, options)) {
        try { await this.dailyCandleService?.runScheduled?.(); } catch (error) { log.warn("daily_candle_cycle_failed", { message: error.message }); }
        this.trackBackground(this.intradayCandleService?.runScheduled?.().catch((error) => log.warn("intraday_candle_cycle_failed", { message: error.message })));
        const previousSnapshot = this.stateManager.getSnapshot();
        const cycleDate = this.resolveMarketCycleDate(options.now);
        const pausedMarketState = refreshMarketSessionMetadata(previousSnapshot.market, {
          timestamp: cycleDate.toISOString(),
          pauseReason: "offhours-skip",
          upstreamPaused: true
        });
        const snapshot = this.stateManager.hydrateMarketState(pausedMarketState);
        this.socketServer.broadcast("update", this.buildMarketUpdatePayload(snapshot), snapshot.meta);

        log.info("market_cycle_skipped", {
          trigger,
          reason: "offhours-skip",
          strategy: normalizeOffHoursStrategy(this.config.market?.offHoursStrategy)
        });
        this.marketCycleTelemetry = {
          ...this.marketCycleTelemetry,
          lastCompletedAt: new Date().toISOString(),
          lastDurationMs: Date.now() - startedAt,
          lastStatus: "skipped",
          lastError: "offhours-skip"
        };
        return;
      }

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
        this.marketCycleTelemetry = {
          ...this.marketCycleTelemetry,
          lastCompletedAt: new Date().toISOString(),
          lastDurationMs: Date.now() - startedAt,
          lastStatus: "skipped",
          lastError: "min-ticker-ttl"
        };
        return;
      }

      const cycleDate = this.resolveMarketCycleDate(options.now);
      const marketResult = await fetchMarketQuotes({
        ...this.config.market,
        trigger,
        previousQuotes: previousSnapshot.market?.quotes || {},
        previousTimeseries: previousSnapshot.market?.timeseries || {},
        allowExhaustedProviders: options.allowExhaustedProviders === true,
        timestamp: cycleDate.toISOString()
      });
      const marketState = mergeMarketState(previousSnapshot.market, marketResult);
      const analysisSnapshot = this.stateManager.getSnapshot();
      const inputMode = resolveInputMode(previousSnapshot.meta?.sourceMode, marketState.sourceMode);
      const countryFilter = options.countries?.length ? options.countries : this.config.watchlistCountries;
      const selectedMarketInstruments = this.config.market.watchlistService?.selectedInstruments?.() || [];

      const analysisInput={
        ...(this.config.market.newsFromStorage ? {
          newsFromStorage:true,
          corpusOptions:{countries:this.config.watchlistCountries,windowHours:this.config.news.candidateWindowHours,awarenessMode:this.awarenessService?.mode || this.config.awareness?.mode || "off"}
        } : {articles:mergeArticleCorpora(this.stateManager.getMarketSignalCorpus(),this.awarenessService?.getMarketArticles?.() || [])}),
        countries:analysisSnapshot.countries,marketQuotes:marketState.quotes,tickers:this.config.market.tickers,instruments:selectedMarketInstruments,
        countryFilter,windowMin:this.config.market.impactWindowMin,inputMode,
        // The coupling calculation consumes only the last 24 points and these fields.
        impactHistory:(previousSnapshot.impactHistory || []).slice(-24).map(entry=>({timestamp:entry.timestamp,items:(entry.items || []).map(item=>({ticker:item.ticker,impactScore:item.impactScore,eventScore:item.eventScore,priceReaction:item.priceReaction}))}))
      };
      let snapshot;
      if(this.config.market.analyzeInWorker){
        snapshot=this.stateManager.updateIntel({market:marketState,watchlistCountries:this.config.watchlistCountries});
        this.socketServer.broadcast("update",{market:snapshot.market,meta:snapshot.meta},snapshot.meta);
        this.scheduleMarketProjection({...analysisInput,marketRevision:snapshot.market.revision,newsRevision:analysisSnapshot.meta?.sourceMeta?.corpus?.revision});
      } else {
        const projection=calculateMarketProjection(analysisInput);
        snapshot=this.stateManager.updateIntel({...projection,market:marketState,watchlistCountries:this.config.watchlistCountries});
      }

      const aggregateNews = await this.resolveAggregateNewsSnapshot();
      await this.newsArchive?.recordContext(snapshot);
      await this.researchCycle?.(snapshot);
      await this.storageFlush?.();
      await this.refreshSecondaryIntel(snapshot, aggregateNews);
      try {
        await this.marketHistoryStore?.persistMarketState?.(previousSnapshot.market || {}, marketState, {
          trigger
        });
      } catch (error) {
        log.warn("market_history_persist_failed", {
          message: error.message
        });
      }
      if (isAutomatedMarketTrigger(trigger)) {
        try { await this.dailyCandleService?.runScheduled?.(); } catch (error) { log.warn("daily_candle_cycle_failed", { message: error.message }); }
        this.trackBackground(this.intradayCandleService?.runScheduled?.().catch((error) => log.warn("intraday_candle_cycle_failed", { message: error.message })));
      }
      this.socketServer.broadcast("update", this.buildMarketUpdatePayload(snapshot), snapshot.meta);
      void Promise.resolve(this.aiCoordinator?.reconcileMarketSnapshot?.({
        snapshot,
        instruments: selectedMarketInstruments
      })).catch((error) => log.warn("ai_market_reconcile_failed", { message: error.message }));
      const coverage = marketState.sourceMeta?.coverageByMode || {};
      const fallbackCount = Number(coverage.routerStale || 0) + Number(coverage.syntheticFallback || 0);

      log.info("market_cycle_completed", {
        trigger,
        sourceMode: marketState.sourceMode,
        providerUsed: marketResult.sourceMeta?.effectiveProvider || marketResult.sourceMeta?.provider || marketState.provider || "unknown",
        liveCount: marketResult.sourceMeta?.liveCount ?? 0,
        webDelayedCount: Number(coverage.webDelayed || 0),
        fallbackCount,
        tickerCount: Object.keys(marketState.quotes || {}).length,
        durationMs: Date.now() - startedAt
      });
      this.marketCycleTelemetry = {
        ...this.marketCycleTelemetry,
        lastCompletedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastStatus: "ok",
        lastError: null
      };
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
      this.marketCycleTelemetry = {
        ...this.marketCycleTelemetry,
        lastCompletedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastStatus: "error",
        lastError: error.message
      };
    } finally {
      this.marketInFlight = false;
    }
  }

  scheduleMarketProjection(input){
    this.marketProjectionPending=input;
    if(this.marketProjectionTask)return this.marketProjectionTask;
    const task=(async()=>{
      while(this.marketProjectionPending){
        const captured=this.marketProjectionPending;this.marketProjectionPending=null;
        try{
          const projection=await this.config.market.analyzeInWorker(captured);
          if(this.stateManager.state.market.revision!==captured.marketRevision)continue;
          // SQL reads the corpus at execution time; its returned revision is authoritative.
          const analyzedNewsRevision=projection.newsCoverage?.revision ?? captured.newsRevision;
          const currentNewsRevision=this.stateManager.state.meta?.sourceMeta?.corpus?.revision;
          if(currentNewsRevision!==undefined && analyzedNewsRevision!==undefined && currentNewsRevision!==analyzedNewsRevision)continue;
          const snapshot=this.stateManager.updateIntel({...projection,watchlistCountries:this.config.watchlistCountries});
          this.socketServer.broadcast("update",{meta:snapshot.meta,insights:snapshot.insights,predictions:snapshot.predictions,impact:snapshot.impact,impactHistory:snapshot.impactHistory},snapshot.meta);
        }catch(error){log.warn("market_projection_failed",{code:error.code || "MARKET_ANALYSIS_FAILED",command:error.diagnostic});}
      }
    })().finally(()=>{this.marketProjectionTask=null;});
    this.marketProjectionTask=task;this.trackBackground(task);return task;
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
      await this.rssAggregator?.refresh({force:true});
      await this.runNewsCycle(`${trigger}-news`, {
        allowExhaustedProviders: true,
        countries: activeCountries
      });
      if (this.isMarketEnabled()) {
        await this.runMarketCycle(`${trigger}-market`, {
          countries: activeCountries,
          allowExhaustedProviders: true
        });
      }
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
    if (!this.stopped) return;
    this.stopped = false;
    if (this.rssAggregator) {
      this.rssAggregator.onSnapshot = () => this.runNewsCycle("rss-selected", {rssOnly:true});
      // The SQL adapter collects RSS through the scheduled news cycle.
      this.rssAggregator.start?.();
    }

    if (!this.newsTimerHandle) {
      this.runNewsCycle("startup-news", { allowExhaustedProviders: false })
        .catch((error) => {
          log.error("news_cycle_startup_failed", { message: error.message });
        })
        .finally(() => {
          this.scheduleNextNewsCycle("interval-news");
        });
    }

    if (!this.marketTimerHandle && this.isMarketEnabled()) {
      this.runMarketCycle("startup-market")
        .catch((error) => {
          log.error("market_cycle_startup_failed", { message: error.message });
        })
        .finally(() => {
          this.scheduleNextMarketCycle("interval-market");
        });
    } else if (!this.isMarketEnabled()) {
      this.markMarketTelemetryDisabled();
    }
  }

  async stop() {
    this.stopped = true;
    this.nextNewsRunAt=null;
    if (this.newsTimerHandle) {
      clearTimeout(this.newsTimerHandle);
      this.newsTimerHandle = null;
    }

    if (this.marketTimerHandle) {
      clearTimeout(this.marketTimerHandle);
      this.marketTimerHandle = null;
    }
    await Promise.allSettled([...this.pendingCycles]);
  }
}

export default RefreshOrchestratorService;
