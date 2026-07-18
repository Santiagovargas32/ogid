import { createLogger } from "../../utils/logger.js";
import { BoundedCache } from "../shared/boundedCache.js";
import { deduplicateRssArticles } from "./rssDeduplicator.js";
import { buildExtendedRssFeedCatalog, classifyRssArticle } from "./rssClassifier.js";
import { fetchRss } from "./providers/rssProvider.js";
import { buildCanonicalRssCatalog } from "./rssCanonicalCatalog.js";
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
    this.shadowComparisonStats = { cycles: 0, equivalentCycles: 0 };
    this.canonicalPipeline = new RssCanonicalPipeline({
      catalog: this.canonicalCatalog,
      fetchImpl: config.canonicalFetchImpl,
      now: config.now,
      persistencePath: config.persistencePath || config.news?.rssCanonicalStateFile || null,
      globalConcurrency: config.globalConcurrency || config.news?.rssGlobalConcurrency || 4,
      hostConcurrency: config.hostConcurrency || config.news?.rssHostConcurrency || 1,
      maxFeedsPerCycle: this.maxFeedsPerRun,
      cycleDeadlineMs: config.cycleDeadlineMs || config.news?.rssCycleDeadlineMs || 60_000,
      timeoutMs: this.timeoutMs,
      maxCorpusItems: this.maxCorpusItems
    });
  }

  configure(config = {}) {
    this.config = config;
    this.refreshIntervalMs = toPositiveInt(config.refreshIntervalMs || config.news?.rssAggregateIntervalMs, config.news?.intervalMs);
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

  async refresh({ force = false } = {}) {
    const cacheKey = "rss-aggregate";
    const cached = !force ? this.cache.get(cacheKey) : null;
    if (cached?.value) {
      return cached.value;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.runRefresh()
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async runRefresh() {
    const feeds = this.nextFeedBatch();
    const legacyPromise = this.pipelineMode === "canonical" ? null : fetchRss({ feeds, timeoutMs: this.timeoutMs });
    const canonicalPromise = this.pipelineMode === "legacy" ? null : this.canonicalPipeline.runCycle();
    if (this.pipelineMode === "canonical") {
      const canonicalSnapshot = await canonicalPromise;
      return this.#buildSnapshot(projectCanonicalToProvider(canonicalSnapshot), feeds, { canonicalSnapshot });
    }
    const providerResult = await legacyPromise;
    const canonicalSnapshot = canonicalPromise ? await canonicalPromise : null;
    return this.#buildSnapshot(providerResult, feeds, { canonicalSnapshot });
  }

  #buildSnapshot(providerResult, feeds, { canonicalSnapshot = null } = {}) {
    const enriched = providerResult.sourceMeta?.canonical
      ? (providerResult.articles || [])
      : (providerResult.articles || []).map((article, index) => classifyRssArticle({
          ...article,
          id: article.id || `rss-aggregate-${Date.now()}-${index + 1}`
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
        queriedFeedCount: feeds.length,
        queriedFeeds: feeds.map((feed) => ({ label: feed.label, url: feed.url, generated: Boolean(feed.generated) })),
        totalItems: this.corpus.length,
        dedupedClusters: Object.keys(merged.clusters || {}).length,
        feedStatus: providerResult.sourceMeta?.feedStatus || [],
        provider: "rss-aggregate",
        pipelineMode: this.pipelineMode,
        canonicalCatalogStats: this.canonicalCatalog.stats
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
        ...comparison,
        errorRate,
        equivalent,
        consecutiveEquivalentCycles: this.shadowComparisonStats.equivalentCycles,
        cutoverEligible: this.shadowComparisonStats.equivalentCycles >= 10,
        criteria: { minimumCoverage: 0.95, maximumErrorRate: 0.05, consecutiveCycles: 10 }
      };
      snapshot.meta.canonicalMetrics = canonicalSnapshot.meta?.metrics || {};
    }

    this.lastSnapshot = snapshot;
    this.cache.set("rss-aggregate", snapshot, this.refreshIntervalMs);
    log.info("rss_aggregate_refreshed", {
      catalogSize: this.feedCatalog.length,
      queriedFeedCount: feeds.length,
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

  async getSnapshot({ force = false, countries = [], topic = "", threat = "", limit = null } = {}) {
    const snapshot = await this.refresh({ force });
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
