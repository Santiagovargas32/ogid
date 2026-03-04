import { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";

function ensureTrailingSlash(baseUrl) {
  return String(baseUrl).endsWith("/") ? String(baseUrl) : `${String(baseUrl)}/`;
}

function buildMediastackUrl({ baseUrl, apiKey, query, language, pageSize, countries = [] }) {
  const url = new URL("news", ensureTrailingSlash(baseUrl));
  url.searchParams.set("access_key", apiKey);
  url.searchParams.set("keywords", query);
  url.searchParams.set("languages", language);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("sort", "published_desc");

  const countryList = Array.isArray(countries)
    ? countries
        .map((country) => String(country || "").trim().toLowerCase())
        .filter(Boolean)
    : [];

  if (countryList.length) {
    url.searchParams.set("countries", countryList.join(","));
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

function normalizeMediastackArticle(article) {
  return {
    provider: "mediastack",
    source: {
      name: article?.source || "Mediastack"
    },
    title: article?.title || "",
    description: article?.description || "",
    content: article?.description || "",
    url: article?.url || "",
    urlToImage: article?.image || null,
    publishedAt: article?.published_at || new Date().toISOString()
  };
}

export async function fetchMediastack({
  apiKey,
  baseUrl,
  query,
  language,
  pageSize,
  countries = [],
  timeoutMs = 9_000
}) {
  if (!apiKey) {
    throw new Error("mediastack-api-key-missing");
  }

  const url = buildMediastackUrl({
    baseUrl: baseUrl || "http://api.mediastack.com/v1",
    apiKey,
    query,
    language,
    pageSize,
    countries
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
    const error = new Error(`mediastack-upstream-${response.status}:${body.slice(0, 120)}`);
    error.rateLimit = rateLimit;
    throw error;
  }

  const payload = await response.json();
  if (!payload || !Array.isArray(payload.data)) {
    const error = new Error("mediastack-invalid-payload");
    error.rateLimit = rateLimit;
    throw error;
  }

  const articles = payload.data.map(normalizeMediastackArticle);

  return {
    provider: "mediastack",
    articles,
    sourceMeta: {
      provider: "mediastack",
      totalResults: payload?.pagination?.total ?? articles.length,
      rateLimit
    }
  };
}
