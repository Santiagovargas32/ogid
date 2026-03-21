import { createLogger } from "../../utils/logger.js";
import { BoundedCache } from "../shared/boundedCache.js";
import { deduplicateRssArticles } from "./rssDeduplicator.js";
import { buildExtendedRssFeedCatalog, classifyRssArticle } from "./rssClassifier.js";
import { fetchRss } from "./providers/rssProvider.js";

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
    this.cursor = 0;
    this.corpus = [];
    this.lastSnapshot = null;
  }

  configure(config = {}) {
    this.config = config;
    this.refreshIntervalMs = toPositiveInt(config.refreshIntervalMs || config.news?.rssAggregateIntervalMs, config.news?.intervalMs);
    this.timeoutMs = toPositiveInt(config.timeoutMs || config.news?.timeoutMs, 9_000);
    const catalog = buildExtendedRssFeedCatalog(config.rssFeeds || config.news?.rssFeeds || []);
    this.feedCatalog = catalog.feeds;
    this.feedCatalogStats = catalog.stats;
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
    const batch = [...activeConfigured];
    const rollingSlots = Math.max(0, this.maxFeedsPerRun - batch.length);

    for (let index = 0; index < rollingSlots && generated.length; index += 1) {
      batch.push(generated[(this.cursor + index) % generated.length]);
    }

    if (generated.length) {
      this.cursor = (this.cursor + rollingSlots) % generated.length;
    }

    return batch.slice(0, this.maxFeedsPerRun);
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
    const providerResult = await fetchRss({
      feeds,
      timeoutMs: this.timeoutMs
    });
    const enriched = (providerResult.articles || []).map((article, index) =>
      classifyRssArticle({
        ...article,
        id: article.id || `rss-aggregate-${Date.now()}-${index + 1}`
      })
    );
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
        provider: "rss-aggregate"
      }
    };

    this.lastSnapshot = snapshot;
    this.cache.set("rss-aggregate", snapshot, this.refreshIntervalMs);
    log.info("rss_aggregate_refreshed", {
      catalogSize: this.feedCatalog.length,
      queriedFeedCount: feeds.length,
      totalItems: this.corpus.length
    });
    return snapshot;
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
