import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { providerRuntime } from "../providers/providerRuntime.js";
import { classifyRssArticle } from "./rssClassifier.js";
import { deduplicateRssArticles } from "./rssDeduplicator.js";
import { hasFeedEntries, hasFeedEnvelope, parseFeedArticles } from "./providers/rssProvider.js";

class Semaphore {
  constructor(limit) { this.limit = Math.max(1, limit); this.active = 0; this.waiters = []; }
  async use(callback) { if (this.active >= this.limit) await new Promise((resolve) => this.waiters.push(resolve)); this.active += 1; try { return await callback(); } finally { this.active -= 1; this.waiters.shift()?.(); } }
}

function initialState() { return { etag: null, lastModified: null, lastAttemptAt: null, lastSuccessAt: null, nextEligibleAt: null, cooldownUntil: null, consecutiveErrors: 0, healthStatus: "unknown", articles: [] }; }

export class RssCanonicalPipeline {
  constructor({ catalog, fetchImpl, now = Date.now, persistencePath = null, globalConcurrency = 4, hostConcurrency = 1, maxFeedsPerCycle = 18, cycleDeadlineMs = 60_000, timeoutMs = 9_000, maxCorpusItems = 900 } = {}) {
    this.catalog = catalog; this.fetchImpl = fetchImpl; this.now = now; this.persistencePath = persistencePath;
    this.globalConcurrency = globalConcurrency; this.hostConcurrency = hostConcurrency; this.maxFeedsPerCycle = Math.min(18, Math.max(12, maxFeedsPerCycle));
    this.cycleDeadlineMs = cycleDeadlineMs; this.timeoutMs = timeoutMs; this.maxCorpusItems = maxCorpusItems;
    this.states = new Map(); this.hostSemaphores = new Map(); this.corpus = []; this.metrics = { cycles: 0, externalRequests: 0, notModified: 0, errors: 0, staleServed: 0, duplicates: 0, latencyMs: 0 };
    this.hydrate();
  }
  state(feedId) { if (!this.states.has(feedId)) this.states.set(feedId, initialState()); return this.states.get(feedId); }
  hostSemaphore(host) { if (!this.hostSemaphores.has(host)) this.hostSemaphores.set(host, new Semaphore(this.hostConcurrency)); return this.hostSemaphores.get(host); }
  async fetch(url, options) {
    if (!this.fetchImpl) return providerRuntime.fetch("rss", url, options);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try { return await this.fetchImpl(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timeout); }
  }
  selectEligible(nowMs = this.now()) {
    return this.catalog.feeds.filter((feed) => !feed.disabled).filter((feed) => {
      const state = this.state(feed.feedId); return (!state.nextEligibleAt || state.nextEligibleAt <= nowMs) && (!state.cooldownUntil || state.cooldownUntil <= nowMs);
    }).sort((left, right) => {
      const leftState = this.state(left.feedId); const rightState = this.state(right.feedId);
      const leftOverdue = nowMs - (leftState.nextEligibleAt || 0); const rightOverdue = nowMs - (rightState.nextEligibleAt || 0);
      return rightOverdue - leftOverdue || right.priority - left.priority || left.feedId.localeCompare(right.feedId);
    }).slice(0, this.maxFeedsPerCycle);
  }
  async runCycle() {
    const startedAt = this.now(); const deadlineAt = startedAt + this.cycleDeadlineMs; const selected = this.selectEligible(startedAt); const global = new Semaphore(this.globalConcurrency);
    const results = await Promise.all(selected.map((feed) => global.use(() => this.#pollFeed(feed, deadlineAt))));
    const incoming = results.flatMap((result) => result.articles || []);
    const merged = deduplicateRssArticles([...this.corpus, ...incoming], { maxItems: this.maxCorpusItems });
    this.metrics.cycles += 1; this.metrics.duplicates += Math.max(0, this.corpus.length + incoming.length - merged.items.length); this.metrics.latencyMs += Math.max(0, this.now() - startedAt);
    this.corpus = merged.items; this.persist();
    return { generatedAt: new Date(this.now()).toISOString(), items: this.corpus, meta: { provider: "rss-canonical", selectedFeedCount: selected.length, feedStatus: results.map(({ articles, ...result }) => {
      const state = this.state(result.feedId); return { ...result, healthStatus: state.healthStatus, nextEligibleAt: state.nextEligibleAt ? new Date(state.nextEligibleAt).toISOString() : null, cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null, hasEtag: Boolean(state.etag), hasLastModified: Boolean(state.lastModified) };
    }), metrics: structuredClone(this.metrics), catalogStats: this.catalog.stats } };
  }
  async #pollFeed(feed, deadlineAt) {
    const state = this.state(feed.feedId); const nowMs = this.now();
    if (nowMs >= deadlineAt) return { feedId: feed.feedId, url: feed.canonicalUrl, status: "deadline", count: 0 };
    state.lastAttemptAt = nowMs; state.nextEligibleAt = nowMs + feed.minPollIntervalMs;
    const headers = { "User-Agent": "ogid/1.0" }; if (state.etag) headers["If-None-Match"] = state.etag; if (state.lastModified) headers["If-Modified-Since"] = state.lastModified;
    try {
      return await this.hostSemaphore(new URL(feed.canonicalUrl).host).use(async () => {
        this.metrics.externalRequests += 1;
        const response = await this.fetch(feed.canonicalUrl, { headers, retries: 0, timeoutMs: Math.min(this.timeoutMs, Math.max(1, deadlineAt - this.now())) });
        if (response.status === 304) { this.metrics.notModified += 1; state.healthStatus = "healthy"; state.consecutiveErrors = 0; return { feedId: feed.feedId, url: feed.canonicalUrl, status: "not-modified", count: state.articles.length, articles: state.articles }; }
        if (!response.ok) throw new Error(`rss-upstream-${response.status}`);
        const xml = await response.text(); if (!hasFeedEnvelope(xml) || !hasFeedEntries(xml)) throw new Error("rss-malformed-xml");
        const fetchedAt = new Date(this.now()).toISOString();
        const articles = parseFeedArticles(xml, feed.label, feed).map((article, index) => classifyRssArticle({ ...article, id: article.id || `${feed.feedId}-${index}`, provenance: { ...article.provenance, feedId: feed.feedId, sourceId: feed.sourceId, sourceType: feed.type, queryProvider: feed.queryProvider, canonicalUrl: feed.canonicalUrl, fetchedAt, pipeline: "canonical-rss", stale: false, methodVersion: feed.provenance?.methodVersion || "rss-canonical-v1" } }));
        state.etag = response.headers.get("etag") || state.etag; state.lastModified = response.headers.get("last-modified") || state.lastModified;
        state.lastSuccessAt = this.now(); state.consecutiveErrors = 0; state.healthStatus = "healthy"; state.cooldownUntil = null; state.articles = articles;
        return { feedId: feed.feedId, url: feed.canonicalUrl, status: articles.length ? "ok" : "empty", count: articles.length, articles };
      });
    } catch (error) {
      state.consecutiveErrors += 1; state.healthStatus = state.consecutiveErrors >= 3 ? "unhealthy" : "degraded";
      const cooldownMs = Math.min(6 * 60 * 60_000, 15 * 60_000 * (2 ** (state.consecutiveErrors - 1))); state.cooldownUntil = this.now() + cooldownMs; this.metrics.errors += 1;
      if (state.articles.length) { this.metrics.staleServed += state.articles.length; const articles = state.articles.map((article) => ({ ...article, provenance: { ...article.provenance, stale: true }, dataMode: "stale" })); return { feedId: feed.feedId, url: feed.canonicalUrl, status: "stale", count: articles.length, error: error.message, articles }; }
      return { feedId: feed.feedId, url: feed.canonicalUrl, status: "error", count: 0, error: error.message, articles: [] };
    }
  }
  persist() { if (!this.persistencePath) return; mkdirSync(dirname(this.persistencePath), { recursive: true }); const temporary = `${this.persistencePath}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify({ version: 1, states: Object.fromEntries(this.states), corpus: this.corpus, metrics: this.metrics }), { mode: 0o600 }); renameSync(temporary, this.persistencePath); }
  hydrate() { if (!this.persistencePath) return false; try { const payload = JSON.parse(readFileSync(this.persistencePath, "utf8")); this.states = new Map(Object.entries(payload.states || {})); this.corpus = payload.corpus || []; this.metrics = { ...this.metrics, ...(payload.metrics || {}) }; return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
  rollback() { return { mode: "legacy", corpusPreserved: this.corpus.length, statePreserved: this.states.size }; }
}

export function projectCanonicalToProvider(snapshot) { return { provider: "rss", articles: snapshot.items || [], sourceMeta: { provider: "rss", totalResults: snapshot.items?.length || 0, feedStatus: snapshot.meta?.feedStatus || [], canonical: true, metrics: snapshot.meta?.metrics || {} } }; }
export function compareRssSnapshots(legacy, canonical) { const legacyKeys = new Set((legacy?.articles || []).map((item) => `${item.url || ""}|${item.title || ""}`.toLowerCase())); const canonicalKeys = new Set((canonical?.items || []).map((item) => `${item.url || ""}|${item.title || ""}`.toLowerCase())); const overlap = [...legacyKeys].filter((key) => canonicalKeys.has(key)).length; return { legacyCount: legacyKeys.size, canonicalCount: canonicalKeys.size, overlap, coverage: legacyKeys.size ? overlap / legacyKeys.size : 1, crossPipelineDuplicates: overlap }; }
