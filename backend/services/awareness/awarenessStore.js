import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const SCHEMA_VERSION = "awareness-v1";
const RETENTION_MS = 365 * 24 * 60 * 60_000;
const POLL_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const AUDIT_COMPACTION_INTERVAL_MS = 24 * 60 * 60_000;
const ADMISSION_STATES = new Set(["probing", "shadow", "active", "blocked"]);
const DIAGNOSTIC_HEADER_ALLOWLIST = new Set([
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
]);

function sanitizeText(value, maxLength = 256) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/[\r\n\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function sourceAdmissionState(source = {}) {
  const explicit = String(source.admissionState || source.catalogAdmissionState || "").trim().toLowerCase();
  if (ADMISSION_STATES.has(explicit)) return explicit;
  if (source.enabled !== false) return "active";
  return /^pending(?:-|$)/i.test(String(source.disabledReason || "")) ? "probing" : "blocked";
}

function admissionIsPollable(value) {
  return value === "active" || value === "shadow";
}

function sanitizePollDiagnostics(value = null) {
  if (!value || typeof value !== "object") return null;
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(value.headers || {})) {
    const name = String(rawName || "").trim().toLowerCase();
    const headerValue = DIAGNOSTIC_HEADER_ALLOWLIST.has(name) ? sanitizeText(rawValue) : null;
    if (headerValue) headers[name] = headerValue;
  }
  const contentType = sanitizeText(value.contentType || headers["content-type"]);
  const requestId = sanitizeText(value.requestId);
  const bodySha256 = /^[a-f0-9]{64}$/i.test(String(value.bodySha256 || "")) ? String(value.bodySha256).toLowerCase() : null;
  const bodyBytes = value.bodyBytes !== null && value.bodyBytes !== undefined && Number.isFinite(Number(value.bodyBytes)) && Number(value.bodyBytes) >= 0
    ? Number(value.bodyBytes)
    : null;
  const truncated = value.truncated === true;
  if (!contentType && !requestId && !bodySha256 && bodyBytes === null && !Object.keys(headers).length && !truncated) return null;
  return { headers, contentType, requestId, bodySha256, bodyBytes, truncated };
}

function pollTimestamp(record = {}) {
  return Date.parse(record.completedAt || record.attemptedAt || 0) || 0;
}

function normalizePollRecord(record = {}, nowMs = Date.now()) {
  const attemptedMs = record.attemptedAt ? Date.parse(record.attemptedAt) : Number.NaN;
  const completedMs = record.completedAt ? Date.parse(record.completedAt) : Number.NaN;
  const nextEligibleMs = record.nextEligibleAt ? Date.parse(record.nextEligibleAt) : Number.NaN;
  const httpStatus = Number(record.httpStatus);
  return {
    attemptedAt: new Date(Number.isFinite(attemptedMs) ? attemptedMs : nowMs).toISOString(),
    completedAt: new Date(Number.isFinite(completedMs) ? completedMs : nowMs).toISOString(),
    outcome: ["ok", "not-modified", "empty", "empty-valid", "error"].includes(record.outcome) ? record.outcome : "error",
    httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
    latencyMs: Number.isFinite(Number(record.latencyMs)) && Number(record.latencyMs) >= 0 ? Math.round(Number(record.latencyMs)) : null,
    parsed: Math.max(0, Math.round(Number(record.parsed) || 0)),
    deduplicated: Math.max(0, Math.round(Number(record.deduplicated) || 0)),
    rejected: Math.max(0, Math.round(Number(record.rejected) || 0)),
    error: sanitizeText(record.error, 160),
    nextEligibleAt: Number.isFinite(nextEligibleMs) ? new Date(nextEligibleMs).toISOString() : null,
    diagnostic: sanitizePollDiagnostics(record.diagnostic)
  };
}

function summarizePollHistory(records = [], nowMs = Date.now()) {
  const cutoff = nowMs - POLL_HISTORY_RETENTION_MS;
  const retained = records.filter((record) => pollTimestamp(record) >= cutoff && pollTimestamp(record) <= nowMs + 60_000);
  const successes = retained.filter((record) => ["ok", "not-modified", "empty-valid"].includes(record.outcome)).length;
  const attempts = retained.length;
  return {
    retentionDays: 7,
    attempts,
    successes,
    successRate: attempts ? Number((successes / attempts).toFixed(4)) : null,
    empty: retained.filter((record) => ["empty", "empty-valid"].includes(record.outcome)).length,
    emptyValid: retained.filter((record) => record.outcome === "empty-valid").length,
    errors: retained.filter((record) => record.outcome === "error").length,
    forbidden: retained.filter((record) => record.httpStatus === 403).length,
    parsed: retained.reduce((sum, record) => sum + Number(record.parsed || 0), 0),
    deduplicated: retained.reduce((sum, record) => sum + Number(record.deduplicated || 0), 0),
    rejected: retained.reduce((sum, record) => sum + Number(record.rejected || 0), 0),
    firstAttemptAt: retained[0]?.attemptedAt || null,
    lastAttemptAt: retained.at(-1)?.attemptedAt || null,
    lastOutcome: retained.at(-1)?.outcome || null
  };
}

function semanticHash(event = {}) {
  const clone = structuredClone(event);
  delete clone.revision;
  delete clone.observedAt;
  if (clone.provenance) {
    delete clone.provenance.fetchedAt;
    delete clone.provenance.sourceArticleId;
  }
  return createHash("sha256").update(JSON.stringify(clone)).digest("hex");
}

function timestampFor(event = {}) {
  return Date.parse(event.publishedAt || event.scheduledAt || event.updatedAt || event.observedAt || 0) || 0;
}

function hasValidCoordinates(location = null) {
  if (location?.lat === null || location?.lat === undefined || location?.lat === "") return false;
  if (location?.lng === null || location?.lng === undefined || location?.lng === "") return false;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function normalizeSet(values = []) {
  return new Set((Array.isArray(values) ? values : String(values || "").split(","))
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean));
}

function matchesFilters(event, filters = {}) {
  const domains = normalizeSet(filters.domains || filters.domain || []);
  const kinds = normalizeSet(filters.kinds || []);
  const statuses = normalizeSet(filters.statuses || filters.status || []);
  const countries = normalizeSet(filters.countries || []);
  const instrumentIds = normalizeSet(filters.instrumentIds || []);
  if (domains.size && !(event.domains || []).some((value) => domains.has(String(value).toLowerCase()))) return false;
  if (kinds.size && !kinds.has(String(event.kind || "").toLowerCase())) return false;
  if (statuses.size && !statuses.has(String(event.status || "").toLowerCase())) return false;
  if (countries.size && !(event.countries || []).some((value) => countries.has(String(value).toLowerCase()))) return false;
  if (instrumentIds.size && !(event.instrumentIds || []).some((value) => instrumentIds.has(String(value).toLowerCase()))) return false;
  const eventTime = timestampFor(event);
  const from = filters.from ? Date.parse(filters.from) : null;
  const to = filters.to ? Date.parse(filters.to) : null;
  if (Number.isFinite(from) && eventTime < from) return false;
  if (Number.isFinite(to) && eventTime > to) return false;
  return true;
}

function initialSourceStatus(source = {}) {
  const catalogAdmissionState = sourceAdmissionState(source);
  const enabled = admissionIsPollable(catalogAdmissionState);
  return {
    sourceId: source.sourceId || null,
    name: source.name || null,
    tier: source.tier || null,
    enabled,
    disabledReason: source.disabledReason || null,
    catalogAdmissionState,
    admissionState: catalogAdmissionState,
    runtimeBlocked: false,
    blockedReason: catalogAdmissionState === "blocked" ? source.disabledReason || "catalog-blocked" : null,
    blockedAt: null,
    status: catalogAdmissionState === "blocked" ? "blocked" : catalogAdmissionState === "probing" ? "probing" : "unknown",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextEligibleAt: null,
    httpStatus: null,
    latencyMs: null,
    latestEventAt: null,
    lagMs: null,
    etag: null,
    lastModified: null,
    eventCount: 0,
    attempts: 0,
    successes: 0,
    parsed: 0,
    deduplicated: 0,
    rejected: 0,
    unlocated: 0,
    stale: false,
    consecutiveErrors: 0,
    consecutiveForbidden: 0,
    window7d: summarizePollHistory([]),
    lastPoll: null,
    lastDiagnostic: null,
    error: null
  };
}

export class AwarenessStore {
  constructor({ snapshotPath = null, auditPath = null, pollAuditPath = null, now = Date.now, retentionMs = RETENTION_MS } = {}) {
    this.snapshotPath = snapshotPath;
    this.auditPath = auditPath;
    this.pollAuditPath = pollAuditPath;
    this.now = now;
    this.retentionMs = retentionMs;
    this.events = new Map();
    this.sourceStatuses = new Map();
    this.pollHistories = new Map();
    this.revision = 0;
    this.lastCompactedAt = 0;
    this.lastPollCompactedAt = 0;
    this.hydrate();
    this.hydratePollHistory();
  }

  registerSources(sources = []) {
    for (const source of sources) {
      const initial = initialSourceStatus(source);
      const current = this.sourceStatuses.get(source.sourceId);
      if (!current) {
        this.sourceStatuses.set(source.sourceId, {
          ...initial,
          window7d: summarizePollHistory(this.pollHistories.get(source.sourceId) || [], this.now())
        });
        continue;
      }
      const runtimeBlocked = current.runtimeBlocked === true ||
        (current.admissionState === "blocked" && current.blockedReason === "persistent-http-403");
      const admissionState = runtimeBlocked ? "blocked" : initial.catalogAdmissionState;
      const staleHealthStatus = ["blocked", "probing", "disabled"].includes(current.status);
      this.sourceStatuses.set(source.sourceId, {
        ...initial,
        ...current,
        name: initial.name,
        tier: initial.tier,
        catalogAdmissionState: initial.catalogAdmissionState,
        admissionState,
        enabled: admissionIsPollable(admissionState),
        disabledReason: runtimeBlocked ? "persistent-http-403" : initial.disabledReason,
        runtimeBlocked,
        blockedReason: runtimeBlocked ? "persistent-http-403" : initial.blockedReason,
        blockedAt: runtimeBlocked ? current.blockedAt || current.lastAttemptAt || null : initial.blockedAt,
        status: runtimeBlocked ? "blocked" : admissionState === "probing" ? "probing" : admissionState === "blocked" ? "blocked" : staleHealthStatus ? "unknown" : current.status,
        window7d: summarizePollHistory(this.pollHistories.get(source.sourceId) || [], this.now())
      });
    }
    this.persist();
  }

  updateSourceStatus(sourceId, patch = {}) {
    const current = this.sourceStatuses.get(sourceId) || initialSourceStatus({ sourceId });
    const sanitizedPatch = { ...patch };
    if (Object.hasOwn(sanitizedPatch, "lastDiagnostic")) sanitizedPatch.lastDiagnostic = sanitizePollDiagnostics(sanitizedPatch.lastDiagnostic);
    if (Object.hasOwn(sanitizedPatch, "lastPoll")) sanitizedPatch.lastPoll = sanitizedPatch.lastPoll ? normalizePollRecord(sanitizedPatch.lastPoll, this.now()) : null;
    this.sourceStatuses.set(sourceId, { ...current, ...sanitizedPatch, sourceId });
    this.persist();
    return structuredClone(this.sourceStatuses.get(sourceId));
  }

  recordPoll(sourceId, record = {}, patch = {}) {
    const normalized = normalizePollRecord(record, this.now());
    const cutoff = this.now() - POLL_HISTORY_RETENTION_MS;
    const history = [...(this.pollHistories.get(sourceId) || []), normalized]
      .filter((entry) => pollTimestamp(entry) >= cutoff)
      .sort((left, right) => pollTimestamp(left) - pollTimestamp(right));
    this.pollHistories.set(sourceId, history);
    this.appendPollAudit(sourceId, normalized);
    return this.updateSourceStatus(sourceId, {
      ...patch,
      lastPoll: normalized,
      lastDiagnostic: normalized.diagnostic,
      window7d: summarizePollHistory(history, this.now())
    });
  }

  getPollHistory(sourceId) {
    const cutoff = this.now() - POLL_HISTORY_RETENTION_MS;
    return structuredClone((this.pollHistories.get(sourceId) || []).filter((record) => pollTimestamp(record) >= cutoff));
  }

  findScheduledCorrelation(event) {
    if (!event.correlationKey || event.status === "scheduled" || event.source?.official !== true) return null;
    const incomingAdmission = this.sourceStatuses.get(event.source?.sourceId)?.admissionState || sourceAdmissionState(event.source);
    const candidates = [...this.events.values()]
      .filter((candidate) => candidate.correlationKey === event.correlationKey && candidate.source?.official === true)
      .filter((candidate) => {
        const candidateAdmission = this.sourceStatuses.get(candidate.source?.sourceId)?.admissionState || sourceAdmissionState(candidate.source);
        return candidateAdmission === incomingAdmission;
      });
    return candidates.find((candidate) => ["scheduled", "live"].includes(candidate.status)) ||
      candidates.find((candidate) => candidate.source?.sourceId === event.source?.sourceId ||
        (candidate.relatedSources || []).includes(event.source?.sourceId)) ||
      null;
  }

  reconcile(incoming = [], { sourceId = null } = {}) {
    const changed = [];
    let deduplicated = 0;
    let rejected = 0;
    for (const rawEvent of incoming) {
      if (!rawEvent?.eventId || !rawEvent?.title || !rawEvent?.source?.sourceId) {
        rejected += 1;
        continue;
      }
      const existingByOwnId = this.events.get(rawEvent.eventId);
      if (existingByOwnId && ["released", "updated"].includes(existingByOwnId.status) && ["scheduled", "live"].includes(rawEvent.status)) {
        deduplicated += 1;
        continue;
      }
      const scheduled = existingByOwnId ? null : this.findScheduledCorrelation(rawEvent);
      const event = scheduled
        ? {
            ...scheduled,
            ...rawEvent,
            eventId: scheduled.eventId,
            scheduledAt: scheduled.scheduledAt || rawEvent.scheduledAt,
            relatedSources: [...new Set([...(scheduled.relatedSources || [scheduled.source?.sourceId]), rawEvent.source?.sourceId].filter(Boolean))]
          }
        : rawEvent;
      const current = this.events.get(event.eventId);
      if (current && semanticHash(current) === semanticHash(event)) {
        deduplicated += 1;
        continue;
      }
      this.revision += 1;
      const next = {
        ...event,
        revision: current ? Number(current.revision || 1) + 1 : Number(event.revision || 1),
        observedAt: event.observedAt || new Date(this.now()).toISOString()
      };
      this.events.set(next.eventId, next);
      changed.push(next);
      this.appendAudit(next);
    }
    this.prune();
    if (changed.length || rejected || deduplicated) this.persist();
    if (sourceId) {
      const unlocated = incoming.filter((event) => !hasValidCoordinates(event?.location)).length;
      this.updateSourceStatus(sourceId, { parsed: incoming.length, deduplicated, rejected, unlocated, eventCount: incoming.length });
    }
    return { changed: structuredClone(changed), deduplicated, rejected, revision: this.revision };
  }

  setSourceStale(sourceId, stale = true) {
    const candidates = [...this.events.values()]
      .filter((event) => event.source?.sourceId === sourceId)
      .filter((event) => Boolean(event.provenance?.stale) !== Boolean(stale) || (stale ? event.dataMode !== "stale" : event.dataMode === "stale"))
      .map((event) => ({
        ...event,
        dataMode: stale ? "stale" : "observed",
        provenance: { ...(event.provenance || {}), stale: Boolean(stale) }
      }));
    return candidates.length ? this.reconcile(candidates) : { changed: [], deduplicated: 0, rejected: 0, revision: this.revision };
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    for (const [eventId, event] of this.events) {
      const timestamp = timestampFor(event);
      if (timestamp && timestamp < cutoff) this.events.delete(eventId);
    }
    const pollCutoff = this.now() - POLL_HISTORY_RETENTION_MS;
    for (const [sourceId, history] of this.pollHistories) {
      const retained = history.filter((record) => pollTimestamp(record) >= pollCutoff);
      if (retained.length) this.pollHistories.set(sourceId, retained);
      else this.pollHistories.delete(sourceId);
    }
  }

  getSnapshot({ mode = "off", filters = {}, publicView = true } = {}) {
    const nowMs = this.now();
    const limit = Math.min(500, Math.max(1, Number(filters.limit || 100)));
    const publicSourceIsActive = (event) => {
      const status = this.sourceStatuses.get(event.source?.sourceId);
      return !status || status.admissionState === "active";
    };
    const matchingValues = [...this.events.values()].filter((event) => matchesFilters(event, filters));
    const values = publicView && mode === "visible" ? matchingValues.filter(publicSourceIsActive) : matchingValues;
    const allUpcoming = values
      .filter((event) => event.scheduledAt && Date.parse(event.scheduledAt) >= nowMs && ["scheduled", "live"].includes(event.status))
      .sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt));
    const upcomingIds = new Set(allUpcoming.map((event) => event.eventId));
    const upcoming = allUpcoming.slice(0, limit);
    const recent = values
      .filter((event) => !upcomingIds.has(event.eventId))
      .sort((left, right) => timestampFor(right) - timestampFor(left))
      .slice(0, limit);
    const sourceStatus = [...this.sourceStatuses.values()]
      .filter((status) => !publicView || mode !== "visible" || status.admissionState === "active")
      .map((status) => ({
        ...status,
        window7d: summarizePollHistory(this.pollHistories.get(status.sourceId) || [], nowMs)
      }))
      .map((status) => {
        if (!publicView) return status;
        const clone = { ...status };
        delete clone.lastPoll;
        delete clone.lastDiagnostic;
        return clone;
      })
      .sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId)));
    const visible = !publicView || mode === "visible";
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: this.revision,
      generatedAt: new Date(nowMs).toISOString(),
      mode,
      upcoming: visible ? structuredClone(upcoming) : [],
      recent: visible ? structuredClone(recent) : [],
      sourceStatus: visible ? structuredClone(sourceStatus) : [],
      quality: {
        total: values.length,
        scheduled: values.filter((event) => event.status === "scheduled").length,
        released: values.filter((event) => event.status === "released").length,
        unlocated: values.filter((event) => !hasValidCoordinates(event.location)).length,
        stale: values.filter((event) => event.dataMode === "stale" || event.provenance?.stale).length
      }
    };
  }

  appendAudit(event) {
    if (!this.auditPath) return;
    mkdirSync(dirname(this.auditPath), { recursive: true });
    appendFileSync(this.auditPath, `${JSON.stringify({ recordedAt: new Date(this.now()).toISOString(), revision: this.revision, event })}\n`, { encoding: "utf8", mode: 0o600 });
    if (this.now() - this.lastCompactedAt >= AUDIT_COMPACTION_INTERVAL_MS) this.compactAudit();
  }

  appendPollAudit(sourceId, poll) {
    if (!this.pollAuditPath) return;
    mkdirSync(dirname(this.pollAuditPath), { recursive: true });
    appendFileSync(this.pollAuditPath, `${JSON.stringify({ recordedAt: poll.completedAt, sourceId, poll })}\n`, { encoding: "utf8", mode: 0o600 });
    if (this.now() - this.lastPollCompactedAt >= AUDIT_COMPACTION_INTERVAL_MS) this.compactPollAudit();
  }

  compactPollAudit() {
    if (!this.pollAuditPath) return;
    this.lastPollCompactedAt = this.now();
    const rows = [...this.pollHistories.entries()]
      .flatMap(([sourceId, history]) => history.map((poll) => ({ recordedAt: poll.completedAt, sourceId, poll })))
      .filter((row) => Date.parse(row.recordedAt || 0) >= this.now() - POLL_HISTORY_RETENTION_MS)
      .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
    const temporary = `${this.pollAuditPath}.${process.pid}.tmp`;
    mkdirSync(dirname(this.pollAuditPath), { recursive: true });
    writeFileSync(temporary, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.pollAuditPath);
  }

  compactAudit() {
    if (!this.auditPath) return;
    this.lastCompactedAt = this.now();
    try {
      if (statSync(this.auditPath).size < 1_000_000) return;
      const cutoff = this.now() - this.retentionMs;
      const retained = readFileSync(this.auditPath, "utf8").split(/\r?\n/).filter(Boolean).filter((line) => {
        try { return Date.parse(JSON.parse(line).recordedAt || 0) >= cutoff; } catch { return false; }
      });
      const temporary = `${this.auditPath}.${process.pid}.tmp`;
      writeFileSync(temporary, retained.length ? `${retained.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.auditPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  persist() {
    if (!this.snapshotPath) return;
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    const temporary = `${this.snapshotPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      revision: this.revision,
      generatedAt: new Date(this.now()).toISOString(),
      events: [...this.events.values()],
      sourceStatus: [...this.sourceStatuses.values()]
    }), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.snapshotPath);
  }

  hydrate() {
    if (!this.snapshotPath) return false;
    try {
      const payload = JSON.parse(readFileSync(this.snapshotPath, "utf8"));
      if (payload.schemaVersion !== SCHEMA_VERSION) return false;
      this.revision = Number(payload.revision || 0);
      this.events = new Map((payload.events || []).map((event) => [event.eventId, event]));
      this.sourceStatuses = new Map((payload.sourceStatus || []).map((status) => [status.sourceId, status]));
      this.prune();
      this.compactAudit();
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  hydratePollHistory() {
    if (!this.pollAuditPath) return false;
    try {
      const cutoff = this.now() - POLL_HISTORY_RETENTION_MS;
      const histories = new Map();
      for (const line of readFileSync(this.pollAuditPath, "utf8").split(/\r?\n/).filter(Boolean)) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const recordedMs = Date.parse(row?.recordedAt || row?.poll?.completedAt || "");
        if (!row?.sourceId || !Number.isFinite(recordedMs) || recordedMs < cutoff || recordedMs > this.now() + 60_000) continue;
        const poll = normalizePollRecord(row.poll, recordedMs);
        if (!histories.has(row.sourceId)) histories.set(row.sourceId, []);
        histories.get(row.sourceId).push(poll);
      }
      for (const [sourceId, history] of histories) {
        history.sort((left, right) => pollTimestamp(left) - pollTimestamp(right));
        this.pollHistories.set(sourceId, history);
        const status = this.sourceStatuses.get(sourceId);
        if (status) this.sourceStatuses.set(sourceId, {
          ...status,
          lastPoll: history.at(-1) || status.lastPoll || null,
          lastDiagnostic: history.at(-1)?.diagnostic || status.lastDiagnostic || null,
          window7d: summarizePollHistory(history, this.now())
        });
      }
      this.compactPollAudit();
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
}

export {
  SCHEMA_VERSION as AWARENESS_SCHEMA_VERSION,
  RETENTION_MS as AWARENESS_RETENTION_MS,
  POLL_HISTORY_RETENTION_MS as AWARENESS_POLL_HISTORY_RETENTION_MS,
  sourceAdmissionState as normalizeAwarenessAdmissionState
};
