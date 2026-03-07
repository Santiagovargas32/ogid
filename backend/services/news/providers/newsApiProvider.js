import { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";

function ensureTrailingSlash(baseUrl) {
  return String(baseUrl).endsWith("/") ? String(baseUrl) : `${String(baseUrl)}/`;
}

function buildNewsApiUrl({ baseUrl, query, language, pageSize, domains = [], sources = [] }) {
  const url = new URL("everything", ensureTrailingSlash(baseUrl));
  url.searchParams.set("q", query);
  url.searchParams.set("language", language);
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", String(pageSize));

  if (sources.length) {
    url.searchParams.set("sources", sources.join(","));
  }

  if (domains.length) {
    url.searchParams.set("domains", domains.join(","));
  }
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

export async function fetchNewsApi({
  apiKey,
  baseUrl,
  query,
  language,
  pageSize,
  domains = [],
  sources = [],
  timeoutMs = 9_000
}) {
  if (!apiKey) {
    throw new Error("newsapi-api-key-missing");
  }

  const url = buildNewsApiUrl({
    baseUrl: baseUrl || "https://newsapi.org/v2",
    query,
    language,
    pageSize,
    domains,
    sources
  });

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "X-Api-Key": apiKey,
        "User-Agent": "ogid/1.0"
      }
    },
    timeoutMs
  );
  const rateLimit = parseRateLimitHeaders(response.headers);

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`newsapi-upstream-${response.status}:${body.slice(0, 120)}`);
    error.rateLimit = rateLimit;
    throw error;
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.articles)) {
    const error = new Error("newsapi-invalid-payload");
    error.rateLimit = rateLimit;
    throw error;
  }

  const articles = payload.articles.map((article) => ({
    ...article,
    provider: "newsapi"
  }));

  return {
    provider: "newsapi",
    articles,
    sourceMeta: {
      provider: "newsapi",
      totalResults: payload.totalResults ?? articles.length,
      rateLimit
    }
  };
}
