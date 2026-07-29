import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AWARENESS_DEFAULT_USER_AGENT, AwarenessService, financialEventFromArticle, jitteredInterval, resolveSourceRequestUrl } from "../services/awareness/awarenessService.js";
import { createAwarenessEvent } from "../services/awareness/awarenessParsers.js";
import { AwarenessStore } from "../services/awareness/awarenessStore.js";

const rssSource = {
  sourceId: "awareness-fed-releases",
  name: "Federal Reserve Press Releases",
  url: "https://www.federalreserve.gov/feeds/press_all.xml",
  hostname: "www.federalreserve.gov",
  adapter: "rss",
  kind: "macro_release",
  domains: ["financial", "macro"],
  timezone: "America/New_York",
  minPollIntervalMs: 300_000,
  adaptivePollIntervalMs: 60_000,
  priority: 100,
  tier: "P0",
  enabled: true,
  role: "official",
  official: true
};

const rss = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>FOMC Interest Rate Decision</title><description>Official monetary policy statement.</description><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm</link><pubDate>Wed, 29 Jul 2026 18:00:00 GMT</pubDate></item></channel></rss>`;

test("Fed calendar resolves official current and next monthly pages without a third-party calendar", () => {
  const source = { url: "https://www.federalreserve.gov/newsevents/calendar.htm", urlStrategy: "fed-month", timezone: "America/New_York" };
  assert.equal(resolveSourceRequestUrl({ ...source, monthOffset: 0 }, Date.parse("2026-07-31T23:00:00Z")), "https://www.federalreserve.gov/newsevents/2026-july.htm");
  assert.equal(resolveSourceRequestUrl({ ...source, monthOffset: 1 }, Date.parse("2026-07-31T23:00:00Z")), "https://www.federalreserve.gov/newsevents/2026-august.htm");
  assert.equal(resolveSourceRequestUrl({ ...source, monthOffset: 1 }, Date.parse("2026-12-15T12:00:00Z")), "https://www.federalreserve.gov/newsevents/2027-january.htm");
});

test("awareness cadence jitter stays within a bounded ten-percent envelope", () => {
  assert.equal(jitteredInterval(300_000, () => 0), 270_000);
  assert.equal(jitteredInterval(300_000, () => 0.5), 300_000);
  assert.equal(jitteredInterval(300_000, () => 1), 330_000);
});

test("financial awareness identity remains stable when provider result order changes", () => {
  const baseArticle = {
    provider: "newsapi",
    sourceName: "Market Wire",
    sourceRole: "editorial",
    title: "Federal Reserve issues interest rate decision",
    description: "Official FOMC release.",
    url: "https://example.com/fomc-release",
    publishedAt: "2026-07-29T18:00:00.000Z",
    financial: { domains: ["macro"], importance: { band: "high" } }
  };
  const first = financialEventFromArticle({ ...baseArticle, id: "provider-result-1" }, "2026-07-29T18:01:00.000Z");
  const reordered = financialEventFromArticle({ ...baseArticle, id: "provider-result-7" }, "2026-07-29T18:06:00.000Z");

  assert.equal(first.eventId, reordered.eventId);
  assert.equal(first.provenance.sourceArticleId, "provider-result-1");
  assert.equal(reordered.provenance.sourceArticleId, "provider-result-7");
  const store = new AwarenessStore();
  assert.equal(store.reconcile([first]).changed.length, 1);
  assert.equal(store.reconcile([reordered]).deduplicated, 1);
});

test("one hybrid awareness event belongs to both market and geopolitical tabs", () => {
  const event = financialEventFromArticle({
    id: "hybrid-1",
    provider: "rss",
    sourceName: "Official Wire",
    sourceRole: "official",
    title: "Sanctions follow missile attack in Iran",
    description: "The action freezes assets after the attack.",
    url: "https://example.com/hybrid",
    publishedAt: "2026-07-29T18:00:00.000Z",
    conflict: { totalWeight: 5 },
    financial: { domains: ["regulatory"], importance: { band: "high" } }
  });

  assert.equal(event.domains.includes("financial"), true);
  assert.equal(event.domains.includes("geopolitical"), true);
});

test("adaptive polling remains active from T-5 through T+30 without mutating scheduled status", () => {
  const scheduledMs = Date.parse("2026-07-29T18:00:00.000Z");
  let nowMs = scheduledMs - 2 * 60_000;
  const store = new AwarenessStore({ now: () => nowMs });
  const calendarSource = { ...rssSource, sourceId: "awareness-fed-calendar", kind: "macro_scheduled" };
  store.reconcile([createAwarenessEvent({
    source: calendarSource,
    rawId: "fomc-july",
    title: "FOMC Interest Rate Decision",
    canonicalUrl: calendarSource.url,
    scheduledAt: new Date(scheduledMs).toISOString(),
    observedAt: new Date(nowMs).toISOString()
  })]);
  const service = new AwarenessService({ mode: "shadow", store, sources: [rssSource], now: () => nowMs });

  assert.equal(service.effectiveInterval(rssSource), 60_000);
  nowMs = scheduledMs + 10 * 60_000;
  assert.equal(service.getAdminSnapshot().recent[0].status, "scheduled");
  assert.equal(service.effectiveInterval(rssSource), 60_000);
  nowMs = scheduledMs + 31 * 60_000;
  assert.equal(service.effectiveInterval(rssSource), 300_000);
});

test("off mode performs no request and exposes an empty public contract", async () => {
  let calls = 0;
  const store = new AwarenessStore({ now: () => Date.parse("2026-07-29T18:01:00Z") });
  const service = new AwarenessService({ mode: "off", store, sources: [rssSource], fetchImpl: async () => { calls += 1; throw new Error("must-not-call"); } });
  const result = await service.runCycle("test");
  assert.equal(result.status, "disabled");
  assert.equal(calls, 0);
  assert.equal(result.snapshot.mode, "off");
  assert.deepEqual(result.snapshot.recent, []);
});

test("probing admission is lab-only and cannot be polled by the runtime service", async () => {
  let calls = 0;
  const probingSource = { ...rssSource, admissionState: "probing", enabled: false };
  const service = new AwarenessService({
    mode: "visible",
    store: new AwarenessStore(),
    sources: [probingSource],
    fetchImpl: async () => {
      calls += 1;
      return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
  });

  const result = await service.pollSource(probingSource);
  assert.equal(result.status, "probing");
  assert.equal(result.error, "awareness-source-not-scheduled");
  assert.equal(calls, 0);
});

test("visible mode honors validators, emits revisions and resets circuit errors after success", async () => {
  let calls = 0;
  const broadcasts = [];
  const nowMs = Date.parse("2026-07-29T18:01:00Z");
  const store = new AwarenessStore({ now: () => nowMs });
  const service = new AwarenessService({
    mode: "visible",
    store,
    sources: [rssSource],
    now: () => nowMs,
    socketServer: { broadcast: (...args) => broadcasts.push(args) },
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers["User-Agent"], AWARENESS_DEFAULT_USER_AGENT);
      if (calls === 1) return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml", etag: '"fixture-v1"' } });
      assert.equal(options.headers["If-None-Match"], '"fixture-v1"');
      return new Response(null, { status: 304 });
    }
  });

  const first = await service.runCycle("test-visible");
  assert.equal(first.status, "ok");
  assert.equal(first.snapshot.recent.length, 1);
  assert.equal(first.snapshot.revision, 1);
  assert.equal(broadcasts[0][0], "awareness:update:v1");
  assert.deepEqual(broadcasts[0][1].delivery, { backfill: false, trigger: "test-visible" });
  const second = await service.pollSource(rssSource);
  assert.equal(second.status, "not-modified");
  const status = service.getAdminSnapshot().sourceStatus[0];
  assert.equal(status.httpStatus, 304);
  assert.equal(status.consecutiveErrors, 0);
  assert.equal(status.attempts, 2);
  assert.equal(status.successes, 2);
});

test("scheduler polls active and shadow admissions while shadow results stay unpublished and analysis-isolated", async () => {
  const nowMs = Date.parse("2026-07-29T18:01:00Z");
  const shadowSource = { ...rssSource, sourceId: "awareness-shadow-fixture", admissionState: "shadow" };
  const probingSource = { ...rssSource, sourceId: "awareness-probing-fixture", admissionState: "probing", enabled: false };
  const blockedSource = { ...rssSource, sourceId: "awareness-blocked-fixture", admissionState: "blocked", enabled: false };
  const broadcasts = [];
  let calls = 0;
  const service = new AwarenessService({
    mode: "visible",
    store: new AwarenessStore({ now: () => nowMs }),
    sources: [shadowSource, probingSource, blockedSource],
    now: () => nowMs,
    socketServer: { broadcast: (...args) => broadcasts.push(args) },
    fetchImpl: async () => {
      calls += 1;
      return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
  });

  assert.deepEqual(service.eligibleSources().map((source) => source.sourceId), [shadowSource.sourceId]);
  const result = await service.runCycle("shadow-source-test");
  assert.equal(result.status, "ok");
  assert.equal(calls, 1);
  assert.equal(service.getAdminSnapshot().recent.length, 1);
  assert.equal(service.getSnapshot().recent.length, 0);
  assert.deepEqual(service.getMarketArticles(), []);
  assert.deepEqual(service.getGeopoliticalArticles(), []);
  assert.equal(broadcasts.length, 0);
});

test("persistent 403 responses are sanitized, cooled down and permanently blocked before a fourth call", async () => {
  const nowMs = Date.parse("2026-07-29T18:01:00Z");
  const root = mkdtempSync(join(tmpdir(), "awareness-403-"));
  const snapshotPath = join(root, "snapshot.json");
  const pollAuditPath = join(root, "polls.jsonl");
  const body = "blocked challenge body that must never be stored";
  let calls = 0;
  const store = new AwarenessStore({ snapshotPath, pollAuditPath, now: () => nowMs });
  const service = new AwarenessService({
    mode: "shadow",
    store,
    sources: [rssSource],
    now: () => nowMs,
    forbiddenCooldownMs: 3_600_000,
    persistent403Threshold: 3,
    fetchImpl: async () => {
      calls += 1;
      return new Response(body, {
        status: 403,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-request-id": "request-403-fixture",
          server: "edge-fixture",
          "set-cookie": "sensitive-cookie=never-persist"
        }
      });
    }
  });
  const first = await service.pollSource(rssSource);
  const firstStatus = service.getAdminSnapshot().sourceStatus[0];
  assert.ok(Date.parse(firstStatus.nextEligibleAt) - nowMs >= 3_600_000);
  const second = await service.pollSource(rssSource);
  const third = await service.pollSource(rssSource);
  const fourth = await service.pollSource(rssSource);
  assert.equal(first.status, "error");
  assert.equal(second.status, "error");
  assert.equal(third.status, "blocked");
  assert.equal(fourth.status, "blocked");
  assert.equal(calls, 3);
  const status = service.getAdminSnapshot().sourceStatus[0];
  assert.equal(status.status, "blocked");
  assert.equal(status.admissionState, "blocked");
  assert.equal(status.runtimeBlocked, true);
  assert.equal(status.blockedReason, "persistent-http-403");
  assert.equal(status.stale, true);
  assert.equal(status.httpStatus, 403);
  assert.match(status.error, /awareness-upstream-403/);
  assert.equal(status.nextEligibleAt, null);
  assert.equal(status.window7d.attempts, 3);
  assert.equal(status.window7d.forbidden, 3);
  assert.equal(status.lastDiagnostic.requestId, "request-403-fixture");
  assert.equal(status.lastDiagnostic.contentType, "text/html; charset=utf-8");
  assert.equal(status.lastDiagnostic.bodySha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(status.lastDiagnostic.bodyBytes, Buffer.byteLength(body));
  assert.deepEqual(status.lastDiagnostic.headers, {
    "content-type": "text/html; charset=utf-8",
    server: "edge-fixture",
    "x-request-id": "request-403-fixture"
  });
  const persisted = `${readFileSync(snapshotPath, "utf8")}\n${readFileSync(pollAuditPath, "utf8")}`;
  assert.equal(persisted.includes(body), false);
  assert.equal(persisted.includes("sensitive-cookie"), false);

  let restartCalls = 0;
  const restarted = new AwarenessService({
    mode: "shadow",
    store: new AwarenessStore({ snapshotPath, pollAuditPath, now: () => nowMs }),
    sources: [rssSource],
    now: () => nowMs,
    fetchImpl: async () => { restartCalls += 1; throw new Error("must-not-call"); }
  });
  assert.equal((await restarted.pollSource(rssSource)).status, "blocked");
  assert.equal(restartCalls, 0);
});

test("legacy cumulative 403 state migrates to a persistent admission block before polling", async () => {
  const nowMs = Date.parse("2026-07-29T18:01:00Z");
  const store = new AwarenessStore({ now: () => nowMs });
  store.registerSources([rssSource]);
  store.updateSourceStatus(rssSource.sourceId, {
    status: "unhealthy",
    httpStatus: 403,
    consecutiveErrors: 3,
    lastAttemptAt: "2026-07-29T17:59:00.000Z"
  });
  let calls = 0;
  const service = new AwarenessService({
    mode: "shadow",
    store,
    sources: [rssSource],
    now: () => nowMs,
    persistent403Threshold: 3,
    fetchImpl: async () => { calls += 1; throw new Error("must-not-call"); }
  });

  const status = service.getAdminSnapshot().sourceStatus[0];
  assert.equal(status.admissionState, "blocked");
  assert.equal(status.runtimeBlocked, true);
  assert.equal(status.nextEligibleAt, null);
  assert.equal((await service.pollSource(rssSource)).status, "blocked");
  assert.equal(calls, 0);
});

test("a parser that becomes empty marks previously observed source events stale", async () => {
  const nowMs = Date.parse("2026-07-29T18:01:00Z");
  let calls = 0;
  const store = new AwarenessStore({ now: () => nowMs });
  const service = new AwarenessService({
    mode: "shadow",
    store,
    sources: [rssSource],
    now: () => nowMs,
    fetchImpl: async () => new Response(calls++ === 0 ? rss : "<rss><channel></channel></rss>", {
      status: 200,
      headers: { "content-type": "application/rss+xml" }
    })
  });

  assert.equal((await service.pollSource(rssSource)).status, "ok");
  const empty = await service.pollSource(rssSource);
  assert.equal(empty.status, "error");
  assert.equal(empty.error, "awareness-parser-empty-after-data");
  const snapshot = service.getAdminSnapshot();
  assert.equal(snapshot.sourceStatus[0].stale, true);
  assert.equal(snapshot.recent[0].dataMode, "stale");
});

test("an empty-valid source records a successful poll without stale or fabricated events", async () => {
  const nowMs = Date.parse("2026-07-29T18:01:00Z");
  const emptyValidSource = { ...rssSource, sourceId: "awareness-empty-valid", emptyResultPolicy: "healthy" };
  const service = new AwarenessService({
    mode: "shadow",
    store: new AwarenessStore({ now: () => nowMs }),
    sources: [emptyValidSource],
    now: () => nowMs,
    fetchImpl: async () => new Response("<rss><channel></channel></rss>", {
      status: 200,
      headers: { "content-type": "application/rss+xml" }
    })
  });

  const result = await service.pollSource(emptyValidSource);
  assert.equal(result.status, "empty-valid");
  const snapshot = service.getAdminSnapshot();
  assert.equal(snapshot.recent.length, 0);
  assert.equal(snapshot.sourceStatus[0].status, "healthy");
  assert.equal(snapshot.sourceStatus[0].stale, false);
  assert.equal(snapshot.sourceStatus[0].successes, 1);
  assert.equal(snapshot.sourceStatus[0].window7d.successes, 1);
  assert.equal(snapshot.sourceStatus[0].window7d.emptyValid, 1);
});

test("awareness fetch rejects missing MIME metadata and oversized responses", async () => {
  const nowMs = Date.parse("2026-07-29T18:01:00Z");
  const missingMime = new AwarenessService({
    mode: "shadow",
    store: new AwarenessStore({ now: () => nowMs }),
    sources: [rssSource],
    now: () => nowMs,
    fetchImpl: async () => new Response(new Uint8Array([60, 114, 115, 115, 62]), { status: 200 })
  });
  assert.equal((await missingMime.pollSource(rssSource)).error, "awareness-content-type-invalid");

  const oversized = new AwarenessService({
    mode: "shadow",
    store: new AwarenessStore({ now: () => nowMs }),
    sources: [rssSource],
    now: () => nowMs,
    fetchImpl: async () => new Response(rss, {
      status: 200,
      headers: { "content-type": "application/rss+xml", "content-length": "1000001" }
    })
  });
  assert.equal((await oversized.pollSource(rssSource)).error, "awareness-response-too-large");

  const unsafeRedirect = new AwarenessService({
    mode: "shadow",
    store: new AwarenessStore({ now: () => nowMs }),
    sources: [rssSource],
    now: () => nowMs,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://example.test/feed.xml" } })
  });
  assert.equal((await unsafeRedirect.pollSource(rssSource)).error, "awareness-redirect-not-allowed");

  const crossCatalogRedirect = new AwarenessService({
    mode: "shadow",
    store: new AwarenessStore({ now: () => nowMs }),
    sources: [rssSource],
    now: () => nowMs,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://www.ecb.europa.eu/rss/press.html" } })
  });
  assert.equal((await crossCatalogRedirect.pollSource(rssSource)).error, "awareness-redirect-not-allowed");

  const credentialRedirect = new AwarenessService({
    mode: "shadow",
    store: new AwarenessStore({ now: () => nowMs }),
    sources: [rssSource],
    now: () => nowMs,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://user:secret@www.federalreserve.gov/feed.xml" } })
  });
  assert.equal((await credentialRedirect.pollSource(rssSource)).error, "awareness-redirect-not-allowed");

  const challengeAsXml = new AwarenessService({
    mode: "shadow",
    store: new AwarenessStore({ now: () => nowMs }),
    sources: [rssSource],
    now: () => nowMs,
    fetchImpl: async () => new Response("<html><body><item>Access denied</item></body></html>", {
      status: 200,
      headers: { "content-type": "application/xml" }
    })
  });
  assert.equal((await challengeAsXml.pollSource(rssSource)).error, "awareness-rss-envelope-invalid");
});

test("shadow mode is analysis-isolated and visible security releases project only to geopolitics", () => {
  const nowMs = Date.parse("2026-07-29T22:00:00Z");
  const securitySource = {
    ...rssSource,
    sourceId: "awareness-centcom-releases",
    name: "U.S. Central Command Public Releases",
    url: "https://www.centcom.mil/MEDIA/PRESS-RELEASES/",
    adapter: "centcom-html",
    kind: "official_security_release",
    domains: ["geopolitical", "security"]
  };
  const event = createAwarenessEvent({
    source: securitySource,
    rawId: "centcom-1",
    title: "U.S. forces intercept ballistic missiles launched from Iran",
    summary: "The official statement describes an attempted missile attack in the Middle East.",
    canonicalUrl: "https://www.centcom.mil/MEDIA/PRESS-RELEASES/Press-Release-View/Article/1/",
    publishedAt: "2026-07-29T21:45:00Z",
    observedAt: "2026-07-29T21:46:00Z"
  });
  const store = new AwarenessStore({ now: () => nowMs });
  store.reconcile([event]);
  const shadow = new AwarenessService({ mode: "shadow", store, sources: [securitySource], now: () => nowMs });
  assert.deepEqual(shadow.getGeopoliticalArticles(), []);
  assert.deepEqual(shadow.getMarketArticles(), []);

  const visible = new AwarenessService({ mode: "visible", store, sources: [securitySource], now: () => nowMs });
  const articles = visible.getGeopoliticalArticles();
  assert.equal(articles.length, 1);
  assert.equal(articles[0].id, event.eventId);
  assert.equal(articles[0].domains.includes("geopolitical"), true);
  assert.ok(articles[0].conflict.totalWeight > 0);
  assert.deepEqual(new Set(articles[0].countryMentions), new Set(["US", "IR"]));
});
