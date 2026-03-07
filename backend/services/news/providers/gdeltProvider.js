import { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";

const GDELT_MIN_INTERVAL_MS = 6_000;
const GDELT_MAX_BACKOFF_MS = 120_000;

let nextAllowedAtMs = 0;
let currentBackoffMs = GDELT_MIN_INTERVAL_MS;

function buildGdeltUrl({ baseUrl, query, pageSize }) {
  const url = new URL(baseUrl || "https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "datedesc");
  url.searchParams.set("maxrecords", String(pageSize));
  return url;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildGdeltError(code, message, extras = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extras);
  return error;
}

function resolveNextAllowedAt(backoffMs) {
  nextAllowedAtMs = Date.now() + backoffMs;
  return new Date(nextAllowedAtMs).toISOString();
}

function parseJsonSafely(text) {
  try {
    return {
      payload: JSON.parse(text),
      parseError: null
    };
  } catch (error) {
    return {
      payload: null,
      parseError: error
    };
  }
}

function normalizeGdeltArticle(article) {
  return {
    provider: "gdelt",
    source: {
      name: article?.domain || article?.sourcecountry || "GDELT"
    },
    title: article?.title || "",
    description: article?.seendate ? `Seen ${article.seendate}` : article?.title || "",
    content: article?.snippet || article?.title || "",
    url: article?.url || "",
    urlToImage: article?.socialimage || null,
    publishedAt: article?.seendate || new Date().toISOString(),
    usagePolicy: "headline-only-link-out"
  };
}

export async function fetchGdelt({
  baseUrl,
  query,
  pageSize,
  timeoutMs = 9_000
}) {
  if (Date.now() < nextAllowedAtMs) {
    const error = buildGdeltError("cooldown", "gdelt-cooldown-active");
    error.skipProvider = true;
    error.skipReason = "cooldown";
    error.nextAllowedAt = new Date(nextAllowedAtMs).toISOString();
    throw error;
  }

  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    throw new Error("gdelt-query-missing");
  }

  const url = buildGdeltUrl({
    baseUrl,
    query: normalizedQuery,
    pageSize
  });

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": "ogid/1.0"
      }
    },
    timeoutMs
  );
  const rateLimit = parseRateLimitHeaders(response.headers);
  const body = await response.text();

  if (!response.ok) {
    if (response.status === 429) {
      currentBackoffMs = Math.min(currentBackoffMs * 2, GDELT_MAX_BACKOFF_MS);
      resolveNextAllowedAt(currentBackoffMs);
    } else {
      resolveNextAllowedAt(GDELT_MIN_INTERVAL_MS);
    }
    const error = buildGdeltError(
      response.status === 429 ? "rate-limited" : `gdelt-upstream-${response.status}`,
      `gdelt-upstream-${response.status}:${body.slice(0, 120)}`
    );
    error.rateLimit = rateLimit;
    error.nextAllowedAt = new Date(nextAllowedAtMs).toISOString();
    throw error;
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const looksJson = contentType.includes("json") || /^[\s\r\n]*[{[]/.test(body);
  if (!looksJson) {
    currentBackoffMs = Math.min(Math.max(currentBackoffMs, GDELT_MIN_INTERVAL_MS), GDELT_MAX_BACKOFF_MS);
    const error = buildGdeltError(
      "invalid-body",
      `gdelt-invalid-body:${body.slice(0, 120)}`
    );
    error.rateLimit = rateLimit;
    error.nextAllowedAt = resolveNextAllowedAt(GDELT_MIN_INTERVAL_MS);
    throw error;
  }

  const { payload, parseError } = parseJsonSafely(body);
  if (parseError) {
    const error = buildGdeltError("invalid-body", `gdelt-invalid-body:${body.slice(0, 120)}`);
    error.rateLimit = rateLimit;
    error.nextAllowedAt = resolveNextAllowedAt(GDELT_MIN_INTERVAL_MS);
    throw error;
  }

  if (!payload || !Array.isArray(payload.articles)) {
    const error = buildGdeltError("invalid-payload", "gdelt-invalid-payload");
    error.rateLimit = rateLimit;
    error.nextAllowedAt = resolveNextAllowedAt(GDELT_MIN_INTERVAL_MS);
    throw error;
  }

  const articles = payload.articles.map(normalizeGdeltArticle);
  currentBackoffMs = GDELT_MIN_INTERVAL_MS;
  resolveNextAllowedAt(GDELT_MIN_INTERVAL_MS);

  return {
    provider: "gdelt",
    articles,
    sourceMeta: {
      provider: "gdelt",
      totalResults: articles.length,
      rateLimit,
      nextAllowedAt: new Date(nextAllowedAtMs).toISOString()
    }
  };
}

export function resetGdeltThrottleForTests() {
  nextAllowedAtMs = 0;
  currentBackoffMs = GDELT_MIN_INTERVAL_MS;
}
