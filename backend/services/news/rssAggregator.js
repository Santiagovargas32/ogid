import { articleIdentity } from "./articleIdentity.js";
import { shareOperation } from "../shared/operationContext.js";
import { createLogger } from "../../utils/logger.js";
import { BoundedCache } from "../shared/boundedCache.js";
import { deduplicateRssArticles } from "./rssDeduplicator.js";
import { buildExtendedRssFeedCatalog, classifyRssArticle } from "./rssClassifier.js";
import { canonicalizeFeedUrl, buildCanonicalRssCatalog } from "./rssCanonicalCatalog.js";
import { compareRssSnapshots, projectCanonicalToProvider, RssCanonicalPipeline } from "./rssCanonicalPipeline.js";

const log = createLogger("backend/services/news/rssAggregator");

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeThreat(value = "") {
  const normalized = String(value || "").toLowerCase();
  return ["critical", "elevated", "monitoring", "low"].includes(normalized) ? normalized : "";
}

export class RssAggregatorService {
  constructor(config = {}) {
    this.configure(config);
    this.cache = new BoundedCache({
      maxEntries: 8,
      defaultTtlMs: this.refreshIntervalMs
    });
    this.inFlight = null;
    this.configuredCursor = 0;
    this.generatedCursor = 0;
    this.corpus = [];
    this.lastSnapshot = null;
    this.scheduler = null; this.stopped = true; this.onSnapshot = null;
    this.onCollected = config.onCollected || null;
    this.shadowComparisonStats = { cycles: 0, equivalentCycles: 0 };
    this.canonicalPipeline = new RssCanonicalPipeline({
      catalog: this.canonicalCatalog,
      fetchImpl: config.canonicalFetchImpl,
      now: config.now,
      persistencePath: config.persistencePath || config.news?.rssCanonicalStateFile || null,
      globalConcurrency: config.globalConcurrency || config.news?.rssGlobalConcurrency || 4,
      hostConcurrency: config.hostConcurrency || config.news?.rssHostConcurrency || 1,
      maxFeedsPerCycle: this.maxFeedsPerRun,
      cycleDeadlineMs: config.cycleDeadlineMs || config.news?.rssCycleDeadlineMs || 25_000,
      timeoutMs: this.timeoutMs,
      maxCorpusItems: this.maxCorpusItems,
      onCollected: articles => this.onCollected?.(articles),
      maxResponseBytes: config.news?.rssMaxResponseBytes || 2_000_000,
      maxItemsPerFeed: config.news?.rssMaxItemsPerFeed || 200
    });
    if (this.pipelineMode === "canonical") {
      this.corpus = this.canonicalPipeline.corpus;
      const restored = this.canonicalPipeline.snapshot();
      if (this.corpus.length) this.lastSnapshot = { ...restored, meta: { ...restored.meta, pipelineMode: this.pipelineMode, restored: true } };
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      try { const snapshot = await this.refresh(); if (!this.stopped) await this.onSnapshot?.(snapshot); }
      catch (error) { log.warn("rss_scheduler_failed", { message: error.message }); }
      finally { if (!this.stopped) this.scheduler = setTimeout(tick, this.refreshIntervalMs || 30_000); }
    };
    void tick();
  }
  getStatus() {
    const meta=this.canonicalPipeline.snapshot().meta;
    const successes=meta.feedStatus.map(feed=>feed.lastSuccessAt).filter(Boolean).sort();
    return {...meta,pipelineMode:this.pipelineMode,active:!this.stopped,lastSuccessAt:successes.at(-1) || null};
  }
  async stop() { this.stopped = true; clearTimeout(this.scheduler); await this.canonicalPipeline.stop(); await this.inFlight; }

  configure(config = {}) {
    this.config = config;
    this.refreshIntervalMs = toPositiveInt(config.refreshIntervalMs || config.news?.rssAggregateIntervalMs, 30_000);
    this.timeoutMs = toPositiveInt(config.timeoutMs || config.news?.timeoutMs, 9_000);
    const catalog = buildExtendedRssFeedCatalog(config.rssFeeds || config.news?.rssFeeds || []);
    this.feedCatalog = catalog.feeds;
    this.feedCatalogStats = catalog.stats;
    this.pipelineMode = ["legacy", "shadow", "canonical"].includes(String(config.pipelineMode || config.news?.rssPipelineMode || "legacy").toLowerCase())
      ? String(config.pipelineMode || config.news?.rssPipelineMode || "legacy").toLowerCase() : "legacy";
    this.canonicalCatalog = buildCanonicalRssCatalog({
      primaryFeeds: (config.rssFeeds || config.news?.rssFeeds || []).filter((feed) => !feed.generated),
      secondaryFeeds: catalog.feeds.filter((feed) => feed.generated)
    });
    const derivedMaxFeedsPerRun = this.feedCatalog.filter((feed) => !feed.disabled).length || 1;
    const configuredPageSize = toPositiveInt(config.news?.pageSize, null);
    const derivedMaxCorpusItems = Math.max(
      derivedMaxFeedsPerRun,
      configuredPageSize ? derivedMaxFeedsPerRun * configuredPageSize : derivedMaxFeedsPerRun
    );
    this.maxFeedsPerRun = toPositiveInt(config.maxFeedsPerRun || config.news?.rssAggregateFeedsPerRun, derivedMaxFeedsPerRun);
    this.maxCorpusItems = toPositiveInt(config.maxCorpusItems || config.news?.rssAggregateMaxItems, derivedMaxCorpusItems);
  }

  nextFeedBatch() {
    if (!this.feedCatalog.length) {
      return [];
    }

    const activeConfigured = this.feedCatalog.filter((feed) => !feed.generated && !feed.disabled);
    const generated = this.feedCatalog.filter((feed) => feed.generated && !feed.disabled);
    const batch = [];
    const configuredSlots = activeConfigured.length
      ? Math.min(this.maxFeedsPerRun, activeConfigured.length - this.configuredCursor)
      : 0;

    for (let index = 0; index < configuredSlots; index += 1) {
      batch.push(activeConfigured[this.configuredCursor + index]);
    }

    if (activeConfigured.length) {
      this.configuredCursor = (this.configuredCursor + configuredSlots) % activeConfigured.length;
    }

    const rollingSlots = Math.max(0, this.maxFeedsPerRun - batch.length);

    for (let index = 0; index < rollingSlots && generated.length; index += 1) {
      batch.push(generated[(this.generatedCursor + index) % generated.length]);
    }

    if (generated.length) {
      this.generatedCursor = (this.generatedCursor + rollingSlots) % generated.length;
    }

    return batch;
  }

  registerFeeds(feeds=[]){
    const known=new Set(this.canonicalCatalog.feeds.flatMap(feed=>[feed.canonicalUrl,...feed.aliases]));
    const missing=feeds.filter(feed=>{try{return !known.has(canonicalizeFeedUrl(feed.url || feed));}catch{return false;}});
    if(missing.length){
      const all=[...this.canonicalCatalog.feeds,...missing];
      const catalog=buildCanonicalRssCatalog({primaryFeeds:all.filter(feed=>!feed.generated),secondaryFeeds:all.filter(feed=>feed.generated)});
      for(const feed of catalog.feeds){const previous=this.canonicalCatalog.byId.get(feed.feedId);if(previous)feed.aliases=[...new Set([...previous.aliases,...feed.aliases])];}
      this.canonicalCatalog=catalog;this.canonicalPipeline.catalog=catalog;
    }
    const urls=new Set(feeds.map(feed=>{try{return canonicalizeFeedUrl(feed.url || feed);}catch{return null;}}));
    return this.canonicalCatalog.feeds.filter(feed=>urls.has(feed.canonicalUrl)||feed.aliases.some(url=>urls.has(url))).map(feed=>feed.feedId);
  }
  async refresh({ force = false,feedIds=null,maxFeedsPerCycle,timeoutMs } = {}) {
    const cacheKey = "rss-aggregate";
    // A disjoint trigger with no eligible feeds reads the last committed corpus;
    // it must not subscribe to a slow acquisition belonging to another scope.
    if(feedIds && this.inFlight && !this.canonicalPipeline.selectEligible(this.canonicalPipeline.now(),{feedIds,maxFeedsPerCycle}).length){
      const snapshot=this.lastSnapshot || {generatedAt:null,items:[],meta:{}};
      return {...snapshot,meta:{...snapshot.meta,stored:true,queriedFeedCount:0,feedStatus:[],acquisition:{attempted:0,successfulChecks:0,contentChanges:0}}};
    }
    const cached = !feedIds && (!force || Date.now() - (this.lastAttemptMs || 0) < this.refreshIntervalMs) ? this.cache.get(cacheKey) : null;
    if (cached?.value) {
      return cached.value;
    }

    if (this.inFlight) {
      return shareOperation(this.inFlight);
    }

    this.lastAttemptMs = Date.now();
    this.inFlight = this.runRefresh({feedIds,maxFeedsPerCycle,timeoutMs})
      .finally(() => {
        this.inFlight = null;
      });
    return shareOperation(this.inFlight);
  }

  async runRefresh(options={}) {
    // Modes select projections; all modes share eligibility and durable acquisition.
    const canonicalSnapshot = await this.canonicalPipeline.runCycle(options);
    const ids=new Set(canonicalSnapshot.selectedFeedIds);
    const feeds=this.canonicalCatalog.feeds.filter(feed=>ids.has(feed.feedId)).map(feed=>({...feed,url:feed.canonicalUrl}));
    return this.#buildSnapshot(projectCanonicalToProvider(canonicalSnapshot), feeds, { canonicalSnapshot });
  }

  async #buildSnapshot(providerResult, feeds, { canonicalSnapshot = null } = {}) {
    const enriched = providerResult.sourceMeta?.canonical
      ? (providerResult.articles || [])
      : (providerResult.articles || []).map((article, index) => classifyRssArticle({
          ...article,
          id: article.id || articleIdentity(article)
        }));
    const merged = deduplicateRssArticles([...this.corpus, ...enriched], {
      maxItems: this.maxCorpusItems
    });
    this.corpus = merged.items;

    const snapshot = {
      generatedAt: new Date().toISOString(),
      items: this.corpus,
      meta: {
        catalogSize: this.feedCatalog.length,
        catalogStats: this.feedCatalogStats,
        queriedFeedCount: canonicalSnapshot?.meta?.selectedFeedCount ?? feeds.length,
        queriedFeeds: feeds.map((feed) => ({ label: feed.label, url: feed.url, generated: Boolean(feed.generated) })),
        totalItems: this.corpus.length,
        dedupedClusters: Object.keys(merged.clusters || {}).length,
        feedStatus: providerResult.sourceMeta?.feedStatus || [],
        provider: "rss-aggregate",
        pipelineMode: this.pipelineMode,
        canonicalCatalogStats: this.canonicalCatalog.stats,
        coverage: canonicalSnapshot?.meta?.coverage || null,
        availability: canonicalSnapshot?.meta?.availability || null,
        acquisition: canonicalSnapshot?.meta?.acquisition || null
      }
    };

    if (canonicalSnapshot) {
      const comparison = compareRssSnapshots(providerResult, canonicalSnapshot);
      const requests = Number(canonicalSnapshot.meta?.metrics?.externalRequests || 0);
      const errors = Number(canonicalSnapshot.meta?.metrics?.errors || 0);
      const errorRate = requests ? errors / requests : 0;
      const equivalent = comparison.coverage >= 0.95 && errorRate <= 0.05;
      this.shadowComparisonStats.cycles += 1;
      this.shadowComparisonStats.equivalentCycles = equivalent ? this.shadowComparisonStats.equivalentCycles + 1 : 0;
      snapshot.meta.shadow = this.pipelineMode === "shadow";
      snapshot.meta.equivalence = {
        basis: "shared-acquisition-projection-comparison",
        ...comparison,
        errorRate,
        equivalent,
        consecutiveEquivalentCycles: this.shadowComparisonStats.equivalentCycles,
        cutoverEligible: false,
        reason: "shared-acquisition-does-not-validate-independent-transports",
        criteria: { minimumCoverage: 0.95, maximumErrorRate: 0.05, consecutiveCycles: 10 }
      };
      snapshot.meta.canonicalMetrics = canonicalSnapshot.meta?.metrics || {};
    }

    this.lastSnapshot = snapshot;
    this.cache.set("rss-aggregate", snapshot, this.refreshIntervalMs);
    log.info("rss_aggregate_refreshed", {
      catalogSize: this.feedCatalog.length,
      queriedFeedCount: canonicalSnapshot?.meta?.selectedFeedCount ?? feeds.length,
      totalItems: this.corpus.length,
      pipelineMode: this.pipelineMode,
      coverage: snapshot.meta.equivalence?.coverage ?? null,
      crossPipelineDuplicates: snapshot.meta.equivalence?.crossPipelineDuplicates ?? null,
      canonicalErrors: snapshot.meta.canonicalMetrics?.errors ?? null,
      canonicalExternalRequests: snapshot.meta.canonicalMetrics?.externalRequests ?? null,
      canonicalLatencyMs: snapshot.meta.canonicalMetrics?.latencyMs ?? null
    });
    return snapshot;
  }

  rollbackToLegacy() {
    this.pipelineMode = "legacy";
    this.cache.clear?.();
    return this.canonicalPipeline.rollback();
  }

  async getSnapshot({ force = false, stored = false, countries = [], topic = "", threat = "", limit = null } = {}) {
    if (stored && force) throw new Error("stored-and-force-conflict");
    const snapshot = stored ? this.lastSnapshot || { generatedAt: null, items: [], meta: { availability: "not-collected", stored: true } } : await this.refresh({ force });
    const countriesSet = new Set((countries || []).map((iso2) => String(iso2 || "").toUpperCase()));
    const topicFilter = String(topic || "").trim().toLowerCase();
    const threatFilter = normalizeThreat(threat);
    const resolvedLimit = toPositiveInt(limit, this.maxCorpusItems);

    const items = (snapshot.items || [])
      .filter((item) => {
        if (countriesSet.size && !(item.countryMentions || []).some((iso2) => countriesSet.has(String(iso2 || "").toUpperCase()))) {
          return false;
        }
        if (topicFilter && !(item.topicTags || []).some((tag) => String(tag || "").toLowerCase() === topicFilter)) {
          return false;
        }
        if (threatFilter && String(item.threatLevel || "").toLowerCase() !== threatFilter) {
          return false;
        }
        return true;
      })
      .slice(0, resolvedLimit);

    return {
      generatedAt: snapshot.generatedAt,
      items,
      meta: {
        ...snapshot.meta,
        filteredCount: items.length,
        forceRefreshed: force
      }
    };
  }
}
