import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRssArticle } from "../services/news/rssClassifier.js";
import { deduplicateRssArticles } from "../services/news/rssDeduplicator.js";
import { fetchRss } from "../services/news/providers/rssProvider.js";
import { providerRuntime } from "../services/providers/providerRuntime.js";
import { sanitizeSensitiveData } from "../utils/sanitize.js";
import { createRssLabFetchGuard, parseRssLabFeeds, RSS_LAB_MAX_FEEDS } from "./rss-lab.js";

function percentage(count, total) {
  return total ? Number(((count / total) * 100).toFixed(1)) : 0;
}

function validHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(String(value || "")).protocol);
  } catch {
    return false;
  }
}

function topCounts(values = [], limit = 10) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return Object.fromEntries(
    [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
  );
}

export function buildRssQualitySummary(articles = [], { nowMs = Date.now() } = {}) {
  const classified = articles.map((article) => classifyRssArticle(article));
  const deduplicated = deduplicateRssArticles(classified, { maxItems: Math.max(1, classified.length) });
  const total = classified.length;
  const validTimes = classified
    .map((article) => {
      const publishedAt = String(article.publishedAt || "").trim();
      return publishedAt ? new Date(publishedAt).getTime() : Number.NaN;
    })
    .filter(Number.isFinite);
  const freshTimes = validTimes.filter((timestamp) => timestamp <= nowMs + 5 * 60_000 && nowMs - timestamp <= 48 * 60 * 60_000);
  const freshSevenDayTimes = validTimes.filter((timestamp) => timestamp <= nowMs + 5 * 60_000 && nowMs - timestamp <= 7 * 24 * 60 * 60_000);
  const freshThirtyDayTimes = validTimes.filter((timestamp) => timestamp <= nowMs + 5 * 60_000 && nowMs - timestamp <= 30 * 24 * 60 * 60_000);
  const futureTimes = validTimes.filter((timestamp) => timestamp > nowMs + 5 * 60_000);
  const newestTimestamp = validTimes.length ? Math.max(...validTimes) : null;
  const oldestTimestamp = validTimes.length ? Math.min(...validTimes) : null;
  const substantialSummaries = classified.filter((article) =>
    String(article.excerpt || article.description || article.summary || article.content || "").trim().length >= 80
  ).length;
  const withImages = classified.filter((article) =>
    validHttpUrl(article.leadImageUrl || article.urlToImage || article.imageUrl)
  ).length;
  const withCountries = classified.filter((article) => (article.countryMentions || []).length > 0).length;
  const withTopics = classified.filter((article) => (article.topicTags || []).length > 0).length;

  return {
    rawArticles: total,
    uniqueArticles: deduplicated.items.length,
    duplicateArticles: Math.max(0, total - deduplicated.items.length),
    distinctSources: new Set(classified.map((article) => article.sourceName || article.provider).filter(Boolean)).size,
    coveragePct: {
      validTitle: percentage(classified.filter((article) => String(article.title || "").trim()).length, total),
      validUrl: percentage(classified.filter((article) => validHttpUrl(article.url)).length, total),
      validPublishedAt: percentage(validTimes.length, total),
      freshWithin48h: percentage(freshTimes.length, total),
      freshWithin7d: percentage(freshSevenDayTimes.length, total),
      freshWithin30d: percentage(freshThirtyDayTimes.length, total),
      substantialSummary: percentage(substantialSummaries, total),
      image: percentage(withImages, total),
      countryMentions: percentage(withCountries, total),
      topicTags: percentage(withTopics, total)
    },
    newestPublishedAt: newestTimestamp === null ? null : new Date(newestTimestamp).toISOString(),
    oldestPublishedAt: oldestTimestamp === null ? null : new Date(oldestTimestamp).toISOString(),
    latestAgeHours: newestTimestamp === null
      ? null
      : Number(((nowMs - newestTimestamp) / (60 * 60_000)).toFixed(1)),
    futureDatedArticles: futureTimes.length,
    topCountries: topCounts(classified.flatMap((article) => article.countryMentions || [])),
    topTopics: topCounts(classified.flatMap((article) => article.topicTags || [])),
    threatLevels: topCounts(classified.map((article) => article.threatLevel || "unclassified"))
  };
}

function resolveTimeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 500 && parsed <= 15_000 ? parsed : 8_000;
}

function feedDiagnostics(feedStatus = []) {
  return feedStatus.map((feed) => {
    let hostname = "invalid";
    try { hostname = new URL(feed.url).hostname; } catch { /* Report only the validation state. */ }
    return {
      label: String(feed.label || hostname),
      hostname,
      status: feed.status,
      articles: Number(feed.count || 0),
      error: feed.error || null
    };
  });
}

export async function runRssProbe({
  feedSpec,
  timeoutMs = resolveTimeoutMs(process.env.NEWS_TIMEOUT_MS),
  fetchImpl = globalThis.fetch,
  nowMs = Date.now()
} = {}) {
  const feeds = parseRssLabFeeds(feedSpec);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createRssLabFetchGuard({ feeds, fetchImpl });
  providerRuntime.reset();

  try {
    const result = await fetchRss({ feeds, timeoutMs, retries: 0 });
    const diagnostics = feedDiagnostics(result.sourceMeta?.feedStatus || []);
    const failed = diagnostics.filter((feed) => !["ok", "empty"].includes(feed.status)).length;
    const metrics = providerRuntime.getMetrics("rss");
    return {
      ok: true,
      mode: "rss-live-probe",
      status: failed === diagnostics.length ? "failed" : failed ? "partial" : "ok",
      generatedAt: new Date(nowMs).toISOString(),
      requestPolicy: {
        feedCount: feeds.length,
        maximumFeeds: RSS_LAB_MAX_FEEDS,
        retries: 0,
        timeoutMs,
        backgroundRefresh: false,
        allowedHosts: [...new Set(feeds.map((feed) => new URL(feed.url).hostname))]
      },
      feeds: diagnostics,
      quality: buildRssQualitySummary(result.articles || [], { nowMs }),
      runtime: {
        calls: metrics.calls,
        attempts: metrics.attempts,
        retries: metrics.retries,
        errors: metrics.errors,
        latencyMs: metrics.latencyMs
      }
    };
  } finally {
    globalThis.fetch = originalFetch;
    providerRuntime.reset();
  }
}

async function main() {
  const cliEntries = process.argv.slice(2);
  const feedSpec = cliEntries.length ? cliEntries.join(",") : process.env.NEWS_RSS_FEEDS;
  try {
    const report = await runRssProbe({ feedSpec });
    process.stdout.write(`${JSON.stringify(sanitizeSensitiveData(report), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(sanitizeSensitiveData({
      ok: false,
      error: {
        code: error.code || "RSS_LAB_FAILED",
        message: error.message
      }
    }), null, 2)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
