import { createHash } from "node:crypto";
import { createLogger } from "../../utils/logger.js";
import { detectCountryMentions } from "../../utils/countryCatalog.js";
import { normalizeArticles } from "../normalizeService.js";
import { providerRuntime } from "../providers/providerRuntime.js";
import { AWARENESS_SOURCES } from "./awarenessCatalog.js";
import { createAwarenessEvent, parseAwarenessSource } from "./awarenessParsers.js";
import { normalizeAwarenessAdmissionState } from "./awarenessStore.js";

const log = createLogger("backend/services/awareness/awarenessService");
const MAX_RESPONSE_BYTES = 1_000_000;
const SCHEDULER_TICK_MS = 60_000;
const ADAPTIVE_BEFORE_MS = 5 * 60_000;
const ADAPTIVE_AFTER_MS = 30 * 60_000;
const DEFAULT_USER_AGENT = "OGID-awareness/1.0 (+https://localhost; contact: local-operator)";
const DEFAULT_PERSISTENT_403_THRESHOLD = 3;
const DEFAULT_FORBIDDEN_COOLDOWN_MS = 60 * 60_000;
const MAX_FORBIDDEN_COOLDOWN_MS = 24 * 60 * 60_000;
const DIAGNOSTIC_HEADER_NAMES = [
  "content-type",
  "retry-after",
  "server",
  "via",
  "request-id",
  "x-request-id",
  "x-correlation-id",
  "cf-ray",
  "x-akamai-request-id",
  "akamai-grn",
  "x-amz-request-id",
  "x-amzn-requestid",
  "x-amz-cf-id",
  "x-cache",
  "x-cache-status"
];

class Semaphore {
  constructor(limit = 1) { this.limit = Math.max(1, limit); this.active = 0; this.waiters = []; }
  async use(callback) {
    if (this.active >= this.limit) await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try { return await callback(); } finally { this.active -= 1; this.waiters.shift()?.(); }
  }
}

function normalizeMode(value = "off") {
  const mode = String(value || "off").trim().toLowerCase();
  return ["off", "shadow", "visible"].includes(mode) ? mode : "off";
}

function normalizeUserAgent(value = DEFAULT_USER_AGENT) {
  const normalized = String(value || "").replace(/[\r\n\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 256);
  return normalized || DEFAULT_USER_AGENT;
}

function resolveSourceRequestUrl(source, nowMs = Date.now()) {
  if (source.urlStrategy !== "fed-month") return source.url;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: source.timezone || "America/New_York",
    year: "numeric",
    month: "numeric"
  }).formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
  const monthDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1 + Number(source.monthOffset || 0), 1));
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(monthDate).toLowerCase();
  return `https://www.federalreserve.gov/newsevents/${monthDate.getUTCFullYear()}-${month}.htm`;
}

function jitteredInterval(intervalMs, random = Math.random) {
  const bounded = Math.max(1_000, Number(intervalMs || 0));
  const jitter = 0.9 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.2;
  return Math.round(bounded * jitter);
}

function allowedContentType(source, value = "") {
  const type = String(value || "").toLowerCase().split(";")[0].trim();
  if (!type) return false;
  if (source.adapter === "ics") return ["text/calendar", "text/plain", "application/octet-stream"].includes(type);
  if (source.adapter === "rss") return type.includes("xml") || ["application/rss+xml", "application/atom+xml", "text/plain"].includes(type);
  if (source.adapter.endsWith("json")) return type.includes("json");
  return type.includes("html") || type === "text/plain";
}

async function readLimitedBytes(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw new Error("awareness-response-too-large");
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("awareness-response-too-large");
    return new TextEncoder().encode(value);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("awareness-response-too-large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

async function readLimitedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  return new TextDecoder().decode(await readLimitedBytes(response, maxBytes));
}

function cleanDiagnosticHeader(value) {
  return String(value || "").replace(/[\r\n\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 256);
}

function responseDiagnostic(response, bodyBytes = null, { truncated = false } = {}) {
  const headers = {};
  for (const name of DIAGNOSTIC_HEADER_NAMES) {
    const value = cleanDiagnosticHeader(response.headers?.get?.(name));
    if (value) headers[name] = value;
  }
  const requestId = headers["request-id"] || headers["x-request-id"] || headers["x-correlation-id"] ||
    headers["cf-ray"] || headers["x-akamai-request-id"] || headers["akamai-grn"] ||
    headers["x-amz-request-id"] || headers["x-amzn-requestid"] || headers["x-amz-cf-id"] || null;
  const bytes = bodyBytes instanceof Uint8Array ? bodyBytes : null;
  return {
    headers,
    contentType: headers["content-type"] || null,
    requestId,
    bodySha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
    bodyBytes: bytes ? bytes.byteLength : null,
    truncated: Boolean(truncated)
  };
}

function retryAfterMs(value, nowMs = Date.now()) {
  const normalized = String(value || "").trim();
  if (!normalized) return 0;
  if (/^\d+$/.test(normalized)) {
    const duration = Number(normalized) * 1_000;
    return Number.isFinite(duration) ? Math.min(MAX_FORBIDDEN_COOLDOWN_MS, duration) : MAX_FORBIDDEN_COOLDOWN_MS;
  }
  const at = Date.parse(normalized);
  return Number.isFinite(at) ? Math.min(MAX_FORBIDDEN_COOLDOWN_MS, Math.max(0, at - nowMs)) : 0;
}

function eventKindForArticle(article = {}) {
  const categories = article.financial?.domains || article.financialClassification?.categories || article.financialCategories || [];
  if (categories.includes("regulatory")) return "regulatory_filing";
  if (categories.includes("macro")) return "macro_release";
  return "market_moving_news";
}

function importanceForArticle(article = {}, fallback = "low") {
  const band = article.financial?.importance?.band || article.financialClassification?.importance || article.financialImportance;
  if (["critical", "high"].includes(band)) return "high";
  if (band === "medium") return "medium";
  if (band === "low") return "low";
  return fallback;
}

function financialEventFromArticle(article = {}, observedAt = new Date().toISOString()) {
  const sourceRole = article.sourceRole || article.role || "editorial";
  const hybridDomains = Number(article.conflict?.totalWeight || 0) > 0 ? ["geopolitical"] : [];
  const source = {
    sourceId: article.sourceId || `news-${String(article.provider || "unknown").toLowerCase()}`,
    name: article.sourceName || article.publisher || article.provider || "News provider",
    url: article.url,
    adapter: "financial-news-branch",
    kind: eventKindForArticle(article),
    domains: [...new Set(["financial", ...hybridDomains, ...(article.domains || []), ...(article.financial?.domains || [])])],
    role: sourceRole,
    official: sourceRole === "official",
    timezone: "UTC"
  };
  const event = createAwarenessEvent({
    source,
    rawId: article.url || article.id,
    title: article.title,
    summary: article.excerpt || article.description,
    canonicalUrl: article.url,
    publishedAt: article.publishedAt,
    observedAt,
    countries: article.countryMentions || detectCountryMentions(`${article.title || ""} ${article.description || ""}`)
  });
  if (!event) return null;
  return {
    ...event,
    domains: [...new Set(["financial", ...hybridDomains, ...(article.domains || []), ...(article.financial?.domains || []), ...(event.domains || [])])],
    instrumentIds: [...new Set(article.instrumentIds || [])],
    sectors: [...new Set(article.sectors || [])],
    importance: importanceForArticle(article, event.importance),
    claimStatus: source.official ? "source_asserted" : "reported",
    provenance: {
      ...event.provenance,
      sourceArticleId: article.id || null,
      provider: article.provider || null,
      methodVersion: "market-awareness-v1"
    }
  };
}

export class AwarenessService {
  constructor({
    mode = "off",
    store,
    stateManager = null,
    socketServer = null,
    sources = AWARENESS_SOURCES,
    fetchImpl = null,
    now = Date.now,
    random = Math.random,
    timeoutMs = 9_000,
    userAgent = DEFAULT_USER_AGENT,
    globalConcurrency = 2,
    hostConcurrency = 1,
    persistent403Threshold = DEFAULT_PERSISTENT_403_THRESHOLD,
    forbiddenCooldownMs = DEFAULT_FORBIDDEN_COOLDOWN_MS
  } = {}) {
    this.mode = normalizeMode(mode);
    this.store = store;
    this.stateManager = stateManager;
    this.socketServer = socketServer;
    this.sources = sources;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
    this.timeoutMs = timeoutMs;
    this.userAgent = normalizeUserAgent(userAgent);
    this.persistent403Threshold = Math.max(1, Math.round(Number(persistent403Threshold) || DEFAULT_PERSISTENT_403_THRESHOLD));
    this.forbiddenCooldownMs = Math.max(60_000, Number(forbiddenCooldownMs) || DEFAULT_FORBIDDEN_COOLDOWN_MS);
    this.globalSemaphore = new Semaphore(globalConcurrency);
    this.hostConcurrency = hostConcurrency;
    this.hostSemaphores = new Map();
    this.timer = null;
    this.inFlight = null;
    this.stopped = true;
    this.store?.registerSources?.(sources);
    this.migratePersistentForbiddenBlocks();
    this.syncProjection();
  }

  migratePersistentForbiddenBlocks() {
    const statuses = this.store?.getSnapshot?.({ mode: this.mode, publicView: false })?.sourceStatus || [];
    for (const status of statuses) {
      if (Number(status.httpStatus) !== 403 || Number(status.consecutiveErrors || 0) < this.persistent403Threshold) continue;
      this.store.updateSourceStatus(status.sourceId, {
        admissionState: "blocked",
        enabled: false,
        runtimeBlocked: true,
        blockedReason: "persistent-http-403",
        disabledReason: "persistent-http-403",
        blockedAt: status.blockedAt || status.lastAttemptAt || new Date(this.now()).toISOString(),
        status: "blocked",
        consecutiveForbidden: Math.max(Number(status.consecutiveForbidden || 0), Number(status.consecutiveErrors || 0)),
        nextEligibleAt: null
      });
    }
  }

  hostSemaphore(hostname) {
    if (!this.hostSemaphores.has(hostname)) this.hostSemaphores.set(hostname, new Semaphore(this.hostConcurrency));
    return this.hostSemaphores.get(hostname);
  }

  getSnapshot(filters = {}, { publicView = true } = {}) {
    return this.store.getSnapshot({ mode: this.mode, filters, publicView });
  }

  getAdminSnapshot() {
    return this.getSnapshot({}, { publicView: false });
  }

  getMarketArticles() {
    if (this.mode !== "visible") return [];
    const snapshot = this.getSnapshot({}, { publicView: true });
    return snapshot.recent
      .filter((event) => (["released", "updated"].includes(event.status) || (event.kind === "maritime_alert" && event.status === "live")) && (event.domains || []).includes("financial") && event.publishedAt)
      .map((event) => ({
        id: event.eventId,
        provider: "awareness",
        sourceId: event.source?.sourceId || null,
        sourceName: event.source?.name || "Official awareness source",
        sourceRole: event.source?.role || "official",
        role: event.source?.role || "official",
        publisher: event.source?.name || null,
        title: event.title,
        description: event.summary,
        content: event.summary,
        excerpt: event.summary,
        url: event.canonicalUrl,
        publishedAt: event.publishedAt,
        receivedAt: event.observedAt,
        countryMentions: event.countries || [],
        instrumentIds: event.instrumentIds || [],
        domains: event.domains || ["financial"],
        financial: {
          isFinancial: true,
          domains: (event.domains || []).filter((domain) => ["macro", "market", "corporate", "regulatory"].includes(domain)),
          primaryDomain: (event.domains || []).find((domain) => ["macro", "market", "corporate", "regulatory"].includes(domain)) || "market",
          importance: {
            score: event.importance === "high" ? 80 : event.importance === "medium" ? 55 : 30,
            band: event.importance,
            methodVersion: event.importanceMethod
          },
          methodVersion: "market-awareness-v1"
        },
        financialImportanceScore: event.importance === "high" ? 80 : event.importance === "medium" ? 55 : 30,
        sentiment: { label: "neutral", score: 0 },
        conflict: { totalWeight: 0, tags: [] },
        synthetic: false,
        dataMode: event.dataMode || "observed",
        provenance: event.provenance
      }));
  }

  getGeopoliticalArticles() {
    if (this.mode !== "visible") return [];
    const snapshot = this.getSnapshot({}, { publicView: true });
    return snapshot.recent
      .filter((event) => (["released", "updated"].includes(event.status) || (event.kind === "maritime_alert" && event.status === "live")) && event.publishedAt && (event.domains || []).some((domain) => ["geopolitical", "security"].includes(domain)))
      .map((event) => {
        const article = normalizeArticles([{
          provider: "awareness",
          source: {
            name: event.source?.name || "Official awareness source",
            sourceId: event.source?.sourceId || null,
            role: event.source?.role || "official",
            publisher: event.source?.name || null
          },
          sourceId: event.source?.sourceId || null,
          sourceRole: event.source?.role || "official",
          role: event.source?.role || "official",
          publisher: event.source?.name || null,
          title: event.title,
          description: event.summary,
          content: event.summary,
          url: event.canonicalUrl,
          publishedAt: event.publishedAt,
          instrumentIds: event.instrumentIds || [],
          provenance: {
            ...event.provenance,
            awarenessEventId: event.eventId,
            awarenessRevision: event.revision,
            claimStatus: event.claimStatus
          }
        }], "awareness")[0];
        return article ? {
          ...article,
          id: event.eventId,
          domains: [...new Set(["geopolitical", ...(event.domains || []), ...(article.domains || [])])]
        } : null;
      })
      .filter(Boolean);
  }

  syncProjection() {
    const snapshot = this.getSnapshot({}, { publicView: true });
    this.stateManager?.setAwareness?.(snapshot);
    return snapshot;
  }

  broadcast(changed = [], { backfill = false, trigger = null } = {}) {
    const snapshot = this.syncProjection();
    const admissions = new Map(this.getAdminSnapshot().sourceStatus.map((status) => [status.sourceId, status.admissionState]));
    const visibleChanged = changed.filter((event) => !admissions.has(event.source?.sourceId) || admissions.get(event.source?.sourceId) === "active");
    if (this.mode === "visible" && visibleChanged.length) {
      this.socketServer?.broadcast?.("awareness:update:v1", {
        ...snapshot,
        changed: visibleChanged,
        delivery: { backfill: Boolean(backfill), trigger }
      }, { awarenessRevision: snapshot.revision });
    }
    return snapshot;
  }

  adaptiveWindowActive() {
    const nowMs = this.now();
    const snapshot = this.getSnapshot({}, { publicView: false });
    return [...snapshot.upcoming, ...snapshot.recent].some((event) => event.importance === "high" && event.scheduledAt && ["scheduled", "live"].includes(event.status) && (() => {
      const delta = Date.parse(event.scheduledAt) - nowMs;
      return delta >= -ADAPTIVE_AFTER_MS && delta <= ADAPTIVE_BEFORE_MS;
    })());
  }

  effectiveInterval(source) {
    return source.adaptivePollIntervalMs && this.adaptiveWindowActive()
      ? source.adaptivePollIntervalMs
      : source.minPollIntervalMs;
  }

  eligibleSources() {
    const nowMs = this.now();
    const statuses = new Map(this.getAdminSnapshot().sourceStatus.map((status) => [status.sourceId, status]));
    return this.sources.filter((source) => {
      const admissionState = statuses.get(source.sourceId)?.admissionState || normalizeAwarenessAdmissionState(source);
      return admissionState === "active" || admissionState === "shadow";
    }).filter((source) => {
      const next = Date.parse(statuses.get(source.sourceId)?.nextEligibleAt || 0);
      return !Number.isFinite(next) || next <= nowMs;
    }).sort((left, right) => right.priority - left.priority || left.sourceId.localeCompare(right.sourceId));
  }

  async request(source, url, headers, redirectCount = 0) {
    const parsed = new URL(url);
    const sourceHosts = new Set([
      source.hostname,
      new URL(source.url).hostname,
      ...(Array.isArray(source.redirectHosts) ? source.redirectHosts : [])
    ].filter(Boolean).map((hostname) => String(hostname).toLowerCase()));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !sourceHosts.has(parsed.hostname.toLowerCase())) throw new Error("awareness-url-not-allowed");
    const options = {
      method: "GET",
      headers,
      redirect: "manual",
      retries: 0,
      timeoutMs: this.timeoutMs,
      providerConcurrency: 2,
      hostConcurrency: 1,
      throwHttpErrors: false
    };
    let response;
    if (this.fetchImpl) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try { response = await this.fetchImpl(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timeout); }
    } else {
      response = await providerRuntime.fetch(`awareness:${source.sourceId}`, url, options);
    }
    if (response.status >= 300 && response.status < 400 && response.headers?.get?.("location")) {
      if (redirectCount >= 2) throw new Error("awareness-redirect-limit");
      const redirected = new URL(response.headers.get("location"), url);
      if (redirected.protocol !== "https:" || redirected.username || redirected.password || !sourceHosts.has(redirected.hostname.toLowerCase())) {
        await response.body?.cancel?.().catch?.(() => {});
        throw new Error("awareness-redirect-not-allowed");
      }
      await response.body?.cancel?.().catch?.(() => {});
      return this.request(source, redirected.toString(), headers, redirectCount + 1);
    }
    return response;
  }

  async pollSource(source) {
    const startedAt = this.now();
    const previous = this.getAdminSnapshot().sourceStatus.find((status) => status.sourceId === source.sourceId) || {};
    const admissionState = previous.admissionState || normalizeAwarenessAdmissionState(source);
    if (admissionState === "blocked" || previous.runtimeBlocked === true) {
      return { sourceId: source.sourceId, changed: [], status: "blocked", error: previous.blockedReason || "awareness-source-blocked" };
    }
    if (!["active", "shadow"].includes(admissionState)) {
      return { sourceId: source.sourceId, changed: [], status: admissionState, error: "awareness-source-not-scheduled" };
    }
    const nextEligibleAt = new Date(startedAt + jitteredInterval(this.effectiveInterval(source), this.random)).toISOString();
    this.store.updateSourceStatus(source.sourceId, {
      lastAttemptAt: new Date(startedAt).toISOString(),
      nextEligibleAt,
      status: "polling",
      error: null,
      attempts: Number(previous.attempts || 0) + 1
    });
    const headers = {
      Accept: source.adapter === "ics" ? "text/calendar,text/plain;q=0.9,*/*;q=0.1" : source.adapter === "rss" ? "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.1" : source.adapter.endsWith("json") ? "application/json" : "text/html,application/xhtml+xml;q=0.9",
      "User-Agent": this.userAgent
    };
    if (previous.etag) headers["If-None-Match"] = previous.etag;
    if (previous.lastModified) headers["If-Modified-Since"] = previous.lastModified;
    let diagnostic = null;
    try {
      const response = await this.request(source, resolveSourceRequestUrl(source, startedAt), headers);
      const latencyMs = Math.max(0, this.now() - startedAt);
      diagnostic = responseDiagnostic(response);
      if (response.status === 304) {
        const fresh = this.store.setSourceStale(source.sourceId, false);
        this.store.recordPoll(source.sourceId, {
          attemptedAt: new Date(startedAt).toISOString(),
          completedAt: new Date(this.now()).toISOString(),
          outcome: "not-modified",
          httpStatus: 304,
          latencyMs,
          nextEligibleAt,
          diagnostic
        }, {
          status: "healthy",
          lastSuccessAt: new Date(this.now()).toISOString(),
          httpStatus: 304,
          latencyMs,
          stale: false,
          error: null,
          consecutiveErrors: 0,
          consecutiveForbidden: 0,
          successes: Number(previous.successes || 0) + 1,
          nextEligibleAt
        });
        return { sourceId: source.sourceId, changed: fresh.changed || [], status: "not-modified" };
      }
      if (!response.ok) {
        try {
          const bodyBytes = await readLimitedBytes(response);
          diagnostic = responseDiagnostic(response, bodyBytes);
        } catch (diagnosticError) {
          diagnostic = responseDiagnostic(response, null, { truncated: diagnosticError?.message === "awareness-response-too-large" });
        }
        throw Object.assign(new Error(`awareness-upstream-${response.status}`), {
          httpStatus: response.status,
          diagnostic,
          retryAfterMs: retryAfterMs(diagnostic.headers?.["retry-after"], this.now())
        });
      }
      if (!allowedContentType(source, response.headers?.get?.("content-type"))) throw new Error("awareness-content-type-invalid");
      const body = await readLimitedText(response);
      const observedAt = new Date(this.now()).toISOString();
      const events = parseAwarenessSource(body, source, { observedAt });
      const emptyResultAllowed = source.emptyResultPolicy === "healthy";
      if (!events.length && Number(previous.eventCount || 0) > 0 && !emptyResultAllowed) {
        throw new Error("awareness-parser-empty-after-data");
      }
      const reconciliation = this.store.reconcile(events, { sourceId: source.sourceId });
      const latestPublishedMs = events.reduce((latest, event) => Math.max(latest, Date.parse(event.publishedAt || 0) || 0), 0);
      const outcome = events.length ? "ok" : emptyResultAllowed ? "empty-valid" : "empty";
      this.store.recordPoll(source.sourceId, {
        attemptedAt: new Date(startedAt).toISOString(),
        completedAt: observedAt,
        outcome,
        httpStatus: response.status,
        latencyMs,
        parsed: events.length,
        deduplicated: reconciliation.deduplicated,
        rejected: reconciliation.rejected,
        nextEligibleAt,
        diagnostic
      }, {
        status: events.length || emptyResultAllowed ? "healthy" : "degraded",
        lastSuccessAt: observedAt,
        httpStatus: response.status,
        latencyMs,
        etag: response.headers?.get?.("etag") || previous.etag || null,
        lastModified: response.headers?.get?.("last-modified") || previous.lastModified || null,
        latestEventAt: latestPublishedMs ? new Date(latestPublishedMs).toISOString() : previous.latestEventAt || null,
        lagMs: latestPublishedMs ? Math.max(0, this.now() - latestPublishedMs) : previous.lagMs ?? null,
        stale: false,
        error: events.length || emptyResultAllowed ? null : "no-events-parsed",
        consecutiveErrors: 0,
        consecutiveForbidden: 0,
        successes: events.length || emptyResultAllowed ? Number(previous.successes || 0) + 1 : Number(previous.successes || 0),
        nextEligibleAt
      });
      return { sourceId: source.sourceId, ...reconciliation, status: outcome };
    } catch (error) {
      const failures = Number(previous.consecutiveErrors || 0) + 1;
      const forbiddenFailures = Number(error.httpStatus) === 403 ? Number(previous.consecutiveForbidden || 0) + 1 : 0;
      const blocked = Number(error.httpStatus) === 403 && forbiddenFailures >= this.persistent403Threshold;
      const standardCooldownMs = Math.min(6 * 60 * 60_000, this.effectiveInterval(source) * (2 ** Math.max(0, failures - 1)));
      const forbiddenCooldownMs = Number(error.httpStatus) === 403
        ? Math.min(MAX_FORBIDDEN_COOLDOWN_MS, this.forbiddenCooldownMs * (2 ** Math.max(0, forbiddenFailures - 1)))
        : 0;
      const cooldownMs = Math.max(standardCooldownMs, forbiddenCooldownMs, Number(error.retryAfterMs || 0));
      const completedAt = new Date(this.now()).toISOString();
      const failureNextEligibleAt = blocked ? null : new Date(this.now() + cooldownMs).toISOString();
      this.store.recordPoll(source.sourceId, {
        attemptedAt: new Date(startedAt).toISOString(),
        completedAt,
        outcome: "error",
        httpStatus: error.httpStatus || null,
        latencyMs: Math.max(0, this.now() - startedAt),
        error: String(error.message || "awareness-source-failed").slice(0, 160),
        nextEligibleAt: failureNextEligibleAt,
        diagnostic: error.diagnostic || diagnostic
      }, {
        status: blocked ? "blocked" : failures >= 3 ? "unhealthy" : "degraded",
        admissionState: blocked ? "blocked" : previous.admissionState || normalizeAwarenessAdmissionState(source),
        enabled: blocked ? false : previous.enabled !== false,
        runtimeBlocked: blocked || previous.runtimeBlocked === true,
        blockedReason: blocked ? "persistent-http-403" : previous.blockedReason || null,
        disabledReason: blocked ? "persistent-http-403" : previous.disabledReason || null,
        blockedAt: blocked ? completedAt : previous.blockedAt || null,
        httpStatus: error.httpStatus || null,
        latencyMs: Math.max(0, this.now() - startedAt),
        stale: true,
        error: String(error.message || "awareness-source-failed").slice(0, 160),
        consecutiveErrors: failures,
        consecutiveForbidden: forbiddenFailures,
        nextEligibleAt: failureNextEligibleAt
      });
      log.warn("awareness_source_failed", {
        sourceId: source.sourceId,
        message: error.message,
        httpStatus: error.httpStatus || null,
        requestId: (error.diagnostic || diagnostic)?.requestId || null,
        blocked
      });
      const stale = this.store.setSourceStale(source.sourceId, true);
      return { sourceId: source.sourceId, changed: stale.changed || [], status: blocked ? "blocked" : "error", error: error.message };
    }
  }

  async runCycle(trigger = "scheduled-awareness") {
    if (this.mode === "off") return { status: "disabled", trigger, snapshot: this.syncProjection() };
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const sources = this.eligibleSources();
      const results = await Promise.all(sources.map((source) => this.globalSemaphore.use(() =>
        this.hostSemaphore(source.hostname).use(() => this.pollSource(source)))));
      const changed = results.flatMap((result) => result.changed || []);
      const snapshot = this.broadcast(changed, { backfill: trigger === "startup-awareness", trigger });
      log.info("awareness_cycle_completed", { trigger, sourceCount: sources.length, changedCount: changed.length, revision: snapshot.revision, mode: this.mode });
      return { status: results.some((result) => ["error", "blocked"].includes(result.status)) ? "partial" : "ok", trigger, results, snapshot };
    })();
    try { return await this.inFlight; } finally { this.inFlight = null; }
  }

  ingestFinancialArticles(articles = [], { backfill = false, trigger = "financial-news-ingest" } = {}) {
    if (this.mode === "off") return { changed: [], revision: this.getAdminSnapshot().revision };
    const observedAt = new Date(this.now()).toISOString();
    const events = articles.map((article) => financialEventFromArticle(article, observedAt)).filter(Boolean);
    const result = this.store.reconcile(events);
    this.broadcast(result.changed, { backfill, trigger });
    return result;
  }

  schedule() {
    if (this.stopped || this.mode === "off") return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try { await this.runCycle("interval-awareness"); } finally { this.schedule(); }
    }, SCHEDULER_TICK_MS);
    this.timer.unref?.();
  }

  async start() {
    this.stopped = false;
    if (this.mode === "off") return this.syncProjection();
    const result = await this.runCycle("startup-awareness");
    this.schedule();
    return result.snapshot;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export {
  DEFAULT_USER_AGENT as AWARENESS_DEFAULT_USER_AGENT,
  financialEventFromArticle,
  jitteredInterval,
  normalizeMode as normalizeAwarenessMode,
  normalizeUserAgent as normalizeAwarenessUserAgent,
  resolveSourceRequestUrl
};
