import apiQuotaTracker from "../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../utils/logger.js";
import { fetchGnews } from "./providers/gnewsProvider.js";
import { fetchMediastack } from "./providers/mediastackProvider.js";
import { fetchNewsApi } from "./providers/newsApiProvider.js";

const log = createLogger("backend/services/news/newsAggregatorService");

const FALLBACK_SEEDS = [
  {
    source: { name: "Fallback Intelligence Desk" },
    title: "US and Iran exchange diplomatic warnings as regional naval patrols expand",
    description:
      "Washington and Tehran issued opposing security statements after naval maneuvers near strategic transit lanes.",
    content:
      "Analysts flagged elevated escalation rhetoric and sanction risk, with energy and defense sectors monitoring spillover."
  }
];

const PROVIDERS = {
  newsapi: async (config) =>
    fetchNewsApi({
      apiKey: config.newsApiKey,
      baseUrl: config.newsApiBaseUrl,
      query: config.query,
      language: config.language,
      pageSize: config.pageSize,
      timeoutMs: config.timeoutMs
    }),
  gnews: async (config) =>
    fetchGnews({
      apiKey: config.gnewsApiKey,
      baseUrl: config.gnewsBaseUrl,
      query: config.query,
      language: config.language,
      pageSize: config.pageSize,
      timeoutMs: config.timeoutMs
    }),
  mediastack: async (config) =>
    fetchMediastack({
      apiKey: config.mediastackApiKey,
      baseUrl: config.mediastackBaseUrl,
      query: config.query,
      language: config.language,
      pageSize: config.pageSize,
      countries: config.countries,
      timeoutMs: config.timeoutMs
    })
};

function normalizeProviders(providers = []) {
  if (Array.isArray(providers) && providers.length) {
    const normalized = providers
      .map((provider) => String(provider).toLowerCase())
      .filter((provider) => provider in PROVIDERS);
    if (normalized.length) {
      return normalized;
    }
  }
  return ["newsapi"];
}

function dedupeArticles(articles = []) {
  const seen = new Set();
  const unique = [];

  for (const article of articles) {
    const key = `${article.url || ""}|${article.title || ""}`.toLowerCase();
    if (!key.trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(article);
  }

  return unique;
}

function hashQuery(query = "") {
  let hash = 0;
  const value = String(query);
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function buildFallbackArticles() {
  const now = Date.now();
  return FALLBACK_SEEDS.map((seed, index) => ({
    ...seed,
    title: `[SIMULATED] ${seed.title}`,
    provider: "fallback",
    synthetic: true,
    dataMode: "fallback",
    url: `https://local.ogid/fallback/${index + 1}`,
    urlToImage: null,
    publishedAt: new Date(now - index * 180_000).toISOString()
  }));
}

function resolveRateLimit(meta) {
  return meta?.rateLimit || null;
}

export async function fetchAggregatedNews({
  providers = ["newsapi"],
  newsApiKey,
  newsApiBaseUrl,
  gnewsApiKey,
  gnewsBaseUrl,
  mediastackApiKey,
  mediastackBaseUrl,
  query,
  language,
  pageSize,
  countries,
  timeoutMs
}) {
  const providerOrder = normalizeProviders(providers);
  const attempts = [];

  for (const providerName of providerOrder) {
    const providerStartedAt = Date.now();
    log.info("news_provider_request_start", {
      provider: providerName,
      pageSize,
      language,
      queryHash: hashQuery(query)
    });

    try {
      const providerResult = await PROVIDERS[providerName]({
        newsApiKey,
        newsApiBaseUrl,
        gnewsApiKey,
        gnewsBaseUrl,
        mediastackApiKey,
        mediastackBaseUrl,
        query,
        language,
        pageSize,
        countries,
        timeoutMs
      });

      const rateLimit = resolveRateLimit(providerResult.sourceMeta);
      if (providerResult.articles?.length) {
        const deduped = dedupeArticles(providerResult.articles).map((article) => ({
          ...article,
          synthetic: false,
          dataMode: "live"
        }));

        attempts.push({
          provider: providerName,
          status: "ok",
          count: deduped.length
        });
        apiQuotaTracker.recordCall(providerName, { status: "success", headers: rateLimit });
        log.info("news_provider_success", {
          provider: providerName,
          count: deduped.length,
          durationMs: Date.now() - providerStartedAt
        });

        return {
          articles: deduped,
          sourceMode: "live",
          sourceMeta: {
            provider: providerName,
            attempts,
            totalResults: deduped.length,
            rateLimit
          }
        };
      }

      attempts.push({
        provider: providerName,
        status: "empty",
        count: 0
      });
      apiQuotaTracker.recordCall(providerName, { status: "empty", headers: rateLimit });
      log.info("news_provider_empty", {
        provider: providerName,
        durationMs: Date.now() - providerStartedAt
      });
    } catch (error) {
      attempts.push({
        provider: providerName,
        status: "error",
        reason: error.message
      });
      apiQuotaTracker.recordCall(providerName, {
        status: "error",
        headers: error.rateLimit,
        fallback: true
      });
      log.warn("news_provider_failed", {
        provider: providerName,
        reason: error.message
      });
    }
  }

  const fallbackArticles = buildFallbackArticles();
  for (const attempt of attempts) {
    apiQuotaTracker.markFallback(attempt.provider);
  }
  log.warn("news_fallback_engaged", {
    attempts,
    reason: "all-providers-failed",
    fallbackCount: fallbackArticles.length
  });

  return {
    articles: fallbackArticles,
    sourceMode: "fallback",
    sourceMeta: {
      provider: "fallback",
      attempts,
      reason: "all-providers-failed",
      totalResults: fallbackArticles.length
    }
  };
}
