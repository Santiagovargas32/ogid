import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAwarenessEvent } from "../services/awareness/awarenessParsers.js";
import { AwarenessStore } from "../services/awareness/awarenessStore.js";
import { sourceEventTiming } from "../services/awareness/awarenessEventTime.js";

const source = {
  sourceId: "awareness-fed-calendar",
  name: "Federal Reserve Calendar",
  url: "https://www.federalreserve.gov/newsevents/calendar.htm",
  adapter: "fed-calendar-html",
  kind: "macro_scheduled",
  domains: ["financial", "macro"],
  timezone: "America/New_York",
  role: "official",
  official: true
};

test("old calendar metadata is repaired in projections without rewriting stored events", () => {
  const store = new AwarenessStore({ now: () => Date.parse("2026-10-05T19:00:00Z") });
  store.registerSources([source]);
  store.reconcile([createAwarenessEvent({ source, rawId: "schedule", title: "FOMC minutes", scheduledAt: "2026-10-07T18:00:00Z" })]);
  store.updateSourceStatus(source.sourceId, { latestEventAt: "1999-12-31T23:00:00Z", lagMs: 999999 });
  const { sourceStatus } = store.getSnapshot({ mode: "visible", filters: { from: "2026-12-01T00:00:00Z" } });
  assert.equal(sourceStatus[0].latestEventAt, "2026-10-07T18:00:00.000Z");
  assert.equal(sourceStatus[0].latestEventTimeKind, "scheduledAt");
  assert.equal(sourceStatus[0].lagMs, null);
  assert.equal(store.sourceStatuses.get(source.sourceId).latestEventAt, "1999-12-31T23:00:00Z");
  assert.deepEqual(sourceEventTiming([{ publishedAt: null }, { publishedAt: "bad", scheduledAt: "bad" }]), { latestEventAt: null, latestEventTimeKind: null, lagMs: null });
});

test("the same official release has one projection, preserves attribution and repairs Fed classification", () => {
  const directSource = { ...source, sourceId: "awareness-fed-releases", kind: "macro_release", adapter: "rss" };
  const title = "Federal Reserve Board announces approval of application";
  const canonicalUrl = "https://www.federalreserve.gov/newsevents/pressreleases/orders20261005a.htm";
  const direct = createAwarenessEvent({ source: directSource, title, canonicalUrl, publishedAt: "2026-10-05T20:30:00Z" });
  assert.equal(direct.kind, "regulatory_filing");
  const legacy = { ...direct, kind: "macro_release" };
  const derived = { ...direct, eventId: "derived", source: { ...direct.source, sourceId: "rss-fed" }, instrumentIds: ["test-instrument"] };
  for (const records of [[derived, legacy], [legacy, derived]]) {
    const store = new AwarenessStore({ now: () => Date.parse("2026-10-05T21:00:00Z") });
    store.registerSources([directSource]);
    store.reconcile(records);
    const snapshot = store.getSnapshot({ mode: "visible", filters: { kinds: ["regulatory_filing"] } });
    assert.equal(snapshot.recent.length, 1);
    assert.equal(snapshot.quality.total, 1);
    assert.equal(snapshot.recent[0].source.sourceId, directSource.sourceId);
    assert.deepEqual(snapshot.recent[0].relatedSources, [directSource.sourceId, "rss-fed"]);
    assert.deepEqual(snapshot.recent[0].instrumentIds, ["test-instrument"]);
    assert.equal(store.events.size, 2);
    assert.equal(store.events.get(legacy.eventId).kind, "macro_release");
    assert.equal(store.getSnapshot({ mode: "visible", filters: { kinds: ["macro_release"] } }).recent.length, 0);
  }
});

test("release deduplication cannot merge shadow enrichment, schedules or different publications", () => {
  const store = new AwarenessStore({ now: () => Date.parse("2026-10-05T19:00:00Z") });
  const active = { ...source, sourceId: "active", kind: "macro_release", admissionState: "active" };
  const shadow = { ...active, sourceId: "shadow", admissionState: "shadow" };
  store.registerSources([active, shadow]);
  const event = createAwarenessEvent({ source: active, rawId: "release", title: "Release", canonicalUrl: "https://example.org/releases", publishedAt: "2026-10-05T18:00:00Z" });
  store.reconcile([event, { ...event, eventId: "shadow-copy", source: { ...event.source, sourceId: "shadow" }, instrumentIds: ["must-not-leak"] },
    { ...event, eventId: "older", publishedAt: "2026-10-04T18:00:00Z" },
    { ...event, eventId: "schedule", status: "scheduled", scheduledAt: "2026-10-06T18:00:00Z", publishedAt: null }]);
  const snapshot = store.getSnapshot({ mode: "visible" });
  assert.equal(snapshot.recent.length, 2);
  assert.equal(snapshot.upcoming.length, 1);
  assert.equal(JSON.stringify(snapshot).includes("must-not-leak"), false);
  assert.equal(store.getSnapshot({ mode: "visible", publicView: false }).recent.length, 3);
});

test("awareness store deduplicates, correlates scheduled releases and persists monotonic revisions", () => {
  const root = mkdtempSync(join(tmpdir(), "awareness-store-"));
  let nowMs = Date.parse("2026-07-28T12:00:00.000Z");
  const options = { snapshotPath: join(root, "snapshot.json"), auditPath: join(root, "audit.jsonl"), now: () => nowMs };
  const store = new AwarenessStore(options);
  store.registerSources([source]);
  const scheduled = createAwarenessEvent({ source, rawId: "fomc-july", title: "FOMC Interest Rate Decision", canonicalUrl: source.url, scheduledAt: "2026-07-29T18:00:00.000Z", observedAt: new Date(nowMs).toISOString() });
  assert.equal(scheduled.correlationKey, "fed-fomc:2026-07-29");

  assert.equal(store.reconcile([scheduled], { sourceId: source.sourceId }).changed.length, 1);
  assert.equal(store.reconcile([scheduled], { sourceId: source.sourceId }).deduplicated, 1);
  nowMs += 24 * 60 * 60_000;
  const releaseSource = { ...source, sourceId: "awareness-fed-releases", adapter: "rss", kind: "macro_release" };
  const released = createAwarenessEvent({ source: releaseSource, rawId: "press-123", title: "FOMC Interest Rate Decision", canonicalUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm", publishedAt: "2026-07-29T18:00:00.000Z", observedAt: new Date(nowMs).toISOString() });
  const result = store.reconcile([released], { sourceId: releaseSource.sourceId });
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].eventId, scheduled.eventId);
  assert.equal(result.changed[0].status, "released");
  assert.equal(result.changed[0].revision, 2);
  assert.deepEqual(result.changed[0].relatedSources, [source.sourceId, releaseSource.sourceId]);
  assert.equal(store.reconcile([released], { sourceId: releaseSource.sourceId }).deduplicated, 1);
  assert.equal(store.reconcile([scheduled], { sourceId: source.sourceId }).deduplicated, 1);

  const rehydrated = new AwarenessStore(options);
  const snapshot = rehydrated.getSnapshot({ mode: "visible" });
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].eventId, scheduled.eventId);
  assert.equal(snapshot.recent[0].status, "released");

  const revisedRelease = createAwarenessEvent({ source: releaseSource, rawId: "press-456", title: "Federal Reserve Interest Rate Decision", canonicalUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729b.htm", publishedAt: "2026-07-29T18:01:00.000Z", observedAt: new Date(nowMs).toISOString() });
  const correlatedAfterHydration = rehydrated.reconcile([revisedRelease], { sourceId: releaseSource.sourceId });
  assert.equal(correlatedAfterHydration.changed.length, 1);
  assert.equal(correlatedAfterHydration.changed[0].eventId, scheduled.eventId);
  assert.equal(rehydrated.getSnapshot({ mode: "visible" }).recent.length, 1);
});

test("public shadow projection is empty while admin quality counts null coordinates as unlocated", () => {
  const nowMs = Date.parse("2026-07-29T20:00:00.000Z");
  const store = new AwarenessStore({ now: () => nowMs });
  const event = createAwarenessEvent({ source, rawId: "fomc", title: "FOMC Interest Rate Decision", canonicalUrl: source.url, publishedAt: "2026-07-29T18:00:00.000Z", observedAt: new Date(nowMs).toISOString(), location: { lat: null, lng: null, label: "United States", precision: "country" } });
  store.reconcile([event]);

  const hidden = store.getSnapshot({ mode: "shadow", publicView: true });
  assert.deepEqual(hidden.recent, []);
  assert.equal(hidden.quality.total, 1);
  const admin = store.getSnapshot({ mode: "shadow", publicView: false });
  assert.equal(admin.recent.length, 1);
  assert.equal(admin.quality.unlocated, 1);
  assert.equal(admin.recent.some((item) => Number(item.location?.lat) === 0 && Number(item.location?.lng) === 0), true);
  assert.equal(admin.recent.some((item) => item.location?.lat === 0 || item.location?.lng === 0), false);
});

test("awareness filters are additive and bounded", () => {
  const nowMs = Date.parse("2026-07-29T20:00:00.000Z");
  const store = new AwarenessStore({ now: () => nowMs });
  const event = createAwarenessEvent({ source, rawId: "fomc", title: "FOMC Interest Rate Decision", canonicalUrl: source.url, publishedAt: "2026-07-29T18:00:00.000Z", observedAt: new Date(nowMs).toISOString() });
  event.instrumentIds = ["us-index-sp500"];
  event.countries = ["US"];
  store.reconcile([event]);
  assert.equal(store.getSnapshot({ mode: "visible", filters: { domain: "financial", countries: "US", instrumentIds: "us-index-sp500", from: "2026-07-29T17:00:00Z", to: "2026-07-29T19:00:00Z" } }).recent.length, 1);
  assert.equal(store.getSnapshot({ mode: "visible", filters: { countries: "IR" } }).recent.length, 0);
});

test("snapshot limits do not misclassify overflow future events as recent", () => {
  const nowMs = Date.parse("2026-07-29T12:00:00.000Z");
  const store = new AwarenessStore({ now: () => nowMs });
  const first = createAwarenessEvent({ source, rawId: "future-1", title: "FOMC Interest Rate Decision", canonicalUrl: source.url, scheduledAt: "2026-07-29T18:00:00Z", observedAt: new Date(nowMs).toISOString() });
  const second = createAwarenessEvent({ source, rawId: "future-2", title: "FOMC Press Conference", canonicalUrl: source.url, scheduledAt: "2026-07-29T18:30:00Z", observedAt: new Date(nowMs).toISOString() });
  const released = createAwarenessEvent({ source: { ...source, sourceId: "released-source", kind: "market_moving_news" }, rawId: "released", title: "Market update", canonicalUrl: source.url, publishedAt: "2026-07-29T11:00:00Z", observedAt: new Date(nowMs).toISOString() });
  store.reconcile([first, second, released]);

  const snapshot = store.getSnapshot({ mode: "visible", filters: { limit: 1 } });
  assert.deepEqual(snapshot.upcoming.map((event) => event.eventId), [first.eventId]);
  assert.deepEqual(snapshot.recent.map((event) => event.eventId), [released.eventId]);
  assert.equal(snapshot.quality.total, 3);
  assert.equal(snapshot.quality.unlocated, 3);
});

test("stale-on-error transitions are explicit, revisioned and recoverable", () => {
  const nowMs = Date.parse("2026-07-29T20:00:00.000Z");
  const store = new AwarenessStore({ now: () => nowMs });
  const event = createAwarenessEvent({ source, rawId: "fomc", title: "FOMC Interest Rate Decision", canonicalUrl: source.url, publishedAt: "2026-07-29T18:00:00.000Z", observedAt: new Date(nowMs).toISOString() });
  store.reconcile([event]);
  const stale = store.setSourceStale(source.sourceId, true);
  assert.equal(stale.changed.length, 1);
  assert.equal(stale.changed[0].dataMode, "stale");
  assert.equal(store.getSnapshot({ mode: "visible" }).quality.stale, 1);
  const fresh = store.setSourceStale(source.sourceId, false);
  assert.equal(fresh.changed[0].dataMode, "observed");
  assert.equal(fresh.changed[0].revision, 3);
});

test("a source observation timestamp alone does not manufacture event revisions", () => {
  const store = new AwarenessStore({ now: () => Date.parse("2026-07-29T20:00:00.000Z") });
  const releaseSource = { ...source, sourceId: "awareness-idf-releases", adapter: "idf-html", kind: "official_security_release" };
  const first = createAwarenessEvent({
    source: releaseSource,
    rawId: "undated-release",
    title: "Official operational update",
    canonicalUrl: "https://www.idf.il/en/mini-sites/example",
    observedAt: "2026-07-29T19:00:00.000Z"
  });
  const second = createAwarenessEvent({
    source: releaseSource,
    rawId: "undated-release",
    title: "Official operational update",
    canonicalUrl: "https://www.idf.il/en/mini-sites/example",
    observedAt: "2026-07-29T19:05:00.000Z"
  });

  assert.equal(store.reconcile([first]).changed.length, 1);
  assert.equal(store.reconcile([second]).deduplicated, 1);
  assert.equal(store.getSnapshot({ mode: "visible" }).revision, 1);
});

test("poll history persists separately for seven days and exposes only rolling diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "awareness-polls-"));
  const snapshotPath = join(root, "snapshot.json");
  const pollAuditPath = join(root, "polls.jsonl");
  let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  const options = { snapshotPath, pollAuditPath, now: () => nowMs };
  const store = new AwarenessStore(options);
  store.registerSources([{ ...source, admissionState: "active" }]);
  store.recordPoll(source.sourceId, {
    attemptedAt: new Date(nowMs).toISOString(),
    completedAt: new Date(nowMs + 25).toISOString(),
    outcome: "ok",
    httpStatus: 200,
    latencyMs: 25,
    parsed: 2,
    diagnostic: {
      headers: { "content-type": "application/xml", "set-cookie": "must-not-persist" },
      contentType: "application/xml",
      requestId: "poll-old",
      bodySha256: "a".repeat(64),
      bodyBytes: 10,
      body: "must-not-persist"
    }
  });
  nowMs += 6 * 24 * 60 * 60_000;
  store.recordPoll(source.sourceId, {
    attemptedAt: new Date(nowMs).toISOString(),
    completedAt: new Date(nowMs + 50).toISOString(),
    outcome: "error",
    httpStatus: 503,
    latencyMs: 50,
    error: "awareness-upstream-503"
  });

  let admin = store.getSnapshot({ mode: "visible", publicView: false });
  assert.equal(admin.sourceStatus[0].window7d.attempts, 2);
  assert.equal(admin.sourceStatus[0].window7d.successRate, 0.5);
  assert.equal(Object.hasOwn(admin.sourceStatus[0], "pollHistory"), false);
  const publicSnapshot = store.getSnapshot({ mode: "visible", publicView: true });
  assert.equal(Object.hasOwn(publicSnapshot.sourceStatus[0], "lastPoll"), false);
  assert.equal(Object.hasOwn(publicSnapshot.sourceStatus[0], "lastDiagnostic"), false);
  assert.equal(readFileSync(snapshotPath, "utf8").includes("pollHistory"), false);
  const persistedPolls = readFileSync(pollAuditPath, "utf8");
  assert.equal(persistedPolls.includes("must-not-persist"), false);
  assert.equal(persistedPolls.trim().split(/\r?\n/).length, 2);

  nowMs += 2 * 24 * 60 * 60_000;
  const rehydrated = new AwarenessStore(options);
  rehydrated.registerSources([{ ...source, admissionState: "active" }]);
  admin = rehydrated.getSnapshot({ mode: "visible", publicView: false });
  assert.equal(admin.sourceStatus[0].window7d.attempts, 1);
  assert.equal(rehydrated.getPollHistory(source.sourceId).length, 1);
  assert.equal(rehydrated.getPollHistory(source.sourceId)[0].httpStatus, 503);
  const compactedPolls = readFileSync(pollAuditPath, "utf8");
  assert.equal(compactedPolls.includes("poll-old"), false);
  assert.equal(compactedPolls.trim().split(/\r?\n/).length, 1);
});

test("per-source shadow events remain available to admins but not public snapshots", () => {
  const nowMs = Date.parse("2026-07-29T20:00:00.000Z");
  const shadowSource = { ...source, admissionState: "shadow", enabled: true };
  const store = new AwarenessStore({ now: () => nowMs });
  store.registerSources([shadowSource]);
  const event = createAwarenessEvent({
    source: shadowSource,
    rawId: "shadow-release",
    title: "Shadow admission release",
    canonicalUrl: source.url,
    publishedAt: "2026-07-29T18:00:00.000Z",
    observedAt: new Date(nowMs).toISOString()
  });
  store.reconcile([event], { sourceId: shadowSource.sourceId });

  assert.equal(store.getSnapshot({ mode: "visible", publicView: false }).recent.length, 1);
  assert.equal(store.getSnapshot({ mode: "visible", publicView: true }).recent.length, 0);
  assert.equal(store.getSnapshot({ mode: "visible", publicView: true }).sourceStatus.length, 0);
});

test("macro correlation cannot merge a shadow issuer into an active scheduled event", () => {
  const nowMs = Date.parse("2026-07-29T12:00:00.000Z");
  const fedSource = { ...source, admissionState: "active" };
  const ecbSource = {
    ...source,
    sourceId: "awareness-ecb-rss",
    name: "European Central Bank",
    url: "https://www.ecb.europa.eu/rss/press.html",
    adapter: "rss",
    kind: "macro_release",
    admissionState: "shadow"
  };
  const store = new AwarenessStore({ now: () => nowMs });
  store.registerSources([fedSource, ecbSource]);
  const scheduled = createAwarenessEvent({
    source: fedSource,
    rawId: "fed-rate",
    title: "Interest Rate Decision",
    canonicalUrl: fedSource.url,
    scheduledAt: "2026-07-29T18:00:00Z",
    observedAt: new Date(nowMs).toISOString()
  });
  const shadowRelease = createAwarenessEvent({
    source: ecbSource,
    rawId: "ecb-rate",
    title: "Interest Rate Decision",
    canonicalUrl: ecbSource.url,
    publishedAt: "2026-07-29T18:00:00Z",
    observedAt: new Date(nowMs).toISOString()
  });
  // Force a collision to verify the admission boundary independently of issuer-aware keys.
  shadowRelease.correlationKey = scheduled.correlationKey;
  store.reconcile([scheduled], { sourceId: fedSource.sourceId });
  store.reconcile([shadowRelease], { sourceId: ecbSource.sourceId });

  const admin = store.getSnapshot({ mode: "visible", publicView: false });
  assert.equal(admin.upcoming.length + admin.recent.length, 2);
  const publicSnapshot = store.getSnapshot({ mode: "visible", publicView: true });
  assert.equal(publicSnapshot.upcoming.length, 1);
  assert.equal(publicSnapshot.upcoming[0].source.sourceId, fedSource.sourceId);
  assert.equal(publicSnapshot.recent.length, 0);
});
