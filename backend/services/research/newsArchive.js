import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { detectCountryMentions } from "../../utils/countryCatalog.js";
import { AppError } from "../../utils/error.js";
import { permittedArticle, safeUrl } from "../../utils/researchProjection.js";
import { listVerifiedInstruments } from "../market/instrumentRegistry.js";
import { matchInstrument, resolveReferences } from "./instrumentIdentity.js";

import { normalizeNewsFilters } from "../../utils/stableHash.js";
const DAY = 86400000;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const temporal = value => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function canonicalUrl(value) {
  const safe = safeUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  return url.href;
}
function allowedArticle(value) {
  const admission = value.admissionState || value.source?.admissionState || value.provenance?.admissionState;
  return !["shadow", "blocked", "probing"].includes(admission) && value.shadow !== true && value.provenance?.shadow !== true;
}
function wireSize(data) {
  const payload = { ok: true, queriedAt: new Date().toISOString(), origin: "OGID", data, warnings: data.warnings, truncated: false };
  return Buffer.byteLength(JSON.stringify({ structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] }));
}
export class NewsArchive {
  constructor({ persistencePath = null, retentionDays = 30, maxItems = 100000, maxBytes = 67108864, now = Date.now, cursorTtlMs = 900000, maxSnapshots = 32, maxSnapshotItems = 200000 } = {}) {
    this.path = persistencePath; this.retentionDays = Math.max(30, retentionDays); this.maxItems = maxItems; this.maxBytes = maxBytes; this.now = now;
    this.cursorTtlMs = cursorTtlMs; this.maxSnapshots = maxSnapshots; this.maxSnapshotItems = maxSnapshotItems; this.snapshots = new Map(); this.cursorKey = randomBytes(32);
    this.records = new Map(); this.history = new Map(); this.revision = 0; this.startedAt = new Date(now()).toISOString(); this.lastIngestAt = null;
    this.recoveryStatus = "new"; this.capacityPrunedAt = null;
    this.hydrate(); this.prune();
  }
  hydrate() {
    if (!this.path) return;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      if (data.schemaVersion !== "news-archive-v1" || !Array.isArray(data.articles)) throw new Error("invalid-archive-schema");
      this.records = new Map(data.articles.map(article => [article.id, article]));
      this.history = new Map((data.history || []).map(row => [row.bucket, row]));
      this.revision = data.revision || 0; this.startedAt = data.startedAt; this.lastIngestAt = data.lastIngestAt || null; this.capacityPrunedAt = data.capacityPrunedAt || null;
      this.recoveryStatus = "restored";
    } catch (error) {
      if (error.code === "ENOENT") return;
      // Nunca sobrescribir un archivo corrupto con uno vacío.
      throw new AppError("El archivo de noticias no puede recuperarse; conservarlo y revisar el respaldo.", 503, "ARCHIVE_RECOVERY_FAILED");
    }
  }
  persist() {
    if (!this.path) return;
    const value = { schemaVersion: "news-archive-v1", revision: this.revision, startedAt: this.startedAt, lastIngestAt: this.lastIngestAt, capacityPrunedAt: this.capacityPrunedAt, articles: [...this.records.values()], history: [...this.history.values()] };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, this.path);
  }
  prune() {
    const cutoff = this.now() - this.retentionDays * DAY;
    const retained = [...this.records.values()].filter(article => temporal(article.archiveLastSeenAt) >= cutoff).sort((a, b) => temporal(b.archiveLastSeenAt) - temporal(a.archiveLastSeenAt));
    let bytes = 0; const bounded = [];
    for (const article of retained) {
      const size = Buffer.byteLength(JSON.stringify(article));
      if (bounded.length >= this.maxItems || bytes + size > this.maxBytes) { this.capacityPrunedAt = new Date(this.now()).toISOString(); continue; }
      bytes += size; bounded.push(article);
    }
    this.records = new Map(bounded.map(article => [article.id, article]));
    for (const [key, row] of this.history) if (temporal(row.observedAt) < cutoff) this.history.delete(key);
  }
  ingest(values = [], { lane = "editorial", awarenessMode = "off" } = {}) {
    if (lane === "financial" && awarenessMode !== "visible") return { accepted: 0, reason: "financial-not-public" };
    const now = new Date(this.now()).toISOString(); let accepted = 0; const collected = [];
    for (const raw of values) {
      if (!allowedArticle(raw)) continue;
      const article = permittedArticle({ ...raw, sourceId: raw.sourceId || raw.source?.sourceId || raw.provenance?.sourceId, sourceName: raw.sourceName || raw.source?.name,
        publisher: raw.publisher || raw.source?.publisher, topics: raw.topics || raw.source?.topics, instrumentIds: raw.instrumentIds || raw.source?.instrumentIds }, now);
      if (!article.title) continue;
      article.url = canonicalUrl(article.url);
      article.countryMentions = [...new Set([...(article.countryMentions || []), ...detectCountryMentions(`${article.title} ${article.excerpt || ""}`)])];
      const id = `article-${hash([article.url || article.title.toLowerCase(), article.url ? null : article.publishedAt]).slice(0, 32)}`;
      const previous = this.records.get(id);
      const provenance = { provider: article.provider || "unknown", sourceId: article.sourceId || null, publisher: article.publisher || article.sourceName || null, url: article.url, ...article.provenance };
      const provenanceByKey = new Map((previous?.provenances || []).map(p => [hash([p.provider, p.sourceId || p.publisher, p.url]), p]));
      provenanceByKey.set(hash([provenance.provider, provenance.sourceId || provenance.publisher, provenance.url]), provenance);
      const record = { ...article, id, originalIds: [...new Set([...(previous?.originalIds || []), raw.id].filter(Boolean))],
        sourceRole: raw.sourceRole || raw.role || raw.source?.role || previous?.sourceRole || null,
        leadImageUrl: safeUrl(raw.leadImageUrl || raw.imageUrl || raw.urlToImage) || previous?.leadImageUrl || null,
        analysisFeatures: raw.analysisFeatures || previous?.analysisFeatures || null,
        receivedAt: previous?.receivedAt || article.receivedAt, archiveFirstSeenAt: previous?.archiveFirstSeenAt || now, archiveLastSeenAt: now,
        revision: previous?.revision || 0, provenances: [...provenanceByKey.values()],
        instrumentIds: [...new Set([...(previous?.instrumentIds || []), ...(article.instrumentIds || [])])],
        topics: [...new Set([...(previous?.topics || []), ...(article.topics || []), ...(article.topicTags || [])])],
        countryMentions: [...new Set([...(previous?.countryMentions || []), ...article.countryMentions])] };
      // La política más restrictiva prevalece entre duplicados del mismo artículo.
      if (previous?.excerpt === null && (previous?.usagePolicy === "headline-only-link-out" || previous?.usagePolicy?.contentPolicy === "headline-only-link-out")) { record.excerpt = null; record.usagePolicy = previous.usagePolicy; }
      const semantic = value => pickSemantic(value);
      const changed = !previous || hash(semantic(record)) !== hash(semantic(previous));
      const contentChanged = !previous || hash(pickContent(record)) !== hash(pickContent(previous));
      record.contentRevision = (previous ? previous.contentRevision || 1 : 0) + (contentChanged ? 1 : 0);
      record.archiveChangedAt = contentChanged ? now : previous.archiveChangedAt || previous.archiveFirstSeenAt;
      if (changed) { record.revision++; this.revision++; }
      this.records.set(id, record); if (changed) collected.push(record); accepted++;
    }
    this.lastIngestAt = now; this.prune(); this.persist(); this.onIngest?.(collected);
    return { accepted, revision: this.revision };
  }
  recordContext(snapshot) {
    const observedAt = new Date(this.now()).toISOString(); const bucket = observedAt.slice(0, 13);
    this.history.set(bucket, { bucket, observedAt, dataAsOf: snapshot.meta?.lastRefreshAt || null, quality: snapshot.meta?.dataQuality || {},
      risks: Object.fromEntries(Object.entries(snapshot.countries || {}).map(([iso, country]) => [iso, { score: country.score ?? null, level: country.level || null, updatedAt: country.updatedAt || null }])),
      impacts: (snapshot.impact?.items || []).slice(0, 100).map(item => ({ ticker: item.ticker, eventScore: item.eventScore ?? null, impactScore: item.impactScore ?? null, linkedArticles: item.linkedArticles || [], level: item.level || null })) });
    this.prune(); this.persist();
  }
  getHistory({ from, to }) { return [...this.history.values()].filter(row => (!from || temporal(row.observedAt) >= temporal(from)) && (!to || temporal(row.observedAt) <= temporal(to))).sort((a, b) => a.observedAt.localeCompare(b.observedAt)); }
  coverage(filters = {}) {
    const values = [...this.records.values()]; const dates = values.map(article => temporal(article.publishedAt)).filter(value => value !== null);
    const received = values.map(article => temporal(article.receivedAt)).filter(value => value !== null);
    const iso = values => values.length ? new Date(Math.min(...values)).toISOString() : null;
    const newest = values => values.length ? new Date(Math.max(...values)).toISOString() : null;
    const retainedSince = new Date(Math.max(temporal(this.startedAt), this.now() - this.retentionDays * DAY)).toISOString();
    return { retentionDays: this.retentionDays, startedAt: this.startedAt, retainedSince, lastIngestAt: this.lastIngestAt, totalStored: values.length, oldest: iso(dates), newest: newest(dates), oldestReceivedAt: iso(received), newestReceivedAt: newest(received),
      requestedWindow: { from: filters.from || null, to: filters.to || null, timeField: filters.timeField || "publishedAt" },
      partial: !filters.from || temporal(filters.from) < temporal(retainedSince) || Boolean(this.capacityPrunedAt), acquisitionContinuity: "unknown", capacityPrunedAt: this.capacityPrunedAt, recoveryStatus: this.recoveryStatus,
      meaning: "collected permitted metadata; never all Internet news", unknownPublicationCount: values.filter(article => !article.publishedAt).length };
  }
  getItem(id) {
    const value = this.records.get(id) || [...this.records.values()].find(article => article.originalIds.includes(id));
    if (!value) throw new AppError("Artículo no disponible dentro de la retención del archivo.", 404, "NEWS_ITEM_NOT_FOUND");
    return { article: structuredClone(value), coverage: this.coverage(), revision: this.revision, warnings: ["No se devuelve texto completo; las fuentes duplicadas no son corroboraciones independientes."] };
  }
  cleanupSnapshots() {
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.now()) this.snapshots.delete(id);
  }
  cursor(id, offset) {
    const encoded = Buffer.from(JSON.stringify({ id, offset })).toString("base64url");
    return `${encoded}.${createHmac("sha256", this.cursorKey).update(encoded).digest("base64url")}`;
  }
  decodeCursor(cursor) {
    try {
      const [encoded, signature, extra] = cursor.split(".");
      const value = JSON.parse(Buffer.from(encoded, "base64url").toString());
      if (extra || !Number.isInteger(value.offset) || value.offset < 0 || typeof value.id !== "string") throw new Error();
      if (!this.snapshots.has(value.id)) throw new AppError("La revisión del cursor ha caducado o el backend se reinició; reiniciar la búsqueda.", 410, "CURSOR_EXPIRED");
      const expected = createHmac("sha256", this.cursorKey).update(encoded).digest(); const presented = Buffer.from(signature || "", "base64url");
      if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) throw new Error();
      return value;
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError("Cursor inválido.", 400, "INVALID_CURSOR"); }
  }
  search(input = {}) {
    this.cleanupSnapshots();
    const { limit = 20, maxBytes = 262144, cursor, ...rawFilters } = input;
    const filters = normalizeNewsFilters(rawFilters);
    let id, offset = 0, snapshot;
    if (cursor) {
      ({ id, offset } = this.decodeCursor(cursor)); snapshot = this.snapshots.get(id);
      if (Object.keys(rawFilters).length && hash(filters) !== snapshot.filterHash) throw new AppError("Los filtros no pueden cambiar dentro de una revisión paginada.", 400, "CURSOR_FILTER_MISMATCH");
    } else {
      const universe = listVerifiedInstruments();
      const resolutions = resolveReferences([...(filters.symbols || []), ...(filters.instrumentIds || [])], {}, universe);
      if (resolutions.some(row => row.status !== "resolved")) throw new AppError("Identidad inexistente o ambigua; consultar instruments.resolve y elegir identidad de mercado.", 400, "UNRESOLVED_INSTRUMENT");
      const instruments = resolutions.map(row => universe.find(instrument => instrument.instrumentId === row.instrumentId));
      const field = filters.timeField || "publishedAt";
      const matched = [...this.records.values()].flatMap(article => {
        const reasons = [];
        if (filters.countries?.length) {
          const matching = article.countryMentions.filter(iso => filters.countries.includes(iso));
          if (!matching.length) return [];
          reasons.push(...matching.map(iso => ({ kind: "country", method: "country-tag-or-detection", evidence: iso })));
        }
        if (instruments.length) {
          const matches = instruments.map(instrument => matchInstrument(article, instrument)).filter(Boolean);
          if (!matches.length) return [];
          reasons.push(...matches);
        }
        const text = `${article.title} ${article.excerpt || ""}`.toLowerCase();
        if (filters.q && !text.includes(filters.q.toLowerCase())) return [];
        if (filters.topics?.length && !filters.topics.some(topic => (article.topics || []).includes(topic))) return [];
        if (filters.sectors?.length && !filters.sectors.some(sector => (article.sectors || []).includes(sector))) return [];
        if (filters.providers?.length && !article.provenances.some(p => filters.providers.includes(p.provider))) return [];
        if (filters.sources?.length && !article.provenances.some(p => filters.sources.includes(p.sourceId) || filters.sources.includes(p.publisher))) return [];
        const timestamp = temporal(article[field]);
        if ((filters.from || filters.to) && (timestamp === null || (filters.from && timestamp < temporal(filters.from)) || (filters.to && timestamp > temporal(filters.to)))) return [];
        if (filters.q) reasons.push({ kind: "text", method: "case-insensitive-text", evidence: filters.q });
        if (filters.topics?.length) reasons.push({ kind: "topic", method: "collected-topic-tag", evidence: filters.topics.filter(topic => article.topics.includes(topic)).join(", ") });
        return [{ ...article, matchReasons: reasons }];
      }).sort((a, b) => (temporal(b[field]) ?? temporal(b.receivedAt) ?? 0) - (temporal(a[field]) ?? temporal(a.receivedAt) ?? 0) || a.id.localeCompare(b.id));
      while (this.snapshots.size >= this.maxSnapshots || [...this.snapshots.values()].reduce((sum, row) => sum + row.articles.length, 0) + matched.length > this.maxSnapshotItems) {
        if (!this.snapshots.size) throw new AppError("El resultado excede la capacidad de revisiones; acotar la ventana.", 413, "SNAPSHOT_TOO_LARGE");
        this.snapshots.delete(this.snapshots.keys().next().value);
      }
      id = randomUUID(); snapshot = { articles: matched, filterHash: hash(filters), revision: this.revision, expiresAt: this.now() + this.cursorTtlMs, coverage: this.coverage(filters) }; this.snapshots.set(id, snapshot);
    }
    if (offset > snapshot.articles.length) throw new AppError("Cursor fuera del resultado.", 400, "INVALID_CURSOR");
    const data = { articles: [], total: snapshot.articles.length, hasMore: false, nextCursor: null, revision: snapshot.revision, snapshotId: id, cursorExpiresAt: new Date(snapshot.expiresAt).toISOString(), coverage: snapshot.coverage,
      quality: { syntheticCount: snapshot.articles.filter(article => article.synthetic || article.dataMode === "synthetic").length, staleCount: snapshot.articles.filter(article => article.dataMode === "stale" || article.provenance?.stale).length },
      warnings: ["Archivo de metadata y extractos autorizados; no es cobertura completa de Internet.", "La fecha de publicación desconocida queda fuera de ventanas publishedAt; consultar receivedAt de forma explícita.", ...(snapshot.coverage.partial ? ["La cobertura solicitada es parcial por activación, retención o capacidad."] : [])] };
    while (data.articles.length < limit && offset + data.articles.length < snapshot.articles.length) {
      data.articles.push(snapshot.articles[offset + data.articles.length]);
      const next = offset + data.articles.length; data.hasMore = next < snapshot.articles.length; data.nextCursor = data.hasMore ? this.cursor(id, next) : null;
      if (wireSize(data) > maxBytes - 512) { data.articles.pop(); break; }
    }
    const next = offset + data.articles.length; data.hasMore = next < snapshot.articles.length; data.nextCursor = data.hasMore ? this.cursor(id, next) : null;
    if (!data.articles.length && data.hasMore) throw new AppError("Un artículo no cabe en el presupuesto de salida; aumentar maxBytes sin avanzar el cursor.", 413, "NEWS_ITEM_TOO_LARGE");
    if (wireSize(data) > maxBytes - 512) throw new AppError("La metadata no cabe en el presupuesto de salida.", 413, "OUTPUT_TOO_LARGE");
    return structuredClone(data);
  }
}
function pickContent(article) { return { title: article.title, excerpt: article.excerpt, publishedAt: article.publishedAt, updatedAt: article.updatedAt }; }
function pickSemantic(article) { return { ...pickContent(article), synthetic: article.synthetic, dataMode: article.dataMode, analysisFeatures: article.analysisFeatures, instrumentIds: article.instrumentIds, topics: article.topics, sectors: article.sectors, countryMentions: article.countryMentions, provenances: article.provenances?.map(p => ({ provider: p.provider, sourceId: p.sourceId, publisher: p.publisher, url: p.url })) }; }
