import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAwarenessEventHtml, formatAwarenessCountdown, scheduledAlertThreshold } from "../../frontend/js/awareness.js";
import { applyUpdate, getState, setSnapshot } from "../../frontend/js/state.js";
import {
  AWARENESS_MAP_EVENT_NAME,
  awarenessEventKey,
  eventMatchesAwarenessTab,
  mergeAwarenessPayload,
  normalizeAwarenessEvent,
  projectLocatedAwarenessEvents,
  safeCanonicalUrl
} from "../../frontend/js/awarenessModel.js";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.resolve(backendDir, "../frontend");

function frontendFile(relativePath) {
  return readFile(path.join(frontendDir, relativePath), "utf8");
}

function awarenessEvent(overrides = {}) {
  return {
    schemaVersion: "awareness-event-v1",
    eventId: "fed-rate-2026-07-29",
    revision: 1,
    kind: "macro_scheduled",
    domains: ["financial", "macro"],
    status: "scheduled",
    title: "Federal Reserve interest-rate decision",
    summary: "Scheduled policy decision.",
    canonicalUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
    scheduledAt: "2026-07-29T18:00:00.000Z",
    publishedAt: null,
    observedAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    source: { sourceId: "fed", name: "Federal Reserve", role: "official", official: true, timezone: "America/New_York" },
    countries: ["US"],
    instrumentIds: [],
    sectors: [],
    assetClasses: ["rates"],
    importance: "high",
    importanceMethod: "rule-v1",
    location: null,
    claimStatus: "reported",
    provenance: { adapter: "calendar", sourceUrl: "https://www.federalreserve.gov/", fetchedAt: "2026-07-29T12:00:00.000Z", methodVersion: "v1", stale: false },
    dataMode: "observed",
    ...overrides
  };
}

function awarenessPayload({ upcoming = [], recent = [], revision = 1 } = {}) {
  return {
    schemaVersion: "awareness-v1",
    revision,
    generatedAt: "2026-07-29T12:00:00.000Z",
    mode: "visible",
    upcoming,
    recent,
    sourceStatus: [],
    quality: { total: upcoming.length + recent.length, scheduled: upcoming.length, released: recent.length, unlocated: 0, stale: 0 }
  };
}

test("awareness model uses top-level timestamps and stable eventId+revision preferences", () => {
  const event = normalizeAwarenessEvent(awarenessEvent({
    scheduledAt: "2026-07-29T18:00:00.000Z",
    times: { scheduledAt: "2027-01-01T00:00:00.000Z" }
  }));
  assert.equal(event.scheduledAt, "2026-07-29T18:00:00.000Z");
  assert.equal(awarenessEventKey(event), "fed-rate-2026-07-29::1");
  assert.equal(awarenessEventKey({ ...event, revision: 2 }), "fed-rate-2026-07-29::2");
  assert.equal(eventMatchesAwarenessTab(event, "markets"), true);
  assert.equal(eventMatchesAwarenessTab(event, "geopolitical"), false);
  assert.equal(eventMatchesAwarenessTab({ ...event, domains: ["security"] }, "geopolitical"), true);
  assert.equal(eventMatchesAwarenessTab({ ...event, domains: ["financial", "geopolitical"] }, "markets"), true);
  assert.equal(eventMatchesAwarenessTab({ ...event, domains: ["financial", "geopolitical"] }, "geopolitical"), true);
});

test("awareness deltas replace revisions and move released events into recent", () => {
  const current = awarenessPayload({ upcoming: [awarenessEvent()] });
  const released = awarenessEvent({
    revision: 2,
    status: "released",
    scheduledAt: "2026-07-29T18:00:00.000Z",
    publishedAt: "2026-07-29T18:02:00.000Z"
  });
  const merged = mergeAwarenessPayload(current, { revision: 2, event: released }, {
    delta: true,
    now: Date.parse("2026-07-29T18:03:00.000Z")
  });
  assert.equal(merged.upcoming.length, 0);
  assert.equal(merged.recent.length, 1);
  assert.equal(merged.recent[0].revision, 2);
  const afterStaleDelta = mergeAwarenessPayload(merged, {
    revision: 1,
    removedEventIds: [released.eventId]
  }, { delta: true });
  assert.equal(afterStaleDelta.recent.length, 1);
});

test("compact awareness state updates preserve full agenda arrays", () => {
  setSnapshot({ awareness: awarenessPayload({ upcoming: [awarenessEvent()], revision: 4 }) });
  applyUpdate({ awareness: {
    schemaVersion: "awareness-v1",
    revision: 5,
    generatedAt: "2026-07-29T13:00:00.000Z",
    mode: "visible",
    quality: { total: 2, scheduled: 1, released: 1, unlocated: 1, stale: 0 }
  } });
  const state = getState().awareness;
  assert.equal(state.revision, 5);
  assert.equal(state.upcoming.length, 1);
  assert.equal(state.quality.total, 2);
});

test("map projection excludes unlocated, none-precision and invalid-coordinate events", () => {
  const locatedSecurity = awarenessEvent({
    eventId: "security-1",
    kind: "official_security_release",
    domains: ["geopolitical", "security"],
    location: { lat: 25.2, lng: 55.3, label: "Dubai", precision: "city", method: "reported-coordinate", confidence: 0.8 },
    claimStatus: "source_asserted"
  });
  const payload = awarenessPayload({
    upcoming: [awarenessEvent()],
    recent: [
      locatedSecurity,
      awarenessEvent({ eventId: "cancelled", status: "cancelled", location: { lat: 1, lng: 2, precision: "exact" } }),
      awarenessEvent({ eventId: "none-precision", location: { lat: 1, lng: 2, precision: "none" } }),
      awarenessEvent({ eventId: "null-island", location: { lat: 0, lng: 0, precision: "exact" } }),
      awarenessEvent({ eventId: "invalid-coordinate", location: { lat: 120, lng: 2, precision: "exact" } })
    ]
  });
  const projection = projectLocatedAwarenessEvents(payload);
  assert.equal(AWARENESS_MAP_EVENT_NAME, "awareness:map-events:v1");
  assert.deepEqual(projection.map((event) => event.eventId), ["security-1"]);
  assert.equal(projection[0].location.precision, "city");
  assert.equal(projection[0].location.approximate, true);
  assert.equal(projection[0].stale, false);
});

test("null awareness coordinates never normalize into the zero point", () => {
  const normalized = normalizeAwarenessEvent(awarenessEvent({
    eventId: "region-only",
    location: { lat: null, lng: null, label: "Middle East", precision: "region", method: "explicit-region-text" }
  }));
  assert.equal(normalized.location.lat, null);
  assert.equal(normalized.location.lng, null);
  assert.deepEqual(projectLocatedAwarenessEvents(awarenessPayload({ recent: [normalized] })), []);
});

test("awareness cards escape content and only link safe canonical HTTP URLs", () => {
  const event = awarenessEvent({
    title: '<img src=x onerror="alert(1)">',
    summary: "<script>alert(1)</script>",
    source: { sourceId: "official", name: "Official & Source", role: "official", official: true, timezone: "America/New_York" },
    canonicalUrl: "https://example.com/release?q=one&view=full",
    claimStatus: "corroborated",
    location: { lat: 38.9, lng: -77, label: "Washington", precision: "exact", method: "official-coordinate", confidence: 1 }
  });
  const html = buildAwarenessEventHtml(event, {}, Date.parse("2026-07-29T17:00:00.000Z"));
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /Official &amp; Source/);
  assert.match(html, /official/);
  assert.match(html, /corroborated/);
  assert.match(html, /precision: exact/);
  assert.match(html, /Local \(/);
  assert.match(html, /Source TZ \(America\/New_York\)/);
  assert.match(html, /href="https:\/\/example\.com\/release\?q=one&amp;view=full"/);
  assert.equal(safeCanonicalUrl("javascript:alert(1)"), "");
  assert.equal(formatAwarenessCountdown(event, Date.parse("2026-07-29T17:00:00.000Z")), "en 1 h 0 min");
});

test("high scheduled alerts trigger only at T-60 and T-15 and remain revision-scoped", () => {
  const event = normalizeAwarenessEvent(awarenessEvent());
  assert.equal(scheduledAlertThreshold(event, {}, Date.parse("2026-07-29T16:59:00Z")), null);
  assert.equal(scheduledAlertThreshold(event, {}, Date.parse("2026-07-29T17:01:00Z")), "alertT60");
  assert.equal(scheduledAlertThreshold(event, { alertT60: true }, Date.parse("2026-07-29T17:46:00Z")), "alertT15");
  assert.equal(scheduledAlertThreshold(event, { alertT60: true, alertT15: true }, Date.parse("2026-07-29T17:50:00Z")), null);
  assert.equal(scheduledAlertThreshold({ ...event, importance: "medium" }, {}, Date.parse("2026-07-29T17:30:00Z")), null);
});

test("dashboard exposes the additive awareness REST, WS, inbox and map contracts", async () => {
  const [page, api, dashboard, state, awareness, model, map] = await Promise.all([
    frontendFile("index.html"),
    frontendFile("js/api.js"),
    frontendFile("js/dashboard.js"),
    frontendFile("js/state.js"),
    frontendFile("js/awareness.js"),
    frontendFile("js/awarenessModel.js"),
    frontendFile("js/map.js")
  ]);
  assert.match(page, /id="panel-awareness"/);
  assert.match(page, /data-awareness-tab="geopolitical">Geopolítica</);
  assert.match(page, /data-awareness-tab="markets">Mercados</);
  assert.match(page, /data-awareness-tab="all">Todos</);
  assert.match(page, /id="awareness-upcoming-list"/);
  assert.match(page, /id="awareness-recent-list"/);
  assert.match(page, /id="awareness-toast-region"/);
  assert.match(api, /getAwarenessSnapshot:[\s\S]*?\/api\/intel\/awareness-snapshot[\s\S]*?no-store/);
  assert.match(dashboard, /mountAwarenessCenter\(\{ api \}\)/);
  assert.match(dashboard, /message\.type === "awareness:update:v1"/);
  assert.match(state, /awareness:[\s\S]*?schemaVersion: "awareness-v1"/);
  assert.match(awareness, /if \(realtime && initialHydrationSettled\)/);
  assert.match(awareness, /if \(isBootstrap\) suppressBootstrapScheduleAlerts\(\)/);
  assert.match(awareness, /payload\?\.delivery\?\.backfill === true/);
  assert.match(awareness, /AWARENESS_PREFERENCES_KEY/);
  assert.match(model, /AWARENESS_MAP_EVENT_NAME = "awareness:map-events:v1"/);
  assert.match(model, /location\.precision !== "none"/);
  assert.match(dashboard, /addEventListener\("awareness:map-events:v1"/);
  assert.match(map, /setAwarenessEvents\(events = \[\]\)/);
  assert.match(map, /Official Releases/);
  assert.match(map, /Number\(lat\) === 0 && Number\(lng\) === 0/);
  assert.doesNotMatch(awareness, /bootstrap\.Toast/);
  assert.doesNotMatch(awareness, /new Notification|Notification\.requestPermission/);
});

test("admin awareness diagnostics distinguish admission, health, rolling polls and sanitized 403 evidence", async () => {
  const admin = await frontendFile("js/admin.js");
  assert.match(admin, /source\.admissionState/);
  assert.match(admin, /source\.window7d/);
  assert.match(admin, /source\.lastDiagnostic/);
  assert.match(admin, /diagnostic\.requestId/);
  assert.match(admin, /diagnostic\.bodySha256/);
  assert.doesNotMatch(admin, /diagnostic\.body\b/);
});
