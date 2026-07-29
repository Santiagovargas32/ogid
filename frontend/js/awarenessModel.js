export const AWARENESS_SCHEMA_VERSION = "awareness-v1";
export const AWARENESS_EVENT_SCHEMA_VERSION = "awareness-event-v1";
export const AWARENESS_MAP_EVENT_NAME = "awareness:map-events:v1";
export const AWARENESS_PREFERENCES_KEY = "ogid.awareness.preferences.v1";

const AWARENESS_MODES = new Set(["off", "shadow", "visible"]);
const AWARENESS_TABS = new Set(["geopolitical", "markets", "all"]);
const FINANCIAL_DOMAINS = new Set(["financial", "macro", "corporate", "regulatory"]);
const GEOPOLITICAL_DOMAINS = new Set(["geopolitical", "security"]);
const LOCATION_PRECISIONS = new Set(["exact", "city", "country", "region", "none"]);
const CLAIM_STATUSES = new Set(["source_asserted", "corroborated", "reported"]);
const EVENT_STATUSES = new Set(["scheduled", "live", "released", "updated", "cancelled"]);
const IMPORTANCE_LEVELS = new Set(["high", "medium", "low"]);
const DATA_MODES = new Set(["observed", "stale"]);

function cleanString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function cleanStringArray(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => cleanString(item)).filter(Boolean))];
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampOrNull(value) {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function normalizeSource(source = {}) {
  return {
    sourceId: cleanString(source.sourceId || source.id, "unknown"),
    name: cleanString(source.name || source.sourceName, "Unknown source"),
    role: cleanString(source.role, "unknown"),
    official: source.official === true,
    timezone: cleanString(source.timezone, "UTC")
  };
}

function normalizeLocation(location) {
  if (!location || typeof location !== "object") {
    return null;
  }
  const lat = finiteOrNull(location.lat ?? location.latitude);
  const lng = finiteOrNull(location.lng ?? location.lon ?? location.longitude);
  const requestedPrecision = cleanString(location.precision, "none").toLowerCase();
  return {
    lat,
    lng,
    label: cleanString(location.label),
    precision: LOCATION_PRECISIONS.has(requestedPrecision) ? requestedPrecision : "none",
    method: cleanString(location.method, "unknown"),
    confidence: finiteOrNull(location.confidence)
  };
}

export function normalizeAwarenessEvent(rawEvent = {}) {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }
  const eventId = cleanString(rawEvent.eventId || rawEvent.id);
  if (!eventId) {
    return null;
  }
  const times = rawEvent.times && typeof rawEvent.times === "object" ? rawEvent.times : {};
  const status = cleanString(rawEvent.status, "released").toLowerCase();
  const importance = cleanString(rawEvent.importance, "low").toLowerCase();
  const claimStatus = cleanString(rawEvent.claimStatus, "reported").toLowerCase();
  const dataMode = cleanString(rawEvent.dataMode, "observed").toLowerCase();

  return {
    schemaVersion: AWARENESS_EVENT_SCHEMA_VERSION,
    eventId,
    revision: nonNegativeInteger(rawEvent.revision),
    kind: cleanString(rawEvent.kind || rawEvent.eventType || rawEvent.type, "market_moving_news"),
    domains: cleanStringArray(rawEvent.domains).map((domain) => domain.toLowerCase()),
    status: EVENT_STATUSES.has(status) ? status : "released",
    title: cleanString(rawEvent.title, "Untitled awareness event"),
    summary: cleanString(rawEvent.summary || rawEvent.description),
    canonicalUrl: cleanString(rawEvent.canonicalUrl || rawEvent.url),
    scheduledAt: timestampOrNull(rawEvent.scheduledAt || times.scheduledAt || times.scheduled),
    publishedAt: timestampOrNull(rawEvent.publishedAt || times.publishedAt || times.published),
    observedAt: timestampOrNull(rawEvent.observedAt || times.observedAt || times.observed),
    updatedAt: timestampOrNull(rawEvent.updatedAt || times.updatedAt || times.updated),
    source: normalizeSource(rawEvent.source),
    countries: cleanStringArray(rawEvent.countries).map((country) => country.toUpperCase()),
    instrumentIds: cleanStringArray(rawEvent.instrumentIds),
    sectors: cleanStringArray(rawEvent.sectors),
    assetClasses: cleanStringArray(rawEvent.assetClasses),
    importance: IMPORTANCE_LEVELS.has(importance) ? importance : "low",
    importanceMethod: cleanString(rawEvent.importanceMethod, "rule-v1"),
    location: normalizeLocation(rawEvent.location || rawEvent.geo),
    claimStatus: CLAIM_STATUSES.has(claimStatus) ? claimStatus : "reported",
    provenance: rawEvent.provenance && typeof rawEvent.provenance === "object"
      ? {
          adapter: cleanString(rawEvent.provenance.adapter),
          sourceUrl: cleanString(rawEvent.provenance.sourceUrl),
          fetchedAt: timestampOrNull(rawEvent.provenance.fetchedAt),
          methodVersion: cleanString(rawEvent.provenance.methodVersion),
          stale: rawEvent.provenance.stale === true
        }
      : { adapter: "", sourceUrl: "", fetchedAt: null, methodVersion: "", stale: false },
    dataMode: DATA_MODES.has(dataMode) ? dataMode : "observed"
  };
}

function compareUpcoming(left, right) {
  const leftTime = new Date(left.scheduledAt || left.updatedAt || 0).getTime();
  const rightTime = new Date(right.scheduledAt || right.updatedAt || 0).getTime();
  return leftTime - rightTime || right.revision - left.revision || left.eventId.localeCompare(right.eventId);
}

function compareRecent(left, right) {
  const leftTime = new Date(left.publishedAt || left.updatedAt || left.observedAt || 0).getTime();
  const rightTime = new Date(right.publishedAt || right.updatedAt || right.observedAt || 0).getTime();
  return rightTime - leftTime || right.revision - left.revision || left.eventId.localeCompare(right.eventId);
}

function deduplicateEvents(events = []) {
  const byId = new Map();
  for (const rawEvent of events) {
    const event = normalizeAwarenessEvent(rawEvent);
    if (!event) {
      continue;
    }
    const current = byId.get(event.eventId);
    if (!current || event.revision >= current.revision) {
      byId.set(event.eventId, event);
    }
  }
  return [...byId.values()];
}

function defaultQuality() {
  return { total: 0, scheduled: 0, released: 0, unlocated: 0, stale: 0 };
}

function normalizeQuality(quality = {}) {
  const result = defaultQuality();
  for (const key of Object.keys(result)) {
    result[key] = nonNegativeInteger(quality?.[key]);
  }
  return result;
}

function classifyLooseEvents(events = [], now = Date.now()) {
  const upcoming = [];
  const recent = [];
  for (const rawEvent of events) {
    const event = normalizeAwarenessEvent(rawEvent);
    if (!event) {
      continue;
    }
    const scheduledMs = new Date(event.scheduledAt || 0).getTime();
    const isUpcoming = event.status === "scheduled" && Number.isFinite(scheduledMs) && scheduledMs > Number(now);
    (isUpcoming ? upcoming : recent).push(event);
  }
  return { upcoming, recent };
}

export function normalizeAwarenessPayload(rawPayload = {}) {
  const payload = rawPayload?.awareness && typeof rawPayload.awareness === "object"
    ? rawPayload.awareness
    : rawPayload;
  const loose = classifyLooseEvents([...arrayValue(payload.events), ...arrayValue(payload.upsert), ...(payload.event ? [payload.event] : [])]);
  const mode = cleanString(payload.mode, "off").toLowerCase();
  const upcoming = deduplicateEvents([...arrayValue(payload.upcoming), ...loose.upcoming]).sort(compareUpcoming);
  const upcomingIds = new Set(upcoming.map((event) => event.eventId));
  const recent = deduplicateEvents([...arrayValue(payload.recent), ...loose.recent])
    .filter((event) => !upcomingIds.has(event.eventId))
    .sort(compareRecent);
  return {
    schemaVersion: AWARENESS_SCHEMA_VERSION,
    revision: nonNegativeInteger(payload.revision),
    generatedAt: timestampOrNull(payload.generatedAt),
    mode: AWARENESS_MODES.has(mode) ? mode : "off",
    upcoming,
    recent,
    sourceStatus: Array.isArray(payload.sourceStatus) ? structuredClone(payload.sourceStatus) : [],
    quality: normalizeQuality(payload.quality)
  };
}

export function isFullAwarenessPayload(rawPayload = {}) {
  const payload = rawPayload?.awareness && typeof rawPayload.awareness === "object"
    ? rawPayload.awareness
    : rawPayload;
  return payload?.schemaVersion === AWARENESS_SCHEMA_VERSION &&
    Array.isArray(payload.upcoming) &&
    Array.isArray(payload.recent) &&
    Array.isArray(payload.sourceStatus) &&
    payload.quality && typeof payload.quality === "object";
}

function upsertIntoBuckets(upcomingById, recentById, event, bucket = null, now = Date.now()) {
  if (!event) {
    return;
  }
  const previous = upcomingById.get(event.eventId) || recentById.get(event.eventId);
  if (previous && previous.revision > event.revision) {
    return;
  }
  upcomingById.delete(event.eventId);
  recentById.delete(event.eventId);
  const scheduledMs = new Date(event.scheduledAt || 0).getTime();
  const target = bucket || (event.status === "scheduled" && Number.isFinite(scheduledMs) && scheduledMs > Number(now) ? "upcoming" : "recent");
  (target === "upcoming" ? upcomingById : recentById).set(event.eventId, event);
}

export function mergeAwarenessPayload(currentPayload = {}, rawIncoming = {}, { delta = false, now = Date.now() } = {}) {
  const incomingPayload = rawIncoming?.awareness && typeof rawIncoming.awareness === "object"
    ? rawIncoming.awareness
    : rawIncoming;
  const current = normalizeAwarenessPayload(currentPayload);
  if (!delta || isFullAwarenessPayload(incomingPayload)) {
    const replacement = normalizeAwarenessPayload(incomingPayload);
    return replacement.revision < current.revision ? current : replacement;
  }

  const incomingRevision = nonNegativeInteger(incomingPayload.revision);
  if (incomingRevision > 0 && incomingRevision < current.revision) {
    return current;
  }

  const upcomingById = new Map(current.upcoming.map((event) => [event.eventId, event]));
  const recentById = new Map(current.recent.map((event) => [event.eventId, event]));
  for (const event of deduplicateEvents(arrayValue(incomingPayload.upcoming))) {
    upsertIntoBuckets(upcomingById, recentById, event, "upcoming", now);
  }
  for (const event of deduplicateEvents(arrayValue(incomingPayload.recent))) {
    upsertIntoBuckets(upcomingById, recentById, event, "recent", now);
  }
  for (const event of deduplicateEvents([...arrayValue(incomingPayload.events), ...arrayValue(incomingPayload.upsert), ...(incomingPayload.event ? [incomingPayload.event] : [])])) {
    upsertIntoBuckets(upcomingById, recentById, event, null, now);
  }
  for (const eventId of cleanStringArray(incomingPayload.removedEventIds || incomingPayload.remove)) {
    upcomingById.delete(eventId);
    recentById.delete(eventId);
  }

  const mode = cleanString(incomingPayload.mode).toLowerCase();
  return {
    ...current,
    revision: Math.max(current.revision, nonNegativeInteger(incomingPayload.revision)),
    generatedAt: timestampOrNull(incomingPayload.generatedAt) || current.generatedAt,
    mode: AWARENESS_MODES.has(mode) ? mode : current.mode,
    upcoming: [...upcomingById.values()].sort(compareUpcoming),
    recent: [...recentById.values()].sort(compareRecent),
    sourceStatus: Array.isArray(incomingPayload.sourceStatus)
      ? structuredClone(incomingPayload.sourceStatus)
      : current.sourceStatus,
    quality: incomingPayload.quality && typeof incomingPayload.quality === "object"
      ? { ...current.quality, ...normalizeQuality({ ...current.quality, ...incomingPayload.quality }) }
      : current.quality
  };
}

export function awarenessEventKey(event = {}) {
  const eventId = cleanString(event.eventId || event.id);
  return eventId ? `${eventId}::${nonNegativeInteger(event.revision)}` : "";
}

export function normalizeAwarenessTab(value) {
  const tab = cleanString(value, "all").toLowerCase();
  return AWARENESS_TABS.has(tab) ? tab : "all";
}

export function eventMatchesAwarenessTab(event = {}, tab = "all") {
  const normalizedTab = normalizeAwarenessTab(tab);
  if (normalizedTab === "all") {
    return true;
  }
  const domains = new Set(cleanStringArray(event.domains).map((domain) => domain.toLowerCase()));
  const expectedDomains = normalizedTab === "markets" ? FINANCIAL_DOMAINS : GEOPOLITICAL_DOMAINS;
  return [...domains].some((domain) => expectedDomains.has(domain));
}

export function allAwarenessEvents(payload = {}) {
  const normalized = normalizeAwarenessPayload(payload);
  const byKey = new Map();
  for (const event of [...normalized.upcoming, ...normalized.recent]) {
    byKey.set(awarenessEventKey(event), event);
  }
  return [...byKey.values()];
}

export function safeCanonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function projectLocatedAwarenessEvents(payload = {}) {
  return allAwarenessEvents(payload)
    .filter((event) => {
      const location = event.location;
      return event.status !== "cancelled" && location &&
        Number.isFinite(location.lat) &&
        Number.isFinite(location.lng) &&
        !(location.lat === 0 && location.lng === 0) &&
        location.lat >= -90 && location.lat <= 90 &&
        location.lng >= -180 && location.lng <= 180 &&
        location.precision !== "none";
    })
    .map((event) => ({
      schemaVersion: "awareness-map-event-v1",
      eventId: event.eventId,
      revision: event.revision,
      kind: event.kind,
      domains: [...event.domains],
      status: event.status,
      title: event.title,
      canonicalUrl: safeCanonicalUrl(event.canonicalUrl),
      publishedAt: event.publishedAt,
      scheduledAt: event.scheduledAt,
      source: structuredClone(event.source),
      countries: [...event.countries],
      claimStatus: event.claimStatus,
      importance: event.importance,
      dataMode: event.dataMode,
      stale: event.dataMode === "stale" || event.provenance?.stale === true,
      location: {
        ...structuredClone(event.location),
        approximate: event.location.precision !== "exact"
      }
    }));
}
