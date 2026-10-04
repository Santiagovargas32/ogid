import { buildCanonicalArticleLayer } from "../ai/canonicalArticleService.js";
import { buildCountryInsightJob } from "../ai/aiInputBuilder.js";
import { buildScenarioMessages } from "../ai/aiScenarioSchemas.js";
import { buildEvidencePacket } from "./evidencePacketBuilder.js";
import { contentHash } from "./intelligenceStore.js";

const DAY = 86400000;
const cacheIdentity = (value) => {
  if (Array.isArray(value)) return value.map(cacheIdentity);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["asOf", "generatedAt", "calculatedAt", "packetHash", "revisions", "latestNewsAgeMin", "latestCandleAgeMin", "lastCandleAgeMin"].includes(key))
    .map(([key, item]) => [key, cacheIdentity(item)]));
};

// Plan sections 4, 7, 9, 10. Builds jobs; AiEnrichmentCoordinator remains the only
// owner of model execution, budgets, queue and publication.
export class ProspectiveIntelligenceService {
  constructor({ config, store, memory, forecastService, stateManager, marketConditionsService,
    marketWatchlistService, awarenessStore, signalCorrelator, now = Date.now } = {}) {
    Object.assign(this, { config, store, memory, forecastService, stateManager, marketConditionsService,
      marketWatchlistService, awarenessStore, signalCorrelator, now });
    this.busy = false;
    this.stopped = false;
    this.lastError = null;
    this.lastRunAt = null;
    this.lastDaily = null;
    this.eligibility = {};
    this.selectedIds = new Set();
  }
  enabled() { return this.config.features.includes("intelligence") && this.config.mode !== "off" && this.config.provider !== "none"; }
  activeInstruments() { return this.marketWatchlistService?.selectedInstruments?.() || []; }
  start(enqueue) {
    if (!this.enabled() || this.timer || this.stopped) return;
    this.enqueue = enqueue;
    this.timer = setInterval(() => { void this.tick(); }, this.config.analysisIntervalMs);
    this.timer.unref?.();
    this.wake();
  }
  wake() {
    if (!this.enabled() || !this.enqueue || this.stopped || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; void this.tick(); }, 2000);
    this.wakeTimer.unref?.();
  }
  tick() {
    if (this.busy || this.stopped || !this.enabled()) return this.runPromise || Promise.resolve();
    this.busy = true;
    this.runPromise = this.runCycle();
    return this.runPromise;
  }
  async runCycle() {
    try {
      await this.store.ready;
      if (!this.store.status.healthy) throw new Error("Evidence archive unavailable.");
      await this.memory.captureAwareness(this.awarenessStore);
      await this.forecastService.resolve();
      const jobs = this.buildJobs();
      let count = 0;
      for (const job of jobs) {
        if (count >= this.config.maxJobsPerCycle) break;
        if (this.stopped) break;
        const key = `${job.kind}:${job.subjectId}`;
        const last = this.store.get("checkpoint", key);
        const elapsed = this.now() - Date.parse(last?.attemptAt || 0);
        if (elapsed < this.config.analysisIntervalMs || (last?.inputHash === job.cacheInputHash && elapsed < 6 * 3600000)) continue;
        if (this.enqueue(job)) {
          await this.store.put("checkpoint", key, { attemptAt: new Date(this.now()).toISOString(), inputHash: job.cacheInputHash });
          count += 1;
        }
      }
      const day = new Date(this.now()).toISOString().slice(0, 10);
      if (day !== this.lastDaily) {
        await this.store.consolidateDay(new Date(this.now() - DAY).toISOString().slice(0, 10));
        this.lastDaily = day;
      }
      this.lastRunAt = new Date(this.now()).toISOString();
      this.lastError = null;
    } catch (error) { this.lastError = error.code || "INTELLIGENCE_CYCLE_FAILED"; }
    finally { this.busy = false; this.onUpdate?.(); }
  }
  buildJobs() {
    const asOf = new Date(this.now()).toISOString();
    const state = this.stateManager.getSnapshot();
    const instruments = this.activeInstruments();
    this.selectedIds = new Set(instruments.map((item) => item.instrumentId));
    const conditions = this.marketConditionsService.getSnapshot({ windowMin: 1440, countries: [] });
    const anomalies = this.signalCorrelator?.getAnomalies?.({ activeWindowHours: 2, baselineDays: 7 }) || null;
    const jobs = [];
    this.eligibility = {};
    for (const instrument of instruments) {
      const baseline = this.forecastService.baseline(instrument, asOf);
      const symbol = conditions.symbols.find((row) => row.instrumentId === instrument.instrumentId) || null;
      const packet = buildEvidencePacket({ store: this.store, instrument, asOf, baseline,
        conditions: { methodVersion: conditions.methodVersion, window: conditions.window, market: conditions.market, symbol },
        countryContext: state.countries, anomalies, maxChars: this.config.packetMaxChars });
      if (!packet.evidence.length && baseline.status !== "available") {
        this.eligibility[instrument.instrumentId] = { status: "insufficient_evidence", limitations: baseline.limitations };
        continue;
      }
      this.eligibility[instrument.instrumentId] = { status: "eligible", baselineStatus: baseline.status, evidenceCount: packet.evidence.length };
      jobs.push(this.scenarioJob("market_scenarios", instrument.instrumentId, packet, { ticker: instrument.canonicalSymbol, instrumentId: instrument.instrumentId }));
    }
    const events = this.store.evidenceAt(asOf).filter((row) => row.kind === "awareness" && row.official
      && row.admissionState === "active" && !row.stale && row.scheduledAt && row.status === "scheduled"
      && Date.parse(row.scheduledAt) > this.now() && Date.parse(row.scheduledAt) <= this.now() + 7 * DAY)
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
    const eventKeys = new Set();
    for (const event of events) {
      if (eventKeys.has(event.eventKey)) continue;
      eventKeys.add(event.eventKey);
      if (eventKeys.size > 4) break;
      const packet = buildEvidencePacket({ store: this.store, event, asOf, maxChars: this.config.packetMaxChars });
      if (packet.evidence.length) jobs.push(this.scenarioJob("event_scenarios", event.documentId, packet, { eventId: event.documentId }));
    }
    const articles = this.memory.canonicalArticles({ asOf, sinceHours: 72 });
    const canonical = buildCanonicalArticleLayer({ signalCorpus: articles, rawArticles: articles, instruments, marketQuotes: state.market?.quotes || {} });
    for (const countryId of this.config.countries || []) {
      const job = buildCountryInsightJob(countryId, state.countries[countryId], canonical.articles, { maxInputChars: Math.min(this.config.packetMaxChars, 24000) });
      if (!job.eligible) continue;
      // Keep the existing country schema/UI; narrative scenarios are qualitative.
      job.intelligence = true;
      job.cacheInputHash = contentHash(cacheIdentity(job.input));
      job.subjectRef = { subjectKey: `country:${countryId}`, countryId, articleIds: job.validationContext.allowedArticleIds };
      job.archivePacket = { ...job.input, asOf, evidence: canonical.articles.filter((row) => job.validationContext.allowedArticleIds.includes(row.canonicalArticleId)) };
      jobs.push(job);
    }
    return jobs.sort((a, b) => {
      const last = (job) => Date.parse(this.store.get("checkpoint", `${job.kind}:${job.subjectId}`)?.attemptAt || 0) || 0;
      return last(a) - last(b) || a.kind.localeCompare(b.kind) || a.subjectId.localeCompare(b.subjectId);
    });
  }
  scenarioJob(kind, subjectId, packet, reference) {
    return { kind, subjectId, input: packet, messages: buildScenarioMessages(kind, packet),
      inputHash: contentHash(packet), cacheInputHash: contentHash(cacheIdentity(packet)), archivePacket: packet,
      promptVersion: "ogid-prospective-v1", schemaVersion: `${kind}-v1`, intelligence: true, priority: 200,
      validationContext: { subjectId, allowedEvidenceIds: packet.evidence.map((row) => row.evidenceId), hasBaseline: packet.baseline?.status === "available" },
      subjectRef: { subjectKey: `${kind}:${subjectId}`, ...reference } };
  }
  isCurrent(job) {
    if (this.stopped) return false;
    if (job.kind === "market_scenarios" && !this.activeInstruments().some((item) => item.instrumentId === job.subjectId)) return false;
    const expires = job.input.baseline?.target?.referenceAt || job.input.subject?.scheduledAt;
    return !expires || Date.parse(expires) > this.now();
  }
  async prepare(job) {
    if (!this.isCurrent(job)) throw Object.assign(new Error("The analysis target is no longer current."), { code: "ANALYSIS_SUPERSEDED" });
    return this.store.savePacket({ input: job.archivePacket || job.input, messages: job.messages,
      promptVersion: job.promptVersion, schemaVersion: job.schemaVersion });
  }
  async accept(job, result, packetHash) {
    if (!this.isCurrent(job)) throw Object.assign(new Error("The analysis target expired during inference."), { code: "ANALYSIS_SUPERSEDED" });
    const generatedAt = new Date(this.now()).toISOString();
    const forecastId = job.kind === "market_scenarios" ? await this.forecastService.issue({ job, result, packetHash }) : null;
    const analysisId = `analysis_${contentHash([job.kind, job.subjectId, job.inputHash, result.output, generatedAt]).slice(0, 32)}`;
    const evidence = job.archivePacket?.evidence || [];
    await this.store.put("analysis", analysisId, { analysisId, kind: job.kind, subjectId: job.subjectId,
      ticker: job.subjectRef.ticker || null, generatedAt, evidenceCutoffAt: job.input.asOf || job.archivePacket?.asOf,
      expiresAt: job.input.baseline?.target?.referenceAt || job.input.subject?.scheduledAt || new Date(this.now() + 6 * 3600000).toISOString(),
      output: result.output, model: result.model, provider: result.provider, packetHash, forecastId,
      baseline: job.input.baseline || null, subject: job.input.subject, coverage: job.input.coverage || null,
      provenance: evidence.map((row) => ({ evidenceId: row.evidenceId || row.canonicalArticleId, title: row.title,
        sourceName: row.sourceName, publisher: row.publisher, canonicalUrl: row.canonicalUrl, availableAt: row.availableAt || null })),
      generation: result.responseMetadata || null }, { immutable: true });
  }
  projection() {
    if (!this.enabled() || this.config.mode !== "visible") return {};
    const selected = new Set(this.activeInstruments().map((item) => item.instrumentId));
    const history = this.store.list("analysis").filter((row) => row.kind !== "market_scenarios" || selected.has(row.subjectId))
      .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
    const marketScenarios = {};
    const eventScenarios = [];
    for (const row of history) {
      const entry = { ...row, status: Date.parse(row.expiresAt) <= this.now() ? "stale" : "ready",
        evaluation: row.kind === "market_scenarios" ? this.forecastService.evaluation(row.subjectId) : null };
      if (row.kind === "market_scenarios") {
        const items = marketScenarios[row.subjectId] || [];
        if (items.length < 3) items.push(entry);
        marketScenarios[row.subjectId] = items;
      } else if (row.kind === "event_scenarios" && eventScenarios.length < 6 && !eventScenarios.some((item) => item.subjectId === row.subjectId)) eventScenarios.push(entry);
    }
    return { marketScenarios, eventScenarios, evaluation: this.forecastService.evaluation(),
      intelligenceStatus: { lastRunAt: this.lastRunAt, lastError: this.lastError, eligibility: this.eligibility } };
  }
  diagnostics() { return { memory: this.store.summary(), intervalMs: this.config.analysisIntervalMs,
    lastRunAt: this.lastRunAt, lastError: this.lastError, busy: this.busy, evaluation: this.forecastService.evaluation() }; }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.wakeTimer);
    await this.runPromise;
    await this.store.flush();
  }
}
