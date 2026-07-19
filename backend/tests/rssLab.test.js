import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRssQualitySummary, runRssProbe } from "../scripts/probe-rss.js";
import { createRssLabFetchGuard, parseRssLabFeeds, serializeRssLabFeeds } from "../scripts/rss-lab.js";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("rss lab requires an explicit bounded feed list", () => {
  const feeds = parseRssLabFeeds(
    "Primary|https://feeds.example.test/world.xml,Secondary|https://news.example.test/rss"
  );
  assert.deepEqual(feeds, [
    { label: "Primary", url: "https://feeds.example.test/world.xml" },
    { label: "Secondary", url: "https://news.example.test/rss" }
  ]);
  assert.equal(
    serializeRssLabFeeds(feeds),
    "Primary|https://feeds.example.test/world.xml,Secondary|https://news.example.test/rss"
  );

  assert.throws(() => parseRssLabFeeds(""), (error) => error.code === "RSS_LAB_FEEDS_REQUIRED");
  assert.throws(
    () => parseRssLabFeeds("Unsafe|https://user:secret@feeds.example.test/rss"),
    (error) => error.code === "RSS_LAB_UNSAFE_FEED_URL"
  );
  assert.throws(
    () => parseRssLabFeeds(Array.from({ length: 6 }, (_, index) => `F${index}|https://f${index}.example.test/rss`)),
    (error) => error.code === "RSS_LAB_TOO_MANY_FEEDS"
  );
});

test("rss lab fetch guard allows configured hosts and blocks other providers and redirect hosts", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (new URL(url).pathname === "/start") {
      return new Response(null, { status: 302, headers: { location: "https://feeds.example.test/final" } });
    }
    return new Response("<rss><channel><item><title>ok</title></item></channel></rss>", { status: 200 });
  };
  const guarded = createRssLabFetchGuard({
    feeds: "Feed|https://feeds.example.test/start",
    fetchImpl
  });

  assert.equal((await guarded("https://feeds.example.test/start")).status, 200);
  assert.equal(calls.length, 2);
  await assert.rejects(
    guarded("https://query2.finance.yahoo.com/v1/finance/search"),
    (error) => error.code === "RSS_LAB_OUTBOUND_BLOCKED"
  );
  assert.equal(calls.length, 2);

  const redirectOutside = createRssLabFetchGuard({
    feeds: "Feed|https://feeds.example.test/start",
    fetchImpl: async () => new Response(null, {
      status: 301,
      headers: { location: "https://redirected.example.test/rss" }
    })
  });
  await assert.rejects(
    redirectOutside("https://feeds.example.test/start"),
    (error) => error.code === "RSS_LAB_REDIRECT_HOST_BLOCKED"
  );
});

test("rss probe reports quality coverage without returning article bodies", async () => {
  const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title>Missile strike raises regional risk in Iran</title>
    <link>https://news.example.test/article-1</link>
    <description>Officials reported a significant regional security development with sanctions and energy market implications.</description>
    <pubDate>Sat, 18 Jul 2026 11:00:00 GMT</pubDate>
  </item></channel></rss>`;
  const report = await runRssProbe({
    feedSpec: "Fixture|https://feeds.example.test/rss.xml",
    nowMs,
    fetchImpl: async () => new Response(xml, {
      status: 200,
      headers: { "content-type": "application/xml" }
    })
  });

  assert.equal(report.status, "ok");
  assert.equal(report.requestPolicy.feedCount, 1);
  assert.equal(report.requestPolicy.retries, 0);
  assert.equal(report.runtime.attempts, 1);
  assert.equal(report.quality.rawArticles, 1);
  assert.equal(report.quality.coveragePct.validPublishedAt, 100);
  assert.equal(report.quality.coveragePct.freshWithin48h, 100);
  assert.equal(JSON.stringify(report).includes("Officials reported"), false);

  const duplicateSummary = buildRssQualitySummary([
    { title: "A", url: "https://news.example.test/a", publishedAt: new Date(nowMs).toISOString() },
    { title: "A", url: "https://news.example.test/a" }
  ], { nowMs });
  assert.equal(duplicateSummary.rawArticles, 2);
  assert.equal(duplicateSummary.uniqueArticles, 1);
  assert.equal(duplicateSummary.duplicateArticles, 1);
  assert.equal(duplicateSummary.coveragePct.validPublishedAt, 50);

  const fallbackSummary = buildRssQualitySummary([
    {
      title: "Fallback timestamp",
      url: "https://news.example.test/fallback",
      publishedAt: new Date(nowMs).toISOString(),
      provenance: { publishedAtQuality: "fallback-invalid" }
    }
  ], { nowMs });
  assert.equal(fallbackSummary.timestampFallbackArticles, 1);
  assert.equal(fallbackSummary.coveragePct.validPublishedAt, 0);
  assert.equal(fallbackSummary.coveragePct.freshWithin48h, 0);
});

test("rss lab server preloader clears credentials and keeps outbound traffic fail-closed", () => {
  const child = spawnSync(process.execPath, [
    "--import",
    "./scripts/rss-lab-setup.js",
    "--input-type=module",
    "--eval",
    `let blocked = null;
     try { await fetch("https://blocked.example.test/data"); } catch (error) { blocked = error.code; }
     console.log(JSON.stringify({
       nodeEnv: process.env.NODE_ENV,
       port: process.env.PORT,
       background: process.env.DISABLE_BACKGROUND_REFRESH,
       providers: process.env.NEWS_PROVIDERS,
       feedBatch: process.env.NEWS_RSS_AGGREGATE_FEEDS_PER_RUN,
       market: process.env.MARKET_PROVIDER,
       newsKey: process.env.NEWS_API_KEY,
       youtubeKey: process.env.YOUTUBE_API_KEY,
       blocked
     }));`
  ], {
    cwd: backendDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PORT: "",
      NEWS_TIMEOUT_MS: "",
      NEWS_RSS_FEEDS: "One|https://one.example.test/rss,Two|https://two.example.test/rss",
      NEWS_API_KEY: "must-be-cleared",
      YOUTUBE_API_KEY: "must-be-cleared",
      MARKET_PROVIDER: "yahoo"
    }
  });

  assert.equal(child.status, 0, child.stderr);
  const payload = JSON.parse(child.stdout.trim());
  assert.deepEqual(payload, {
    nodeEnv: "test",
    port: "8081",
    background: "1",
    providers: "rss",
    feedBatch: "2",
    market: "",
    newsKey: "",
    youtubeKey: "",
    blocked: "RSS_LAB_OUTBOUND_BLOCKED"
  });
  assert.match(child.stderr, /"event":"rss_lab_profile_ready"/);
});
