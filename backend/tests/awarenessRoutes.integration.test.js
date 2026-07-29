import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../server.js";
import { createAwarenessEvent } from "../services/awareness/awarenessParsers.js";

test("awareness REST endpoint is additive, filterable and rejects invalid query contracts", async () => {
  const runtime = createAppServer({ port: 0, disableBackgroundRefresh: true, awareness: { mode: "visible" }, market: { enabled: false, provider: "", fallbackProvider: "" } });
  await runtime.start();
  try {
    const source = { sourceId: "awareness-fed-releases", name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml", adapter: "rss", kind: "macro_release", domains: ["financial", "macro"], timezone: "America/New_York", role: "official", official: true };
    const event = createAwarenessEvent({ source, rawId: "fomc-release", title: "FOMC Interest Rate Decision", canonicalUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm", publishedAt: "2026-07-29T18:00:00Z", observedAt: "2026-07-29T18:00:01Z" });
    event.instrumentIds = ["us-index-sp500"];
    runtime.app.locals.awarenessStore.reconcile([event]);
    runtime.awarenessService.syncProjection();

    const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    const response = await fetch(`${baseUrl}/api/intel/awareness-snapshot?domain=financial&kinds=macro_release&status=released&instrumentIds=us-index-sp500&limit=10`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.schemaVersion, "awareness-v1");
    assert.equal(payload.data.recent.length, 1);
    assert.equal(payload.data.recent[0].eventId, event.eventId);

    assert.equal((await fetch(`${baseUrl}/api/intel/awareness-snapshot?unexpected=1`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/intel/awareness-snapshot?from=invalid`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/intel/awareness-snapshot?status=imagined`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/intel/awareness-snapshot?countries=NOT-A-COUNTRY`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/intel/awareness-snapshot?from=2026-08-01T00:00:00Z&to=2026-07-01T00:00:00Z`)).status, 400);

    const legacy = await (await fetch(`${baseUrl}/api/intel/snapshot`)).json();
    assert.equal(legacy.ok, true);
    assert.equal(legacy.data.awareness.schemaVersion, "awareness-v1");

    const admin = await (await fetch(`${baseUrl}/api/admin/pipeline-status`)).json();
    assert.equal(admin.ok, true);
    assert.equal(admin.data.awareness.mode, "visible");
    assert.equal(admin.data.awareness.revision, 1);
    assert.ok(Array.isArray(admin.data.awareness.sourceStatus));
  } finally {
    await runtime.stop();
  }
});
