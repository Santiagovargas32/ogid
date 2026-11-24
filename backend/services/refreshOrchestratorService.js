import { CycleContinuation, isResourcePressure } from './shared/cycleContinuation.js';
import {buildDataQuality} from '../state/stateManager.js';
import {projectNewsContext} from './research/newsArchive.js';
import {randomUUID} from 'node:crypto';
import {stableHash} from '../utils/stableHash.js';
import {projectNewsMeta} from './news/newsFreshness.js';
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
    admission = null,
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
    this.admission=admission;
    this.resourceDeferred=new Set();
    this.continuations=new Map();
    this.resumeResources=()=>{
      if(this.stopped||this.admission?.status().state!=='normal')return;
      for(const domain of [...this.resourceDeferred]){
        if(domain==='projection'){
          if(!this.marketProjectionTask&&this.marketProjectionPending){this.resourceDeferred.delete(domain);void this.scheduleMarketProjection(this.marketProjectionPending);}
        }else if(!this[`${domain}Task`]){
          this.resourceDeferred.delete(domain);
          void (domain==='news'?this.runNewsCycle('resource-recovered'):this.runMarketCycle('resource-recovered')).catch(()=>{});
        }
      }
    };
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
    this.stopping = false;
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
      if(/^(STORAGE_|SQLITE_)/.test(error.code || ''))throw error;
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

    await this.signalCorrelator?.recordSnapshot(correlatorSnapshot, resolvedAggregateNews);
  }

  buildUpdatePayload(snapshot) {
    return {
      meta: projectNewsMeta(snapshot.meta),
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
      catch (error) { log[isResourcePressure(error)?'info':'error']("news_scheduler_failed", {code:error.code,message:error.message}); }
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
      catch (error) { log[isResourcePressure(error)?'info':'error']("market_scheduler_failed", {code:error.code,message:error.message}); }
      finally { this.scheduleNextMarketCycle("interval-market"); }
    }, delayMs);
  }

  runNewsCycle(trigger = "scheduled-news", options = {}) {
    if(this.stopping)return Promise.resolve({skipped:true,reason:'stopping'});
    if(options.rssOnly&&Date.now()<(this.newsRetryAt || 0)){this.rssSelectionPending=true;return Promise.resolve({skipped:true,reason:'backoff'});}
    if (this.newsTask) {
      this.cycleMetrics.newsJoined++;
      if (options.rssOnly) { this.rssSelectionPending = true; this.cycleMetrics.rssCoalesced++; }
      return this.newsTask;
    }
    const task = (async () => {
      await this.executeNewsCycle(trigger, options);
      // An RSS notification arriving during a provider fetch must use the newest
      // stored corpus after that fetch completes, without concurrent state writes.
      while (this.rssSelectionPending && !this.stopping && !this.newsBackoffMs) {
        this.rssSelectionPending = false;
        await this.executeNewsCycle("rss-selected-coalesced", { rssOnly: true });
      }
    })().catch(error=>{if(isResourcePressure(error))this.resourceDeferred.add('news');throw error;}).finally(() => { this.newsTask = null; queueMicrotask(this.resumeResources); });
    this.newsTask = task;
    this.pendingCycles.add(task);
    task.then(() => this.pendingCycles.delete(task), () => this.pendingCycles.delete(task));
    return task;
  }

  async executeContinuation(domain,trigger,options){
    let continuation=this.continuations.get(domain);
    if(!continuation){
      continuation=new CycleContinuation(this[`${domain}Steps`](trigger,options),this.admission);
      this.continuations.set(domain,continuation);
    }
    this[`${domain}InFlight`]=true;
    try{
      const value=await continuation.run();
      this.continuations.delete(domain);this.resourceDeferred.delete(domain);
      this[`${domain}CycleTelemetry`]={...this[`${domain}CycleTelemetry`],lastErrorCode:null,resourcePending:false,resourceReason:null,lastSuccessAt:new Date().toISOString()};
      return value;
    }catch(error){
      const deferred=isResourcePressure(error);
      if(deferred)this.resourceDeferred.add(domain);else this.continuations.delete(domain);
      this[`${domain}CycleTelemetry`]={...this[`${domain}CycleTelemetry`],lastStatus:deferred?'deferred':'error',lastError:error.message,lastErrorCode:error.code || 'CYCLE_FAILED',failedStage:continuation.phase,resourcePending:deferred,resourceReason:deferred?error.details?.reason:null};
      log[deferred?'info':'error'](`${domain}_cycle_${deferred?'deferred':'failed'}`,{code:error.code || 'CYCLE_FAILED',phase:continuation.phase,reason:error.details?.reason,trigger,message:error.message});
      this.socketServer?.broadcast('error',{message:deferred?'Work deferred until resources recover':'Cycle failed',details:error.message,code:error.code || 'CYCLE_FAILED',recoverable:deferred},{domain,phase:continuation.phase});
      throw error;
    }finally{this[`${domain}InFlight`]=false;}
  }

  executeNewsCycle(trigger,options={}){return this.executeContinuation('news',trigger,options);}
  executeMarketCycle(trigger,options={}){return this.executeContinuation('market',trigger,options);}

  *newsSteps(trigger, options) {
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
      if (this.awarenessService?.store?.financialContinuations) {
        yield {phase:'financial-recovery', work:() => this.awarenessService.recoverFinancial()};
      }
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
        rssSnapshot: (yield {phase:'feed',work:()=>this.resolveAggregateNewsSnapshot()}),
        ...(options.rssOnly ? {providers:["rss"]} : {}),
        pageSize,
        countries: countryFilter,
        awarenessMode,
        queryLane,
        financialQueryPackKey,
        financialTickerOffset,
        allowExhaustedProviders: options.allowExhaustedProviders === true
      };
      const newsResult = yield {phase:'acquisition',work:()=>this.config.news?.collectInWorker
        ? this.collectStoredNews(acquisitionOptions, policy, options) : fetchRawNews(acquisitionOptions)};
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
      const ingestProgress={},awarenessProgress={};
      const ingestArticles=(newsResult.rawArticles?.length ? newsResult.rawArticles : normalizedNews).filter(a=>a.provider!=='rss');
      if (!this.config.news?.collectInWorker && !options.rssOnly) (yield {phase:'ingestion',work:()=>this.newsArchive?.ingest(ingestArticles, {lane:queryLane,awarenessMode},ingestProgress)});
      if (this.newsArchive?.getProjection && awarenessVisible && geopoliticalAwareness.length) (yield {phase:'awareness-ingestion',work:()=>this.newsArchive.ingest(geopoliticalAwareness,{awarenessMode},awarenessProgress)});
      this.newsCycleTelemetry.stage="selection";
      const storedProjection = this.newsArchive?.getProjection ? (yield {phase:'selection',work:()=>this.newsArchive.getProjection({countries:countryFilter,awarenessMode,tickers:this.config.market.tickers,impactWindowMin:this.config.market.impactWindowMin})}) : null;
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
      const selectionTime = storedProjection?.meta?.asOf || new Date().toISOString();
      const financialSelection = storedProjection?.financialSelection || buildFinancialNewsSelection({
        articles: awarenessCollectionEnabled
          ? mergeArticleCorpora(newsBranches.financial, awarenessVisible ? this.stateManager.getMarketSignalCorpus() : [])
          : [],
        now: new Date(selectionTime),
        candidateWindowHours: Math.max(36, this.config.news?.candidateWindowHours || 36),
        analyzeLimit: this.config.news?.analyzeLimit || 80,
        displayLimit: 40,
        maxPerSource: 4
      });
      if (awarenessCollectionEnabled && this.awarenessService?.store?.financialContinuations) {
        const items = financialSelection.items || [];
        if (items.length) {
          const intent = this.awarenessService.prepareFinancialIntent(items, {
            backfill:trigger === 'startup-news', trigger, asOf:selectionTime, corpusRevision:storedProjection?.meta?.revision
          });
          yield {phase:'financial-admission', kind:'commit', work:() => this.awarenessService.store.financialContinuations.admit(intent)};
          yield {phase:'financial-ingestion', work:() => this.awarenessService.resumeFinancial(intent.jobId)};
        }
      } else if (awarenessCollectionEnabled) {
        (yield {phase:'financial-ingestion',work:()=>this.awarenessService?.ingestFinancialArticles?.(financialSelection.items || [], {
          backfill: trigger === "startup-news",trigger
        })});
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
      const aggregateNews = (yield {phase:'feed',work:()=>this.resolveAggregateNewsSnapshot()});
      this.newsCycleTelemetry.stage="context";
      (yield {phase:'context',work:()=>this.newsArchive?.recordContext(snapshot)});
      this.newsCycleTelemetry.stage="scenarios";
      (yield {phase:'research',work:()=>this.researchCycle?.(snapshot)});
      (yield {phase:'flush',kind:'commit',work:()=>this.storageFlush?.()});
      this.newsCycleTelemetry.stage="signals";
      (yield {phase:'signals',work:()=>this.refreshSecondaryIntel(snapshot, aggregateNews)});
      void Promise.resolve(this.aiCoordinator?.reconcileNewsSnapshot?.({
        snapshot,
        signalCorpus,
        displaySelection: selectedNews,
        rawArticles: newsResult.articles || [],
        instruments: selectedMarketInstruments
      })).catch((error) => log.warn("ai_news_reconcile_failed", { message: error.message }));
      this.newsBackoffMs = 0;this.newsRetryAt=0;

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
      this.newsRetryAt=Date.now()+Math.max(baseIntervalMs,this.newsBackoffMs);

      this.newsCycleTelemetry = {
        ...this.newsCycleTelemetry,
        lastCompletedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastStatus: "error",
        failedStage:this.newsCycleTelemetry.stage,
        lastError: error.message
      };
      throw error;
    } finally {
      this.newsInFlight = false;
    }
  }

  async runCycle(trigger = "scheduled-news") {
    this.admission?.assert('acquisition');
    await this.rssAggregator?.refresh();
    return this.runNewsCycle(trigger);
  }

  async collectStoredNews(input, policy, options = {}) {
    const now=Date.now(), force=options.allowExhaustedProviders === true;
    const providers=(this.config.news.providers || []).filter(provider => !options.storageOnly && (provider === "rss" ? force || now >= (this.nextRssCollectAt || 0) : force || now >= (this.nextPaidCollectAt || 0)));
    if(!providers.length) return {articles:[],rawArticles:[],sourceMode:"stored",sourceMeta:{...(this.latestNewsAcquisition || {}),storageOnly:true}};
    const result=await this.config.news.collectInWorker({providers,pageSize:input.pageSize,countries:input.countries,queryLane:input.queryLane,awarenessMode:input.awarenessMode,financialQueryPackKey:input.financialQueryPackKey,financialTickerOffset:input.financialTickerOffset,marketTickers:input.marketTickers,queryPacks:input.queryPacks,queryPackGroups:input.queryPackGroups,allowExhaustedProviders:input.allowExhaustedProviders});
    if(providers.includes("rss")) this.nextRssCollectAt=now+(this.config.news.rssPollIntervalMs || 60000);
    if(providers.some(provider => provider!=="rss")) this.nextPaidCollectAt=now+(policy.intervalMs || this.getNewsBaseIntervalMs() || 600000);
    this.providerAttempts ||= new Map();
    for(const attempt of result.sourceMeta?.attempts || []) this.providerAttempts.set(attempt.provider,{...attempt,lastAttemptAt:result.sourceMeta.acquiredAt || new Date().toISOString()});
    result.sourceMeta={...result.sourceMeta,attempts:[...this.providerAttempts.values()]};
    for(const [provider,quota] of Object.entries(result.quotas || {})) { apiQuotaTracker.ensureProvider(provider); Object.assign(apiQuotaTracker.providers[provider],quota); }
    return result;
  }

  runMarketCycle(trigger = "scheduled-market", options = {}) {
    if(this.stopping)return Promise.resolve({skipped:true,reason:'stopping'});
    if (this.marketTask) {
      this.cycleMetrics.marketJoined++;
      if(trigger==='watchlist-update')this.marketWatchlistPending=true;
      return this.marketTask;
    }
    const task = (async()=>{
      let result=await this.executeSelectedMarketTurn(trigger,options);
      while(this.marketWatchlistPending && !this.stopping){
        this.marketWatchlistPending=false;
        result=await this.executeSelectedMarketTurn('watchlist-update',{});
      }
      return result;
    })().catch(error=>{if(isResourcePressure(error))this.resourceDeferred.add('market');throw error;}).finally(() => { this.marketTask = null; queueMicrotask(this.resumeResources); });
    this.marketTask = task;
    this.pendingCycles.add(task);
    task.then(() => this.pendingCycles.delete(task), () => this.pendingCycles.delete(task));
    return task;
  }

  async executeSelectedMarketTurn(trigger,options){
    if(this.marketPresentationError || this.recoveringMarketPresentation){
      await this.recoverMarketPresentation();
      if(this.marketPresentationError)throw this.marketPresentationError;
      if(this.marketProjectionPending)this.admission?.assert('heavy');
    }
    const turns=this.marketHistoryStore?.quoteTurns;
    if(!turns || this.continuations.has('market') || !this.config.market?.newsFromStorage || !this.config.market.analyzeInWorker){
      return this.executeMarketCycle(trigger,options);
    }
    const selected=await this.prepareMarketTurn(turns,trigger,options);
    if(selected?.skipped)return selected;
    if(!selected)return this.executeMarketCycle(trigger,options);
    const {selection}=selected.input;
    return this.executeMarketCycle(selection.trigger,{countries:selection.countries,allowExhaustedProviders:selection.allowExhaustedProviders,
      now:selection.referenceAt,quoteTurn:selected});
  }

  marketSelection(trigger,options){
    const config=this.config.market,tickers=[...config.tickers];
    const resolved=resolveVerifiedInstrumentReferences(tickers).instruments;
    const instruments=config.watchlistService?.applySelection?.(resolved) || resolved;
    const route={provider:config.provider,fallbackProvider:config.fallbackProvider,offHoursStrategy:config.offHoursStrategy,
      minTickerTtlMs:config.minTickerTtlMs,requestReserve:config.requestReserve,staleTtlMs:config.staleTtlMs,
      creditPolicy:config.creditPolicy,providerChain:config.providerChain,
      instruments:instruments.map(({instrumentId,canonicalSymbol,providerSymbols,sessionPolicy,refreshTier,minRefreshIntervalMs})=>
        ({instrumentId,canonicalSymbol,providerSymbols,sessionPolicy,refreshTier,minRefreshIntervalMs}))};
    return {trigger,selectedAt:new Date(this.marketHistoryStore.quoteTurns.now()).toISOString(),referenceAt:options.now?this.resolveMarketCycleDate(options.now).toISOString():null,
      baseRevision:this.stateManager.state.market.revision ?? null,policyHash:stableHash(route),tickers,
      provider:config.provider || null,fallbackProvider:config.fallbackProvider || null,
      instrumentIds:instruments.map(i=>i.instrumentId),countries:[...(options.countries?.length?options.countries:this.config.watchlistCountries || [])],
      allowExhaustedProviders:options.allowExhaustedProviders===true};
  }

  async prepareMarketTurn(turns,trigger,options){
    if(!this.isMarketEnabled()){
      const pending=await turns.pending();
      if(pending?.phase==='admission')await turns.skip(pending,'market-disabled');
      return null;
    }
    const selection=this.marketSelection(trigger,options);
    let job=await turns.reserve(selection);
    if(job.status==='complete')return {skipped:true,reason:job.phase,jobId:job.jobId};
    if(job.phase==='request-authorized'){
      const eligible=job.input.nextEligibleAt?turns.now()>=Date.parse(job.input.nextEligibleAt):trigger.startsWith('manual');
      if(!eligible){
        const reason='prior-request-unconfirmed';
        this.marketCycleTelemetry={...this.marketCycleTelemetry,lastStatus:'deferred',lastError:reason,
          failedStage:'quotes',nextEligibleAt:job.input.nextEligibleAt,jobId:job.jobId};
        return {skipped:true,reason,nextEligibleAt:job.input.nextEligibleAt,jobId:job.jobId};
      }
      // At cadence the previous dispatch remains unknown. A new live fetch
      // has a distinct identity and current catalog, clock and provider policy.
      await turns.skip(job,'request-outcome-unknown');
      job=await turns.reserve(selection);
    }
    if(job.input.selection.policyHash!==selection.policyHash || job.input.selection.baseRevision!==selection.baseRevision){
      await turns.skip(job,'selection-superseded');
      return {skipped:true,reason:'selection-superseded',jobId:job.jobId};
    }
    return job;
  }

  *marketSteps(trigger, options) {
    if (!this.isMarketEnabled()) {
      log.info("market_cycle_skipped", {
        trigger,
        reason: this.config.market?.disabledReason || "market-provider-empty"
      });
      this.markMarketTelemetryDisabled();
      return;
    }

    const startedAt = Date.now();
    this.marketCycleTelemetry = {
      ...this.marketCycleTelemetry,
      lastStartedAt: new Date(startedAt).toISOString(),
      lastStatus: "running",
      lastTrigger: trigger,
      lastError: null
    };

    try {
      const turns=this.marketHistoryStore?.quoteTurns;
      let quoteTurn=options.quoteTurn;
      if (this.shouldSkipAutomatedOffHoursMarketCycle(trigger, options)) {
        if(quoteTurn)yield {phase:'quote-skip',kind:'commit',work:()=>turns.skip(quoteTurn,'offhours-skip')};
        try { (yield {phase:'daily-candles',work:()=>this.dailyCandleService?.runScheduled?.()}); } catch (error) { log.warn("daily_candle_cycle_failed", { message: error.message }); }
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
        if(quoteTurn)yield {phase:'quote-skip',kind:'commit',work:()=>turns.skip(quoteTurn,'min-ticker-ttl')};
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

      let cycleDate,selectedMarketInstruments,selectedTickers;
      const marketResult = yield {phase:'quotes',kind:'acquisition',work:async()=>{
        if(quoteTurn){
          const current=this.marketSelection(trigger,options);
          if(current.policyHash!==quoteTurn.input.selection.policyHash || current.baseRevision!==quoteTurn.input.selection.baseRevision){
            await turns.skip(quoteTurn,'selection-superseded');
            return null;
          }
          if(this.shouldSkipAutomatedOffHoursMarketCycle(trigger,options)){
            await turns.skip(quoteTurn,'offhours-skip');
            return null;
          }
          const cadence=this.resolveNextMarketDelayMs();
          quoteTurn=await turns.authorize(quoteTurn,cadence);
          if(this.stopping){
            await turns.unsent(quoteTurn);
            return null;
          }
          try{this.admission?.assert('acquisition');}
          catch(error){quoteTurn=await turns.unsent(quoteTurn);throw error;}
          const atDispatch=this.marketSelection(trigger,options);
          if(atDispatch.policyHash!==quoteTurn.input.selection.policyHash || atDispatch.baseRevision!==quoteTurn.input.selection.baseRevision){
            await turns.skip(quoteTurn,'selection-superseded-before-dispatch');
            return null;
          }
        }
        selectedTickers=[...(this.config.market.tickers || [])];
        selectedMarketInstruments=this.config.market.watchlistService?.selectedInstruments?.() || [];
        cycleDate=this.resolveMarketCycleDate(options.now);
        try{
          return await fetchMarketQuotes({...this.config.market,trigger,previousQuotes:previousSnapshot.market?.quotes || {},
            previousTimeseries:previousSnapshot.market?.timeseries || {},allowExhaustedProviders:options.allowExhaustedProviders===true,
            timestamp:cycleDate.toISOString()});
        }catch(error){
          // A provider chain can fail after an earlier provider was contacted.
          // Only the admission check above proves no dispatch took place.
          if(quoteTurn && isResourcePressure(error))throw Object.assign(Error(error.message,{cause:error}),{code:'MARKET_REQUEST_OUTCOME_UNKNOWN'});
          throw error;
        }
      }};
      if(!marketResult)return;
      const marketState = mergeMarketState(previousSnapshot.market, marketResult);
      const analysisSnapshot = this.stateManager.state || this.stateManager.getSnapshot();
      const inputMode = resolveInputMode(previousSnapshot.meta?.sourceMode, marketState.sourceMode);
      const countryFilter = options.countries?.length ? options.countries : this.config.watchlistCountries;

      const analysisInput={
        asOf:cycleDate.toISOString(),
        ...(this.config.market.newsFromStorage ? {
          newsFromStorage:true,
          corpusOptions:{countries:this.config.watchlistCountries,windowHours:this.config.news.candidateWindowHours,awarenessMode:this.awarenessService?.mode || this.config.awareness?.mode || "off"}
        } : {articles:mergeArticleCorpora(this.stateManager.getMarketSignalCorpus?.() || [],this.awarenessService?.getMarketArticles?.() || [])}),
        countries:analysisSnapshot.countries,marketQuotes:marketState.quotes,tickers:selectedTickers,instruments:selectedMarketInstruments,
        countryFilter,windowMin:this.config.market.impactWindowMin,inputMode,
        // The coupling calculation consumes only the last 24 points and these fields.
        impactHistory:(previousSnapshot.impactHistory || []).slice(-24).map(entry=>({timestamp:entry.timestamp,items:(entry.items || []).map(item=>({ticker:item.ticker,impactScore:item.impactScore,eventScore:item.eventScore,priceReaction:item.priceReaction}))}))
      };
      const {marketQuotes,...parameters}=analysisInput;
      const presentation=this.marketHistoryStore?.presentation && analysisInput.newsFromStorage && this.config.market.analyzeInWorker
        ? {jobId:'presentation-'+randomUUID(),trigger,...(quoteTurn?{quoteTurn:turns.auth(quoteTurn)}:{}),analysis:structuredClone({...parameters,
          newsRevision:analysisSnapshot.meta?.sourceMeta?.corpus?.revision ?? null})} : null;
      if (presentation) {
        // Freeze the research observation at the same cut as the quote frame.
        // Source time on the quotes remains independent of this observation clock.
        const observedAt = new Date().toISOString();
        const quality = buildDataQuality({
          newsMode: analysisSnapshot.meta?.sourceMode || "fallback", newsMeta: analysisSnapshot.meta?.sourceMeta,
          marketMode: marketState.sourceMode || "fallback", marketMeta: marketState.sourceMeta
        });
        presentation.context = projectNewsContext({
          countries: analysisSnapshot.countries, impact: analysisSnapshot.impact,
          meta: {lastRefreshAt: observedAt, dataQuality: quality}
        }, observedAt);
      }
      // Confirm the frame and presentation obligation before either becomes
      // visible. Eligible history and the obligation share the same writer commit.
      yield {phase:'history',kind:'commit',work:async()=>{
        const commit=this.marketHistoryStore?.persistMarketState?.(previousSnapshot.market || {},marketState,{trigger,presentation});
        if(presentation)this.marketFrameCommit=commit;
        try{
          await commit;
          if(presentation)this.confirmedMarketJobId=presentation.jobId;
        }catch(error){
          if(presentation && error.code==='STORAGE_OUTCOME_UNKNOWN'){
            this.unconfirmedMarketFrame={jobId:presentation.jobId,error};
            this.marketPresentationError=error;
          }
          throw error;
        }finally{if(this.marketFrameCommit===commit)this.marketFrameCommit=null;}
      }};
      if(presentation && stableHash(this.config.market.tickers)!==stableHash(presentation.analysis.tickers)){
        this.recoveringMarketPresentation=true;
        return;
      }
      let snapshot;
      if(this.config.market.analyzeInWorker){
        snapshot=this.stateManager.updateIntel({market:marketState,watchlistCountries:this.config.watchlistCountries});
        this.socketServer.broadcast("update",{market:snapshot.market,meta:snapshot.meta},snapshot.meta);
        this.scheduleMarketProjection(presentation
          ? {...presentation.analysis,marketQuotes,presentationJobId:presentation.jobId,marketRevision:snapshot.market.revision}
          : {...analysisInput,marketRevision:snapshot.market.revision,newsRevision:analysisSnapshot.meta?.sourceMeta?.corpus?.revision});
      } else {
        const projection=calculateMarketProjection(analysisInput);
        snapshot=this.stateManager.updateIntel({...projection,market:marketState,watchlistCountries:this.config.watchlistCountries});
      }

      const aggregateNews = (yield {phase:'feed',work:()=>this.resolveAggregateNewsSnapshot()});
      if (!presentation) yield {phase:'context',work:()=>this.newsArchive?.recordContext(snapshot)};
      (yield {phase:'research',work:()=>this.researchCycle?.(snapshot)});
      (yield {phase:'flush',kind:'commit',work:()=>this.storageFlush?.()});
      (yield {phase:'signals',work:()=>this.refreshSecondaryIntel(snapshot, aggregateNews)});
      if (isAutomatedMarketTrigger(trigger)) {
        try { (yield {phase:'daily-candles',work:()=>this.dailyCandleService?.runScheduled?.()}); } catch (error) { log.warn("daily_candle_cycle_failed", { message: error.message }); }
        this.trackBackground(this.intradayCandleService?.runScheduled?.().catch((error) => log.warn("intraday_candle_cycle_failed", { message: error.message })));
      }
      // Secondary work can finish after a newer projection has already been sent.
      const currentUpdate = this.buildMarketUpdatePayload(this.stateManager.state || snapshot);
      this.socketServer.broadcast("update", currentUpdate, currentUpdate.meta);
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
      this.marketCycleTelemetry = {
        ...this.marketCycleTelemetry,
        lastCompletedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastStatus: "error",
        lastError: error.message
      };
      throw error;
    } finally {
      this.marketInFlight = false;
    }
  }

  presentationMatches(input,newsRevision){
    const state=this.stateManager.state;
    const currentNews=state.meta?.sourceMeta?.corpus?.revision;
    return this.isMarketEnabled() && input.marketRevision===state.market.revision && (currentNews===undefined || currentNews===newsRevision)
      && (input.newsRevision==null || input.newsRevision===newsRevision)
      && stableHash(input.tickers)===stableHash(this.config.market.tickers)
      && stableHash(input.instruments)===stableHash(this.config.market.watchlistService?.selectedInstruments?.() || [])
      && stableHash(input.corpusOptions.countries)===stableHash(this.config.watchlistCountries)
      && input.corpusOptions.awarenessMode===(this.awarenessService?.mode || this.config.awareness?.mode || 'off');
  }

  publishMarketProjection(projection,jobId=null){
    if(jobId && this.marketPresentationDelivery?.jobId===jobId && this.marketPresentationDelivery.sent)return;
    const alreadyApplied=jobId && this.marketPresentationDelivery?.jobId===jobId;
    const snapshot=alreadyApplied?this.stateManager.state:this.stateManager.updateIntel({...projection,watchlistCountries:this.config.watchlistCountries});
    if(jobId)this.marketPresentationDelivery={jobId,sent:false};
    this.socketServer.broadcast("update",{meta:snapshot.meta,insights:snapshot.insights,predictions:snapshot.predictions,impact:snapshot.impact,impactHistory:snapshot.impactHistory},snapshot.meta);
    if(jobId)this.marketPresentationDelivery.sent=true;
  }

  async applyConfirmedProjection(input){
    const coordinator=this.marketHistoryStore.presentation;
    const job=await coordinator.claim(input.presentationJobId);
    let projection=null;
    if(job){
      const {basis,watermark}=job.input;
      let reason='context-changed';
      if(this.presentationMatches(input,basis.news)){
        this.admission?.assert('heavy');
        projection=await this.config.market.analyzeInWorker({...input,corpusOptions:{...input.corpusOptions,revisionWatermark:watermark}});
        if(this.presentationMatches(input,basis.news))reason=null;
      }
      const closed=await coordinator.finish(job,projection,reason);
      if(closed.job.phase!=='published')return;
    }
    if(this.marketFrameCommit)await this.marketFrameCommit;
    // Pressure can interrupt the final read after the writer has already
    // closed the job. A later claim then returns null; recover the stored result.
    const latest=await coordinator.read(!job);
    if(latest?.job.jobId!==input.presentationJobId)return;
    if(latest.job.status==='pending')throw Object.assign(Error('Presentación reclamada'),{code:'STORAGE_CONTINUATION_BUSY'});
    if(latest.job.phase==='published' && latest.current && this.confirmedMarketJobId===input.presentationJobId
        && this.marketProjectionPending===input && this.presentationMatches(input,latest.job.input.basis.news)){
      this.publishMarketProjection(job?projection:latest.projection,input.presentationJobId);
    }
  }

  async recoverMarketPresentation(){
    const coordinator=this.marketHistoryStore?.presentation;
    if(!coordinator)return;
    const saved=await coordinator.read();
    if(this.unconfirmedMarketFrame){
      if(saved?.job.jobId!==this.unconfirmedMarketFrame.jobId)throw this.unconfirmedMarketFrame.error;
      this.unconfirmedMarketFrame=null;
    }
    if(!saved){this.marketPresentationError=null;this.recoveringMarketPresentation=false;return;}
    const {frame,job}=saved;
    this.confirmedMarketJobId=job.jobId;
    this.marketPresentationError=null;
    const input={...frame.analysis,marketQuotes:frame.market.quotes,marketRevision:frame.market.revision,presentationJobId:job.jobId};
    if(this.isMarketEnabled() && stableHash(input.tickers)===stableHash(this.config.market.tickers)){
      const previous=this.stateManager.state.market;
      const market=mergeMarketState(previous,{...frame.market,activeTickers:input.tickers});
      this.stateManager.hydrateMarketState(market);
    }
    if(job.status==='pending'){
      this.recoveringMarketPresentation=true;
      this.marketPresentationError=null;
      await this.scheduleMarketProjection(input);
    }else if(saved.projection && saved.current && this.presentationMatches(input,job.input.basis.news)){
      this.publishMarketProjection(saved.projection,job.jobId);
    }
    if(!this.marketProjectionPending && !this.marketPresentationError)this.recoveringMarketPresentation=false;
  }

  scheduleMarketProjection(input){
    this.marketProjectionPending=input;
    if(this.marketProjectionTask)return this.marketProjectionTask;
    const task=(async()=>{
      while(this.marketProjectionPending&&!this.stopping){
        let captured=this.marketProjectionPending;
        const market=this.stateManager.state.market;
        const revision=this.stateManager.state.meta?.sourceMeta?.corpus?.revision;
        if(!captured.presentationJobId && (captured.marketRevision!==market.revision || revision!==undefined&&captured.newsRevision!==revision)){
          captured={...captured,marketRevision:market.revision,newsRevision:revision,marketQuotes:market.quotes,countries:this.stateManager.state.countries,
            ...(!captured.newsFromStorage?{articles:mergeArticleCorpora(this.stateManager.getMarketSignalCorpus?.() || [],this.awarenessService?.getMarketArticles?.() || [])}:{})};
          this.marketProjectionPending=captured;
        }
        try{
          if(captured.presentationJobId){
            await this.applyConfirmedProjection(captured);
            this.marketPresentationError=null;
            this.recoveringMarketPresentation=false;
            if(this.marketProjectionPending===captured)this.marketProjectionPending=null;
            this.resourceDeferred.delete('projection');
            continue;
          }
          this.admission?.assert('heavy');
          const projection=await this.config.market.analyzeInWorker(captured);
          if(this.marketProjectionPending===captured)this.marketProjectionPending=null;
          if(this.stateManager.state.market.revision!==captured.marketRevision){if(this.marketProjectionPending)continue;this.marketProjectionPending=captured;break;}
          const analyzedNewsRevision=projection.newsCoverage?.revision ?? captured.newsRevision;
          const currentNewsRevision=this.stateManager.state.meta?.sourceMeta?.corpus?.revision;
          if(currentNewsRevision!==undefined && analyzedNewsRevision!==undefined && currentNewsRevision!==analyzedNewsRevision){
            this.marketProjectionPending ||= captured;break;
          }
          this.publishMarketProjection(projection);
          this.resourceDeferred.delete('projection');
        }catch(error){
          if(isResourcePressure(error)){this.resourceDeferred.add('projection');log.info('market_projection_deferred',{code:error.code,reason:error.details?.reason});break;}
          if(captured.presentationJobId)this.marketPresentationError=error;
          if(this.marketProjectionPending===captured)this.marketProjectionPending=null;
          log.warn("market_projection_failed",{code:error.code || "MARKET_ANALYSIS_FAILED",command:error.diagnostic});
        }
      }
    })().finally(()=>{this.marketProjectionTask=null;queueMicrotask(this.resumeResources);});
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
      this.admission?.assert('acquisition');
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
    this.stopping = false;
    this.admission?.on('change',this.resumeResources);
    if (this.rssAggregator) {
      this.rssAggregator.onSnapshot = () => this.runNewsCycle("rss-selected", {rssOnly:true});
      // The SQL adapter collects RSS through the scheduled news cycle.
      this.rssAggregator.start?.();
    }

    if (!this.newsTimerHandle) {
      this.runNewsCycle("startup-news", { allowExhaustedProviders: false })
        .catch((error) => {
          log[isResourcePressure(error)?'info':'error']("news_cycle_startup_failed", {code:error.code,message:error.message});
        })
        .finally(() => {
          this.scheduleNextNewsCycle("interval-news");
        });
    }

    if (!this.marketTimerHandle && this.isMarketEnabled()) {
      this.runMarketCycle("startup-market")
        .catch((error) => {
          log[isResourcePressure(error)?'info':'error']("market_cycle_startup_failed", {code:error.code,message:error.message});
        })
        .finally(() => {
          this.scheduleNextMarketCycle("interval-market");
        });
    } else if (!this.isMarketEnabled()) {
      this.markMarketTelemetryDisabled();
    }
  }

  async stop() {
    this.admission?.off('change',this.resumeResources);
    this.stopped = true;
    this.stopping = true;
    this.rssSelectionPending = false;
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
    this.deferredAtShutdown=[...this.continuations].map(([domain,continuation])=>({domain,phase:continuation.phase,durable:false}));
    if(this.marketHistoryStore?.quoteTurns){
      try{
        const job=await this.marketHistoryStore.quoteTurns.pending();
        const uncertain=this.marketHistoryStore.quoteTurns.unacknowledged;
        if(uncertain && job?.jobId!==uncertain.jobId)this.deferredAtShutdown.push({
          domain:'market',phase:'quote-admission',jobId:uncertain.jobId,verification:'unconfirmed',durable:false});
        if(job){
          // After dispatch the obligation is durable; the HTTP outcome can still be unknown.
          this.deferredAtShutdown=this.deferredAtShutdown.filter(row=>row.domain!=='market' || !['admission','quotes'].includes(row.phase));
          this.deferredAtShutdown.push({domain:'market',phase:job.phase,jobId:job.jobId,cursor:job.cursor,durable:true,
            ...(job.phase==='request-authorized'?{acquisitionOutcome:'unknown',nextEligibleAt:job.input.nextEligibleAt}:{})});
        }
      }catch(error){this.deferredAtShutdown.push({domain:'market',phase:'quote-admission',verification:'unknown',durable:false,code:error.code});}
    }
    if(this.marketHistoryStore?.presentation){
      try{
        const job=await this.marketHistoryStore.presentation.pending();
        if(job)this.deferredAtShutdown.push({domain:'market',phase:job.phase,jobId:job.jobId,cursor:job.cursor,durable:true});
      }catch(error){this.deferredAtShutdown.push({domain:'market',phase:'projection',verification:'unknown',durable:false,code:error.code});}
    }
    if (this.awarenessService?.store?.financialContinuations) {
      try {
        const job = await this.awarenessService.store.financialContinuations.pending();
        if (job) {
          this.deferredAtShutdown = this.deferredAtShutdown.filter(row => row.domain !== 'news' || !['financial-recovery','financial-ingestion'].includes(row.phase));
          this.deferredAtShutdown.push({domain:'news', phase:job.phase, jobId:job.jobId, cursor:job.cursor, durable:true});
        }
      } catch (error) {
        this.deferredAtShutdown.push({domain:'news', phase:'financial-ingestion', verification:'unknown', durable:false, code:error.code});
      }
    }
    if (this.researchAwareness) {
      const unstaged = this.researchAwareness.unstaged;
      try {
        const job = await this.researchAwareness.pending();
        if (job) {
          this.deferredAtShutdown = this.deferredAtShutdown.filter(row => row.phase !== 'research');
          this.deferredAtShutdown.push({domain:'research', phase:job.phase, jobId:job.jobId, cursor:job.cursor, durable:true});
        }
        if (unstaged && job?.jobId !== unstaged.jobId) {
          this.deferredAtShutdown.push({domain:'research', phase:'awareness-admit', jobId:unstaged.jobId, durable:false, verification:'unconfirmed'});
        }
      } catch (error) {
        this.deferredAtShutdown.push({domain:'research', phase:'awareness-events', verification:'unknown', durable:false, code:error.code});
      }
    }
    for(const continuation of this.continuations.values())await continuation.close();
    this.continuations.clear();this.resourceDeferred.clear();this.marketProjectionPending=null;
  }
}

export default RefreshOrchestratorService;
