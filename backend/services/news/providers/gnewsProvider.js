import { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";

function ensureTrailingSlash(baseUrl) {
  return String(baseUrl).endsWith("/") ? String(baseUrl) : `${String(baseUrl)}/`;
}

function buildGnewsUrl({ baseUrl, query, language, pageSize, apiKey }) {
  const url = new URL("search", ensureTrailingSlash(baseUrl));
  url.searchParams.set("q", query);
  url.searchParams.set("lang", language);
  url.searchParams.set("max", String(pageSize));
  url.searchParams.set("sortby", "publishedAt");
  url.searchParams.set("apikey", apiKey);
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

function normalizeGnewsArticle(article) {
  return {
    provider: "gnews",
    source: {
      name: article?.source?.name || "GNews"
    },
    title: article?.title || "",
    description: article?.description || "",
    content: article?.content || "",
    url: article?.url || "",
    urlToImage: article?.image || null,
    publishedAt: article?.publishedAt || new Date().toISOString()
  };
}

export async function fetchGnews({ apiKey, baseUrl, query, language, pageSize, timeoutMs = 9_000 }) {
  if (!apiKey) {
    throw new Error("gnews-api-key-missing");
  }

  const url = buildGnewsUrl({
    baseUrl: baseUrl || "https://gnews.io/api/v4",
    query,
    language,
    pageSize,
    apiKey
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

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`gnews-upstream-${response.status}:${body.slice(0, 120)}`);
    error.rateLimit = rateLimit;
    throw error;
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.articles)) {
    const error = new Error("gnews-invalid-payload");
    error.rateLimit = rateLimit;
    throw error;
  }

  const articles = payload.articles.map(normalizeGnewsArticle);

  return {
    provider: "gnews",
    articles,
    sourceMeta: {
      provider: "gnews",
      totalResults: payload.totalArticles ?? articles.length,
      rateLimit
    }
  };
}
