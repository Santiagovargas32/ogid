import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEWS_SOURCE_CATALOG } from "../services/news/newsSourceCatalog.js";
import { fetchRss, resetRssFeedValidationCacheForTests } from "../services/news/providers/rssProvider.js";
import { providerRuntime } from "../services/providers/providerRuntime.js";
import { sanitizeSensitiveData } from "../utils/sanitize.js";
import { buildRssQualitySummary } from "./probe-rss.js";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_DELAY_MS = 350;
const MAX_TIMEOUT_MS = 30_000;
const MAX_DELAY_MS = 5_000;
const FRESH_WINDOW_HOURS = 7 * 24;
const AGING_WINDOW_HOURS = 30 * 24;

function boundedInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function rssCatalogFeeds(catalog = NEWS_SOURCE_CATALOG) {
  return catalog.entries
    .filter((entry) => entry.type === "rss")
    .map((entry) => ({
      sourceId: entry.sourceId,
      label: entry.name,
      publisher: entry.publisher,
      url: entry.url,
      role: entry.role,
      disabled: !entry.enabled,
      reason: entry.disabledReason || (!entry.enabled ? entry.status : null),
      priority: entry.priority,
      provenance: structuredClone(entry.provenance)
    }));
}

function errorHttpStatus(error = "") {
  const match = String(error || "").match(/^rss-upstream-(\d{3})$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function classifyRssAuditResult({ diagnostic = {}, quality = {} } = {}) {
  const status = String(diagnostic.status || "error");
  const error = String(diagnostic.error || "");
  const httpStatus = diagnostic.httpStatus ?? errorHttpStatus(error);
  const articles = Number(quality.rawArticles || diagnostic.articles || diagnostic.count || 0);
  const latestAgeHours = Number.isFinite(quality.latestAgeHours) ? quality.latestAgeHours : null;

  if (status === "skipped") {
    return { category: "disabled", reason: error || "feed-disabled", action: "keep-disabled" };
  }
  if (status === "ok" && articles > 0) {
    if (latestAgeHours === null) {
      return { category: "degraded", reason: "articles-without-usable-date", action: "review-metadata" };
    }
    if (latestAgeHours <= FRESH_WINDOW_HOURS) {
      return { category: "healthy", reason: "fresh-news-within-7d", action: "keep" };
    }
    if (latestAgeHours <= AGING_WINDOW_HOURS) {
      return { category: "degraded", reason: "low-cadence-or-aging-news", action: "review-cadence" };
    }
    return { category: "degraded", reason: "stale-news-over-30d", action: "replace-or-remove" };
  }
  if (status === "empty") {
    return { category: "empty", reason: error || "feed-without-items", action: "review-or-replace" };
  }
  if (status === "invalid-feed") {
    return { category: "broken", reason: error || "invalid-rss-or-atom", action: "replace-or-remove" };
  }
  if ([404, 410].includes(httpStatus)) {
    return { category: "broken", reason: `http-${httpStatus}`, action: "replace-or-remove" };
  }
  if ([401, 403, 451].includes(httpStatus)) {
    return { category: "blocked", reason: `http-${httpStatus}`, action: "verify-access-or-replace" };
  }
  if (httpStatus === 429) {
    return { category: "rate-limited", reason: "http-429", action: "retry-after-cooldown" };
  }
  if (httpStatus !== null && httpStatus >= 500) {
    return { category: "transient", reason: `http-${httpStatus}`, action: "recheck-later" };
  }
  if (/timeout/i.test(error)) {
    return { category: "transient", reason: "timeout", action: "recheck-later" };
  }
  if (/network|fetch failed|circuit/i.test(error)) {
    return { category: "transient", reason: error || "network-error", action: "recheck-later" };
  }
  return { category: "broken", reason: error || "unknown-feed-failure", action: "investigate" };
}

function auditDiagnostic(feed, diagnostic = {}, quality = {}, runtime = {}, latencyMs = 0) {
  const classification = classifyRssAuditResult({ diagnostic, quality });
  return {
    sourceId: feed.sourceId,
    label: feed.label,
    role: feed.role || "primary",
    url: feed.url,
    hostname: new URL(feed.url).hostname,
    enabled: !feed.disabled,
    status: diagnostic.status || "error",
    category: classification.category,
    reason: classification.reason,
    recommendedAction: classification.action,
    error: diagnostic.error || null,
    httpStatus: diagnostic.httpStatus ?? errorHttpStatus(diagnostic.error),
    contentType: diagnostic.contentType || null,
    responseUrl: diagnostic.responseUrl || null,
    redirected: Boolean(diagnostic.redirected),
    payloadBytes: Number.isFinite(diagnostic.payloadBytes) ? diagnostic.payloadBytes : null,
    articles: Number(diagnostic.count || quality.rawArticles || 0),
    latencyMs,
    runtime: {
      calls: Number(runtime.calls || 0),
      attempts: Number(runtime.attempts || 0),
      retries: Number(runtime.retries || 0),
      errors: Number(runtime.errors || 0)
    },
    quality
  };
}

export async function auditRssFeed(feed, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now()
} = {}) {
  if (!feed?.url || !feed?.sourceId) throw new Error("rss-audit-feed-invalid");
  const originalFetch = globalThis.fetch;
  const startedAt = Date.now();
  globalThis.fetch = fetchImpl;
  providerRuntime.reset();
  resetRssFeedValidationCacheForTests();

  try {
    const result = await fetchRss({ feeds: [feed], timeoutMs, retries: 0 });
    const diagnostic = result.sourceMeta?.feedStatus?.[0] || {
      status: "error",
      count: 0,
      error: "rss-audit-missing-diagnostic"
    };
    const quality = buildRssQualitySummary(result.articles || [], { nowMs });
    return auditDiagnostic(
      feed,
      diagnostic,
      quality,
      providerRuntime.getMetrics("rss"),
      Math.max(0, Date.now() - startedAt)
    );
  } catch (error) {
    return auditDiagnostic(feed, {
      status: "error",
      count: 0,
      error: error?.message || "rss-audit-failed"
    }, buildRssQualitySummary([], { nowMs }), providerRuntime.getMetrics("rss"), Math.max(0, Date.now() - startedAt));
  } finally {
    globalThis.fetch = originalFetch;
    providerRuntime.reset();
    resetRssFeedValidationCacheForTests();
  }
}

export function summarizeRssAudit(feeds = []) {
  const categoryCounts = {};
  const httpStatusCounts = {};
  const errorCounts = {};
  for (const feed of feeds) {
    categoryCounts[feed.category] = (categoryCounts[feed.category] || 0) + 1;
    if (feed.httpStatus !== null) httpStatusCounts[feed.httpStatus] = (httpStatusCounts[feed.httpStatus] || 0) + 1;
    if (feed.error) errorCounts[feed.error] = (errorCounts[feed.error] || 0) + 1;
  }
  return {
    catalogFeeds: feeds.length,
    attemptedFeeds: feeds.filter((feed) => feed.category !== "disabled").length,
    validFeeds: feeds.filter((feed) => ["ok", "empty"].includes(feed.status)).length,
    sourcesReturningNews: feeds.filter((feed) => feed.articles > 0).length,
    sourcesWithFreshNews7d: feeds.filter((feed) => feed.category === "healthy").length,
    degradedSources: feeds.filter((feed) => feed.category === "degraded").length,
    emptySources: feeds.filter((feed) => feed.category === "empty").length,
    failedSources: feeds.filter((feed) => ["broken", "blocked", "rate-limited", "transient"].includes(feed.category)).length,
    totalArticlesObserved: feeds.reduce((total, feed) => total + feed.articles, 0),
    categoryCounts,
    httpStatusCounts,
    errorCounts
  };
}

export async function auditRssFeeds({
  feeds = rssCatalogFeeds(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delayMs = DEFAULT_DELAY_MS,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  onProgress = null
} = {}) {
  const results = [];
  for (let index = 0; index < feeds.length; index += 1) {
    const result = await auditRssFeed(feeds[index], { timeoutMs, fetchImpl, nowMs });
    results.push(result);
    onProgress?.({ index: index + 1, total: feeds.length, result });
    if (index < feeds.length - 1) await sleep(delayMs);
  }
  return {
    schemaVersion: 1,
    mode: "rss-catalog-live-audit",
    generatedAt: new Date(nowMs).toISOString(),
    requestPolicy: {
      feedCount: feeds.length,
      concurrency: 1,
      retries: 0,
      timeoutMs,
      delayMs,
      backgroundRefresh: false,
      credentialsRequired: false
    },
    summary: summarizeRssAudit(results),
    feeds: results
  };
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function feedTable(feeds) {
  if (!feeds.length) return "_None._\n";
  const rows = feeds.map((feed) => [
    feed.label,
    feed.category,
    feed.reason,
    feed.httpStatus ?? "-",
    feed.articles,
    feed.quality?.newestPublishedAt || "-",
    `${feed.latencyMs} ms`,
    feed.recommendedAction,
    `<${feed.url}>`
  ]);
  return [
    "| Source | Category | Reason | HTTP | Articles | Newest | Latency | Action | URL |",
    "|---|---|---|---:|---:|---|---:|---|---|",
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
    ""
  ].join("\n");
}

export function renderRssAuditMarkdown(report) {
  const groups = [
    ["Healthy feeds", ["healthy"]],
    ["Degraded or stale feeds", ["degraded"]],
    ["Valid but empty feeds", ["empty"]],
    ["Broken feeds", ["broken"]],
    ["Blocked feeds", ["blocked"]],
    ["Rate-limited feeds", ["rate-limited"]],
    ["Transient failures", ["transient"]],
    ["Disabled feeds", ["disabled"]]
  ];
  const summary = report.summary;
  const sections = groups.map(([title, categories]) => {
    const feeds = report.feeds.filter((feed) => categories.includes(feed.category));
    return `## ${title}\n\n${feedTable(feeds)}`;
  });
  return [
    "# RSS Catalog Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "The audit performs one request per enabled feed, with no retries and no article bodies in the report.",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Catalog feeds | ${summary.catalogFeeds} |`,
    `| Attempted feeds | ${summary.attemptedFeeds} |`,
    `| Valid feeds | ${summary.validFeeds} |`,
    `| Sources returning articles | ${summary.sourcesReturningNews} |`,
    `| Sources with news within 7 days | ${summary.sourcesWithFreshNews7d} |`,
    `| Degraded sources | ${summary.degradedSources} |`,
    `| Empty sources | ${summary.emptySources} |`,
    `| Failed sources | ${summary.failedSources} |`,
    `| Articles observed | ${summary.totalArticlesObserved} |`,
    "",
    ...sections
  ].join("\n");
}

function parseCliArgs(args = []) {
  const options = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    delayMs: DEFAULT_DELAY_MS,
    outputDir: path.resolve(backendDir, "reports"),
    outputPrefix: "rss-catalog-audit-latest",
    only: []
  };
  for (const argument of args) {
    const [name, ...valueParts] = argument.split("=");
    const value = valueParts.join("=");
    if (name === "--timeout-ms") options.timeoutMs = boundedInteger(value, Number.NaN, { min: 500, max: MAX_TIMEOUT_MS });
    else if (name === "--delay-ms") options.delayMs = boundedInteger(value, Number.NaN, { min: 0, max: MAX_DELAY_MS });
    else if (name === "--output-dir") options.outputDir = path.resolve(backendDir, value);
    else if (name === "--output-prefix") options.outputPrefix = value;
    else if (name === "--only") options.only = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    else throw new Error(`rss-audit-unknown-argument:${name}`);
  }
  if (!Number.isFinite(options.timeoutMs)) throw new Error("rss-audit-invalid-timeout");
  if (!Number.isFinite(options.delayMs)) throw new Error("rss-audit-invalid-delay");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.outputPrefix)) throw new Error("rss-audit-invalid-output-prefix");
  return options;
}

async function writeReport(report, { outputDir, outputPrefix }) {
  await mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${outputPrefix}.json`);
  const markdownPath = path.join(outputDir, `${outputPrefix}.md`);
  const sanitized = sanitizeSensitiveData(report);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, `${renderRssAuditMarkdown(sanitized)}\n`, "utf8")
  ]);
  return { jsonPath, markdownPath };
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    let feeds = rssCatalogFeeds();
    if (options.only.length) {
      const requested = new Set(options.only);
      feeds = feeds.filter((feed) => requested.has(feed.sourceId));
      const missing = options.only.filter((sourceId) => !feeds.some((feed) => feed.sourceId === sourceId));
      if (missing.length) throw new Error(`rss-audit-source-not-found:${missing.join(",")}`);
    }
    const report = await auditRssFeeds({
      feeds,
      timeoutMs: options.timeoutMs,
      delayMs: options.delayMs,
      onProgress: ({ index, total, result }) => {
        process.stderr.write(
          `[${index}/${total}] ${result.sourceId} ${result.category} articles=${result.articles} http=${result.httpStatus ?? "-"}\n`
        );
      }
    });
    const outputs = await writeReport(report, options);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      generatedAt: report.generatedAt,
      requestPolicy: report.requestPolicy,
      summary: report.summary,
      outputs
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(sanitizeSensitiveData({
      ok: false,
      error: { code: error.code || "RSS_CATALOG_AUDIT_FAILED", message: error.message }
    }), null, 2)}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
