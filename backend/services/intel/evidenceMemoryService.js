import { sanitizeSensitiveData } from "../../utils/sanitize.js";
import { canonicalizeArticleUrl } from "../ai/canonicalArticleService.js";
import { contentHash } from "./intelligenceStore.js";

const text = (value, limit = 8000) => String(sanitizeSensitiveData(String(value || "")))
  .replace(/<[^>]*>/g, " ").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, limit);
const iso = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const list = (value) => Array.isArray(value) ? [...new Set(value.map((item) => text(item, 160)).filter(Boolean))].sort() : [];

export function normalizeEvidence(item, { observedAt, admissionState = "active", previous = null, imported = false } = {}) {
  const kind = item.eventId ? "awareness" : "article";
  let url = canonicalizeArticleUrl(item.canonicalUrl || item.url);
  if (url) { const u = new URL(url); u.username = ""; u.password = ""; for (const key of [...u.searchParams.keys()]) if (/token|key|secret|auth/i.test(key)) u.searchParams.delete(key); url = u.toString(); }
  const sourceId = text(item.source?.sourceId || item.sourceId || item.provenance?.sourceId || item.provider, 160);
  const title = text(item.title, 1000);
  if (!title || item.synthetic || ["synthetic", "seeded", "fallback"].includes(item.dataMode)) return null;
  const documentId = `doc_${contentHash(kind === "awareness" ? item.eventId : url || `${sourceId}|${title}|${item.publishedAt}`).slice(0, 24)}`;
  const sourceName = text(item.sourceName || item.source?.name || sourceId, 160);
  const publisher = item.provenance?.sourceType === "generated_search" ? null : text(item.publisher || sourceName, 160);
  const usagePolicy = item.usagePolicy || "standard-link-out";
  const content = {
    documentId, kind, eventKey: text(item.correlationKey || item.eventId || documentId, 240),
    legacyId: text(item.id || item.eventId, 160), sourceId, sourceName, publisher,
    title, excerpt: usagePolicy === "headline-only-link-out" ? null : text(item.excerpt || item.summary || item.description || item.content),
    canonicalUrl: url || null, usagePolicy, admissionState,
    official: item.source?.official === true || item.sourceRole === "official",
    claimStatus: item.claimStatus || "reported", status: item.status || "released",
    domains: list(item.domains || item.financial?.domains), countries: list(item.countries || item.countryMentions),
    instrumentIds: list(item.instrumentIds), assetClasses: list(item.assetClasses),
    publishedAt: iso(item.publishedAt), scheduledAt: iso(item.scheduledAt), updatedAt: iso(item.updatedAt),
    importance: item.importance || item.financial?.importance?.band || "unknown",
    dataMode: item.dataMode || "observed", stale: item.provenance?.stale === true,
    sourceObservedAt: iso(item.observedAt || item.receivedAt), imported,
    // Numerical macro releases are absent unless a typed adapter actually supplied them.
    macro: item.macro && typeof item.macro === "object" ? sanitizeSensitiveData(item.macro) : null
  };
  // Poll/receipt times are bookkeeping; they must not create repeated revisions.
  const { sourceObservedAt: _receipt, imported: _import, ...identity } = content;
  const revisionHash = contentHash(identity);
  return { ...content, revisionHash, evidenceId: `ev_${revisionHash.slice(0, 32)}`,
    firstSeenAt: previous?.firstSeenAt || observedAt,
    availableAt: previous?.revisionHash === revisionHash ? previous.availableAt : observedAt };
}

export class EvidenceMemoryService {
  constructor({ store, now = Date.now } = {}) { this.store = store; this.now = now; this.rejected = 0; }
  async capture(items = [], options = {}) {
    await this.store.ready;
    const observedAt = new Date(this.now()).toISOString();
    for (const item of items) {
      let value = normalizeEvidence(item, { ...options, observedAt });
      if (!value) { this.rejected += 1; continue; }
      const previous = this.store.get("evidence", value.documentId);
      if (previous?.revisionHash === value.revisionHash) continue;
      value = normalizeEvidence(item, { ...options, previous, observedAt });
      await this.store.put("evidence", value.documentId, value);
    }
  }
  async captureAwareness(awarenessStore, { imported = false } = {}) {
    const statuses = awarenessStore?.sourceStatuses || new Map();
    for (const event of awarenessStore?.events?.values() || []) {
      const admissionState = statuses.get(event.source?.sourceId)?.admissionState || (event.source?.role === "official" ? "unknown" : "active");
      await this.capture([event], { admissionState, imported });
    }
  }
  canonicalArticles({ asOf = new Date(this.now()).toISOString(), sinceHours = 36 } = {}) {
    const threshold = Date.parse(asOf) - sinceHours * 3600000;
    return this.store.evidenceAt(asOf).filter((row) => row.admissionState === "active" && !row.stale
      && row.publishedAt && Date.parse(row.publishedAt) >= threshold && Date.parse(row.publishedAt) <= Date.parse(asOf))
      .map((row) => ({ id: row.legacyId || row.evidenceId, provider: row.kind === "awareness" ? "awareness" : row.sourceId,
        sourceId: row.sourceId, sourceName: row.sourceName, publisher: row.publisher, title: row.title, description: row.excerpt,
        excerpt: row.excerpt, url: row.canonicalUrl, countryMentions: row.countries, instrumentIds: row.instrumentIds,
        domains: row.domains, publishedAt: row.publishedAt, receivedAt: row.firstSeenAt, usagePolicy: row.usagePolicy,
        dataMode: row.dataMode, evidenceId: row.evidenceId, availableAt: row.availableAt }));
  }
}
