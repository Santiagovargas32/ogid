import { createHash, randomUUID } from "node:crypto";
import { sanitizeSensitiveData } from "../../utils/sanitize.js";
import { createLogger } from "../../utils/logger.js";
import { buildCanonicalArticleLayer } from "./canonicalArticleService.js";
import { buildArticleSummaryJob, buildCountryInsightJob, buildMarketExplanationJob } from "./aiInputBuilder.js";
import { getAiOutputSchema, validateAiOutput } from "./aiSchemas.js";

const log = createLogger("backend/services/ai/aiEnrichmentCoordinator");
const FEATURE_KINDS = Object.freeze({
  "article-summary": "article_summary",
  "country-insight": "country_insight",
  "market-explanation": "market_explanation"
});

function cacheKeyFor(job, provider, model) {
  return createHash("sha256")
    .update([job.kind, job.subjectId, job.inputHash, provider, model, job.promptVersion, job.schemaVersion].join("|"))
    .digest("hex");
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function publicEntry(record, { status = null, refreshStatus = null } = {}) {
  const accepted = ["ready", "stale"].includes(record.status) && record.output;
  return {
    enrichmentId: record.enrichmentId,
    kind: record.kind,
    subjectId: record.subjectId,
    status: status || record.status,
    refreshStatus,
    output: accepted ? record.output : null,
    provider: record.provider,
    model: record.model,
    generatedAt: record.generatedAt || null,
    promptVersion: record.promptVersion,
    schemaVersion: record.schemaVersion,
    provenance: record.provenance || null,
    validation: record.validation || null
  };
}

export class AiEnrichmentCoordinator {
  constructor({ config = {}, provider, store, budget, stateManager = null, socketServer = null, technicalIndicatorService = null, newsPriceCouplingService = null, now = Date.now } = {}) {
    this.config = config;
    this.provider = provider;
    this.store = store;
    this.budget = budget;
    this.stateManager = stateManager;
    this.socketServer = socketServer;
    this.technicalIndicatorService = technicalIndicatorService;
    this.newsPriceCouplingService = newsPriceCouplingService;
    this.now = now;
    this.mode = ["off", "shadow", "visible"].includes(config.mode) ? config.mode : "off";
    this.features = new Set((config.features || []).map((feature) => FEATURE_KINDS[feature] || feature));
    this.maxConcurrency = Math.max(1, Math.min(2, Number(config.maxConcurrency) || 1));
    this.maxQueueSize = Math.max(1, Number(config.maxQueueSize) || 100);
    this.maxJobsPerCycle = Math.max(1, Number(config.maxJobsPerCycle) || 10);
    this.maxInputChars = Math.max(1_000, Number(config.maxInputChars) || 6_000);
    this.queue = [];
    this.queuedCacheKeys = new Set();
    this.active = 0;
    this.stopped = false;
    this.subjectRefs = new Map();
    this.lastCanonicalLayer = null;
    this.lastSignalCorpus = [];
    this.lastEligibility = { countries: {}, market: {} };
    this.lastError = null;
    this.updatedAt = null;
    this.metrics = { queued: 0, completed: 0, rejected: 0, failed: 0, cacheHits: 0, dropped: 0 };
  }

  isEnabled() {
    return this.mode !== "off" && this.provider?.enabled === true;
  }

  syncProjection({ broadcast = false } = {}) {
    const projection = this.getPublicProjection();
    this.stateManager?.setAiProjection?.(projection);
    if (broadcast) this.socketServer?.broadcast?.("ai:update:v1", { ai: projection }, this.stateManager?.getMeta?.() || {});
    return projection;
  }

  reconcileNewsSnapshot({ snapshot = {}, signalCorpus = [], displaySelection = [], rawArticles = [], instruments = [] } = {}) {
    this.lastCanonicalLayer = buildCanonicalArticleLayer({
      signalCorpus,
      displaySelection,
      rawArticles,
      instruments,
      marketQuotes: snapshot.market?.quotes || {}
    });
    this.lastSignalCorpus = signalCorpus;
    if (!this.isEnabled()) return this.syncProjection();

    let scheduled = 0;
    const representatives = [...this.lastCanonicalLayer.representatives]
      .filter((article) => !article.synthetic && article.dataMode !== "synthetic")
      .sort((left, right) => right.relevance.score - left.relevance.score);
    const directArticles = representatives.filter((article) => article.instrumentLinks.some((link) => link.relation === "direct"));
    const contextualArticles = representatives.filter((article) => !directArticles.includes(article));

    if (this.features.has("article_summary")) {
      scheduled += this.#scheduleArticleJobs(directArticles, this.maxJobsPerCycle - scheduled, 400);
    }

    if (this.features.has("country_insight") && scheduled < this.maxJobsPerCycle) {
      for (const [countryId, countryState] of Object.entries(snapshot.countries || {})) {
        if (scheduled >= this.maxJobsPerCycle) break;
        const job = buildCountryInsightJob(countryId, countryState, this.lastCanonicalLayer.articles, { maxInputChars: this.maxInputChars });
        if (!job.eligible) {
          this.lastEligibility.countries[countryId] = { eligible: false, reason: job.reason, clusterCount: job.clusterCount, publisherCount: job.publisherCount };
          continue;
        }
        this.lastEligibility.countries[countryId] = { eligible: true };
        if (this.#enqueue(job, {
          subjectKey: `country:${countryId}`,
          countryId,
          articleIds: job.validationContext.allowedArticleIds
        })) scheduled += 1;
      }
    }

    if (this.features.has("market_explanation") && scheduled < this.maxJobsPerCycle) {
      scheduled += this.#scheduleMarketJobs(snapshot, instruments, this.maxJobsPerCycle - scheduled);
    }
    if (this.features.has("article_summary") && scheduled < this.maxJobsPerCycle) {
      scheduled += this.#scheduleArticleJobs(contextualArticles, this.maxJobsPerCycle - scheduled, 100);
    }
    this.syncProjection();
    this.#drain();
    return { scheduled, canonicalArticles: this.lastCanonicalLayer.articles.length };
  }

  reconcileMarketSnapshot({ snapshot = {}, instruments = [] } = {}) {
    if (!this.isEnabled() || !this.features.has("market_explanation") || !this.lastCanonicalLayer) return this.syncProjection();
    const scheduled = this.#scheduleMarketJobs(snapshot, instruments, this.maxJobsPerCycle);
    this.syncProjection();
    this.#drain();
    return { scheduled };
  }

  #scheduleArticleJobs(articles, limit, priorityBase) {
    let scheduled = 0;
    for (const article of articles) {
      if (scheduled >= limit) break;
      const job = buildArticleSummaryJob(article, { maxInputChars: this.maxInputChars, priorityBase });
      const legacyArticleIds = this.lastCanonicalLayer.articles
        .filter((candidate) => candidate.clusterId === article.clusterId)
        .map((candidate) => candidate.legacyArticleId)
        .filter(Boolean);
      if (this.#enqueue(job, {
        subjectKey: `article:${article.canonicalArticleId}`,
        legacyArticleIds,
        canonicalArticleId: article.canonicalArticleId,
        clusterId: article.clusterId,
        articleIds: this.lastCanonicalLayer.membersByCluster[article.clusterId] || [article.canonicalArticleId]
      })) scheduled += 1;
    }
    return scheduled;
  }

  #scheduleMarketJobs(snapshot, instruments, limit) {
    let scheduled = 0;
    for (const impactItem of snapshot.impact?.items || []) {
      if (scheduled >= limit) break;
      const instrument = instruments.find((item) => String(item.canonicalSymbol || item.symbol || "").toUpperCase() === String(impactItem.ticker || "").toUpperCase())
        || { instrumentId: impactItem.ticker, canonicalSymbol: impactItem.ticker, displayName: impactItem.ticker };
      const job = buildMarketExplanationJob(impactItem, {
        ...(snapshot.market || {}),
        couplingSeries: snapshot.impact?.couplingSeries || []
      }, this.lastCanonicalLayer.articles, instrument, {
        maxInputChars: this.maxInputChars,
        deterministicAnalytics: this.#buildDeterministicMarketAnalytics(instrument)
      });
      if (!job.eligible) {
        this.lastEligibility.market[instrument.instrumentId] = { eligible: false, reason: job.reason };
        continue;
      }
      this.lastEligibility.market[instrument.instrumentId] = { eligible: true };
      if (this.#enqueue(job, {
        subjectKey: `market:${instrument.instrumentId}`,
        instrumentId: instrument.instrumentId,
        ticker: impactItem.ticker,
        articleIds: job.validationContext.allowedArticleIds
      })) scheduled += 1;
    }
    return scheduled;
  }

  #buildDeterministicMarketAnalytics(instrument) {
    const result = { technicalIndicators: null, couplingV2: [], errors: [] };
    if (!instrument?.instrumentId) return result;
    try {
      result.technicalIndicators = this.technicalIndicatorService?.calculate?.({
        instrumentId: instrument.instrumentId,
        interval: "1day",
        adjustmentMode: "splits"
      }) || null;
    } catch (error) {
      result.errors.push(`technical:${String(error?.code || "unavailable")}`);
    }
    try {
      const links = this.lastCanonicalLayer.articles.flatMap((article) => article.instrumentLinks
        .filter((link) => link.instrumentId === instrument.instrumentId)
        .map(() => ({ newsId: article.legacyArticleId, instrumentId: instrument.instrumentId })));
      result.couplingV2 = this.newsPriceCouplingService?.calculate?.({
        articles: this.lastSignalCorpus,
        links
      }) || [];
    } catch (error) {
      result.errors.push(`coupling:${String(error?.code || "unavailable")}`);
    }
    return result;
  }

  #buildEvidenceProvenance(articleIds = []) {
    const allowed = new Set(articleIds);
    return (this.lastCanonicalLayer?.articles || [])
      .filter((article) => allowed.has(article.canonicalArticleId))
      .map((article) => ({
        articleId: article.canonicalArticleId,
        legacyArticleId: article.legacyArticleId || null,
        clusterId: article.clusterId,
        sourceName: article.sourceName,
        publisher: article.publisher,
        publishedAt: article.publishedAt,
        canonicalUrl: article.canonicalUrl
      }));
  }

  #enqueue(job, subjectRef) {
    const model = this.provider.modelForKind(job.kind);
    const cacheKey = cacheKeyFor(job, this.provider.name, model);
    const accepted = this.store.findAcceptedByCacheKey(cacheKey);
    if (accepted) {
      this.metrics.cacheHits += 1;
      this.subjectRefs.set(subjectRef.subjectKey, { ...subjectRef, recordId: accepted.enrichmentId, fallbackRecordId: null });
      return false;
    }
    if (this.queuedCacheKeys.has(cacheKey)) return false;
    if (this.queue.length + this.active >= this.maxQueueSize) {
      this.metrics.dropped += 1;
      return false;
    }

    const previousRef = this.subjectRefs.get(subjectRef.subjectKey);
    const previousRecord = previousRef ? this.store.get(previousRef.recordId) : null;
    const timestamp = nowIso(this.now);
    const record = this.store.upsert({
      enrichmentId: `aie_${randomUUID()}`,
      kind: job.kind,
      subjectId: job.subjectId,
      articleId: job.kind === "article_summary" ? job.subjectId : null,
      clusterId: subjectRef.clusterId || null,
      status: "pending",
      output: null,
      provider: this.provider.name,
      model,
      promptVersion: job.promptVersion,
      schemaVersion: job.schemaVersion,
      createdAt: timestamp,
      updatedAt: timestamp,
      generatedAt: null,
      inputHash: job.inputHash,
      cacheKey,
      usage: null,
      requestId: null,
      providerResponse: null,
      provenance: {
        articleIds: subjectRef.articleIds || [],
        clusterId: subjectRef.clusterId || null,
        evidence: this.#buildEvidenceProvenance(subjectRef.articleIds || []),
        deterministicMethodVersions: ["canonical-article-v1", "article-instrument-link-v1", "news-selection-analysis-score-v1"]
      },
      validation: { schemaValid: false, groundingValid: false, codes: [] }
    });
    this.subjectRefs.set(subjectRef.subjectKey, {
      ...subjectRef,
      recordId: record.enrichmentId,
      fallbackRecordId: previousRecord?.output && ["ready", "stale"].includes(previousRecord.status) ? previousRecord.enrichmentId : null
    });
    this.queue.push({ job, cacheKey, recordId: record.enrichmentId, priority: job.priority });
    this.queue.sort((left, right) => right.priority - left.priority);
    this.queuedCacheKeys.add(cacheKey);
    this.metrics.queued += 1;
    this.updatedAt = timestamp;
    return true;
  }

  #drain() {
    if (this.stopped) return;
    while (this.active < this.maxConcurrency && this.queue.length) {
      const item = this.queue.shift();
      this.queuedCacheKeys.delete(item.cacheKey);
      this.active += 1;
      void this.#run(item).finally(() => {
        this.active -= 1;
        this.#drain();
      });
    }
  }

  async #run(item) {
    const current = this.store.get(item.recordId);
    if (!current) return;
    const startedAt = nowIso(this.now);
    this.store.upsert({ ...current, status: "running", updatedAt: startedAt });
    this.syncProjection({ broadcast: true });
    try {
      const result = await this.provider.generate({
        kind: item.job.kind,
        messages: item.job.messages,
        schema: getAiOutputSchema(item.job.kind),
        inputHash: item.job.inputHash,
        budget: this.budget
      });
      const validation = validateAiOutput(item.job.kind, result.output, item.job.validationContext);
      const timestamp = nowIso(this.now);
      if (!validation.valid) {
        this.store.upsert({
          ...this.store.get(item.recordId),
          status: "rejected",
          output: null,
          updatedAt: timestamp,
          generatedAt: timestamp,
          usage: result.usage ? structuredClone(result.usage) : null,
          requestId: result.requestId || null,
          providerResponse: result.responseMetadata ? structuredClone(result.responseMetadata) : null,
          validation
        });
        this.metrics.rejected += 1;
      } else {
        this.store.upsert({
          ...this.store.get(item.recordId),
          status: "ready",
          output: result.output,
          provider: result.provider,
          model: result.model,
          updatedAt: timestamp,
          generatedAt: timestamp,
          usage: result.usage ? structuredClone(result.usage) : null,
          requestId: result.requestId || null,
          providerResponse: result.responseMetadata ? structuredClone(result.responseMetadata) : null,
          validation
        });
        this.metrics.completed += 1;
      }
      this.lastError = null;
      this.updatedAt = timestamp;
    } catch (error) {
      const timestamp = nowIso(this.now);
      const code = String(error?.code || "AI_ENRICHMENT_FAILED").slice(0, 80);
      const failedRecord = this.store.get(item.recordId);
      const providerResponse = sanitizeSensitiveData(structuredClone(error?.responseMetadata || {
        requestedModel: failedRecord?.model || null,
        payloadModel: null,
        finishReason: null,
        requestId: null,
        usage: null,
        contentType: "unavailable",
        contentLength: 0,
        hasReasoningContent: false
      }));
      this.store.upsert({
        ...failedRecord,
        status: "failed",
        output: null,
        updatedAt: timestamp,
        usage: providerResponse?.usage ? structuredClone(providerResponse.usage) : null,
        requestId: providerResponse?.requestId || null,
        providerResponse,
        validation: { schemaValid: false, groundingValid: false, codes: [code] }
      });
      this.lastError = { code, message: sanitizeSensitiveData(String(error?.message || "AI enrichment failed.")), at: timestamp };
      this.metrics.failed += 1;
      log.warn("ai_enrichment_failed", { kind: item.job.kind, code });
    } finally {
      this.syncProjection({ broadcast: true });
    }
  }

  getPublicProjection() {
    const projection = {
      schemaVersion: "ai-projection-v1",
      mode: this.mode,
      provider: this.config.provider || this.provider?.name || "none",
      enabled: this.isEnabled(),
      updatedAt: this.updatedAt,
      articleSummaries: {},
      countryInsights: {},
      marketExplanations: {},
      status: {
        queueDepth: this.queue.length,
        active: this.active,
        features: [...this.features],
        counts: structuredClone(this.metrics)
      }
    };
    if (this.mode !== "visible") return projection;

    for (const [subjectKey, reference] of this.subjectRefs) {
      const current = this.store.get(reference.recordId);
      if (!current) continue;
      const fallback = reference.fallbackRecordId ? this.store.get(reference.fallbackRecordId) : null;
      const record = fallback?.output && !["ready", "stale"].includes(current.status) ? fallback : current;
      const entry = publicEntry(record, fallback === record ? { status: "stale", refreshStatus: current.status } : {});
      if (subjectKey.startsWith("article:")) {
        for (const legacyId of reference.legacyArticleIds || []) projection.articleSummaries[legacyId] = entry;
      } else if (subjectKey.startsWith("country:")) {
        projection.countryInsights[reference.countryId] = entry;
      } else if (subjectKey.startsWith("market:")) {
        projection.marketExplanations[reference.instrumentId] = { ...entry, ticker: reference.ticker || null };
      }
    }
    return projection;
  }

  getAdminSnapshot() {
    return {
      enabled: this.isEnabled(),
      configuredProvider: this.config.provider || "none",
      activeProvider: this.provider?.name || "none",
      mode: this.mode,
      structuredOutputMode: this.provider?.structuredOutputMode || null,
      features: [...this.features],
      models: {
        summary: this.provider?.modelForKind?.("article_summary") || null,
        reasoning: this.provider?.modelForKind?.("country_insight") || null
      },
      queue: { depth: this.queue.length, active: this.active, maxSize: this.maxQueueSize, concurrency: this.maxConcurrency },
      metrics: structuredClone(this.metrics),
      budget: this.budget?.snapshot?.() || null,
      store: this.store?.summary?.() || null,
      transport: this.provider?.getMetrics?.() || {},
      eligibility: structuredClone(this.lastEligibility),
      lastError: this.lastError,
      updatedAt: this.updatedAt
    };
  }

  listAdminEnrichments(filters = {}) {
    return this.store.list(filters);
  }

  async stop({ timeoutMs = 5_000 } = {}) {
    this.stopped = true;
    const deadline = this.now() + timeoutMs;
    while (this.active > 0 && this.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
