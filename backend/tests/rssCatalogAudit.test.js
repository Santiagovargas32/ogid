import assert from "node:assert/strict";
import test from "node:test";
import {
  auditRssFeeds,
  classifyRssAuditResult,
  renderRssAuditMarkdown
} from "../scripts/audit-rss-catalog.js";

function feed(sourceId, url) {
  return {
    sourceId,
    label: sourceId,
    url,
    role: "primary",
    disabled: false,
    provenance: { methodVersion: "test" }
  };
}

test("rss catalog audit classifies feed failures into actionable categories", () => {
  assert.deepEqual(
    classifyRssAuditResult({ diagnostic: { status: "error", error: "rss-upstream-404" } }),
    { category: "broken", reason: "http-404", action: "replace-or-remove" }
  );
  assert.equal(classifyRssAuditResult({ diagnostic: { status: "error", httpStatus: 403 } }).category, "blocked");
  assert.equal(classifyRssAuditResult({ diagnostic: { status: "error", httpStatus: 429 } }).category, "rate-limited");
  assert.equal(classifyRssAuditResult({ diagnostic: { status: "error", httpStatus: 503 } }).category, "transient");
  assert.equal(classifyRssAuditResult({ diagnostic: { status: "invalid-feed" } }).category, "broken");
});

test("rss catalog audit checks every feed once and reports health without article bodies", async () => {
  const nowMs = Date.parse("2026-07-19T00:00:00.000Z");
  const freshXml = `<?xml version="1.0"?><rss><channel><title>Fresh</title><item>
    <title>Unique sensitive headline fixture</title>
    <link>https://articles.example.test/fresh</link>
    <description>Unique article body fixture that must never be copied into the generated catalog audit.</description>
    <pubDate>Sat, 18 Jul 2026 23:00:00 GMT</pubDate>
  </item></channel></rss>`;
  const staleXml = `<?xml version="1.0"?><rss><channel><title>Stale</title><item>
    <title>Old fixture</title><link>https://articles.example.test/old</link>
    <pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>
  </item></channel></rss>`;
  const calls = [];
  const fetchImpl = async (url) => {
    const target = new URL(url);
    calls.push(target.hostname);
    if (target.hostname === "fresh.example.test") {
      return new Response(freshXml, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
    if (target.hostname === "stale.example.test") {
      return new Response(staleXml, { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (target.hostname === "empty.example.test") {
      return new Response("<rss><channel><title>Empty</title></channel></rss>", { status: 200 });
    }
    return new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
  };

  const report = await auditRssFeeds({
    feeds: [
      feed("fresh", "https://fresh.example.test/rss"),
      feed("stale", "https://stale.example.test/rss"),
      feed("empty", "https://empty.example.test/rss"),
      feed("missing", "https://missing.example.test/rss")
    ],
    timeoutMs: 1_000,
    delayMs: 0,
    fetchImpl,
    nowMs
  });

  assert.deepEqual(calls, [
    "fresh.example.test",
    "stale.example.test",
    "empty.example.test",
    "missing.example.test"
  ]);
  assert.deepEqual(report.feeds.map((entry) => entry.category), ["healthy", "degraded", "empty", "broken"]);
  assert.equal(report.feeds.every((entry) => entry.runtime.attempts === 1), true);
  assert.equal(report.feeds.every((entry) => entry.runtime.retries === 0), true);
  assert.equal(report.summary.catalogFeeds, 4);
  assert.equal(report.summary.sourcesReturningNews, 2);
  assert.equal(report.summary.sourcesWithFreshNews7d, 1);
  assert.equal(report.summary.failedSources, 1);
  assert.equal(report.feeds[0].quality.coveragePct.freshWithin7d, 100);
  assert.equal(report.feeds[1].quality.latestAgeHours > 30 * 24, true);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("Unique sensitive headline fixture"), false);
  assert.equal(serialized.includes("Unique article body fixture"), false);
  const markdown = renderRssAuditMarkdown(report);
  assert.match(markdown, /Healthy feeds/);
  assert.match(markdown, /missing\.example\.test/);
  assert.equal(markdown.includes("Unique article body fixture"), false);
});
