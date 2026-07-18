import apiQuotaTracker from "../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../utils/logger.js";
import { normalizeNewsQueryPacks } from "./newsQueryPackService.js";
import { fetchGdelt } from "./providers/gdeltProvider.js";
import { fetchGnews } from "./providers/gnewsProvider.js";
import { fetchMediastack } from "./providers/mediastackProvider.js";
import { fetchNewsApi, NEWSAPI_MAX_QUERY_LENGTH } from "./providers/newsApiProvider.js";
import { fetchRss } from "./providers/rssProvider.js";

const log = createLogger("backend/services/news/newsAggregatorService");
const GNEWS_MAX_QUERY_LENGTH = 180;

const FALLBACK_SEEDS = [
  {
    source: { name: "Fallback Intelligence Desk" },
    title: "ERROR DE APIS CALLS",
    description:
      "L  + S",
    content:
      "<3",
    usagePolicy: "headline-only-link-out"
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
      domains: config.domainAllowlist,
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
    }),
  rss: async (config) =>
    fetchRss({
      feeds: config.rssFeeds,
      timeoutMs: config.timeoutMs
    }),
  gdelt: async (config) =>
    fetchGdelt({
      baseUrl: config.gdeltBaseUrl,
      query: config.query,
      pageSize: config.pageSize,
      timeoutMs: config.timeoutMs
    })
};

function normalizeProviders(providers = []) {
  if (Array.isArray(providers) && providers.length) {
    const normalized = providers
      .map((provider) => String(provider).toLowerCase())
      .filter((provider) => provider in PROVIDERS);
    if (normalized.length) {
      return [...new Set(normalized)];
    }
  }
  return ["newsapi"];
}

function resolveProviderOrder(providerOrder = [], allowExhaustedProviders = true) {
  const providersAvailable = [];
  const providersSkipped = [];

  for (const provider of providerOrder) {
    if (allowExhaustedProviders) {
      providersAvailable.push(provider);
      continue;
    }

    const snapshot = apiQuotaTracker.getProviderSnapshot(provider);
    if (snapshot?.exhausted) {
      providersSkipped.push({
        provider,
        reason: "exhausted",
        remaining: snapshot?.effectiveRemaining ?? null
      });
      continue;
    }

    providersAvailable.push(provider);
  }

  return {
    providersAvailable,
    providersSkipped
  };
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
    dataMode: "synthetic",
    url: `https://local.ogid/fallback/${index + 1}`,
    urlToImage: null,
    publishedAt: new Date(now - index * 180_000).toISOString()
  }));
}

function resolveRateLimit(meta) {
  return meta?.rateLimit || null;
}

function normalizeAllowlist(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function sourceKey(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildKeywordTokens(query = "", queryPacks = {}) {
  const combinedValues = [query, ...Object.values(queryPacks || {})]
    .flat()
    .map((value) => String(value || ""))
    .join(" ");

  return [...new Set(
    combinedValues
      .toLowerCase()
      .replace(/[()]/g, " ")
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !["and", "with", "from", "that", "this", "into", "near", "will", "news", "headlines", "sortby", "sort"].includes(token) && !["or", "and", "not"].includes(token))
  )];
}

function matchesKeywordFilter(article, keywordTokens = []) {
  if (!keywordTokens.length) {
    return true;
  }

  const text = `${article.title || ""} ${article.description || ""} ${article.content || ""}`.toLowerCase();
  return keywordTokens.some((token) => text.includes(token));
}

function matchesSourceAllowlist(article, allowlist = []) {
  if (!allowlist.length) {
    return true;
  }

  const normalizedSource = sourceKey(article?.source?.name || article?.sourceName || "");
  return allowlist.some((allowed) => normalizedSource.includes(allowed));
}

function matchesDomainAllowlist(article, allowlist = []) {
  if (!allowlist.length) {
    return true;
  }

  const hostname = hostnameFromUrl(article?.url || "");
  if (!hostname) {
    return false;
  }

  return allowlist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function applyEditorialFilters(articles = [], { sourceAllowlist = [], domainAllowlist = [], keywordTokens = [] } = {}) {
  const normalizedSources = normalizeAllowlist(sourceAllowlist);
  const normalizedDomains = normalizeAllowlist(domainAllowlist);

  return articles.filter((article) => {
    if (!matchesKeywordFilter(article, keywordTokens)) {
      return false;
    }
    if (!matchesSourceAllowlist(article, normalizedSources)) {
      return false;
    }
    return matchesDomainAllowlist(article, normalizedDomains);
  });
}

function buildNewsQueryClauses({ query, queryPacks = {} }) {
  return [query, ...Object.values(queryPacks || {})]
    .map((value) => ({ value: String(value || "").trim() }))
    .filter((clause) => clause.value);
}

function serializeNewsQueryClauses(clauses = []) {
  return clauses.map((clause) => `(${clause.value})`).join(" OR ");
}

function splitTopLevelOrTerms(value = "") {
  const expression = String(value || "").trim();
  const terms = [];
  let start = 0;
  let quoteOpen = false;
  let escaped = false;
  let parenthesisDepth = 0;
  let validExpression = true;

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoteOpen && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoteOpen = !quoteOpen;
      continue;
    }
    if (quoteOpen) {
      continue;
    }
    if (character === "(") {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ")") {
      if (parenthesisDepth === 0) {
        validExpression = false;
      } else {
        parenthesisDepth -= 1;
      }
      continue;
    }
    if (parenthesisDepth === 0 && expression.slice(index, index + 4).toUpperCase() === " OR ") {
      terms.push(expression.slice(start, index).trim());
      start = index + 4;
      index += 3;
    }
  }

  if (quoteOpen || parenthesisDepth !== 0 || !validExpression) {
    return [expression];
  }

  terms.push(expression.slice(start).trim());
  return terms.filter(Boolean);
}

function composeNewsQuery({ query, queryPacks = {} }) {
  return serializeNewsQueryClauses(buildNewsQueryClauses({ query, queryPacks }));
}

function composeNewsQueryWithinLimit({ query, queryPacks = {}, maxLength }) {
  const clauses = buildNewsQueryClauses({ query, queryPacks });
  const originalQuery = serializeNewsQueryClauses(clauses);
  const selectedClauses = [];
  let omittedClauseCount = 0;
  let truncatedClauseCount = 0;

  for (const clause of clauses) {
    const fullCandidate = serializeNewsQueryClauses([...selectedClauses, clause]);
    if (fullCandidate.length <= maxLength) {
      selectedClauses.push(clause);
      continue;
    }

    const terms = splitTopLevelOrTerms(clause.value);
    const selectedTerms = [];
    for (const term of terms) {
      const partialClause = {
        ...clause,
        value: [...selectedTerms, term].join(" OR ")
      };
      const partialCandidate = serializeNewsQueryClauses([...selectedClauses, partialClause]);
      if (partialCandidate.length > maxLength) {
        break;
      }
      selectedTerms.push(term);
    }

    if (!selectedTerms.length) {
      omittedClauseCount += 1;
      continue;
    }

    selectedClauses.push({
      ...clause,
      value: selectedTerms.join(" OR ")
    });
    if (selectedTerms.length < terms.length) {
      truncatedClauseCount += 1;
    }
  }

  const boundedQuery = serializeNewsQueryClauses(selectedClauses);
  return {
    query: boundedQuery,
    originalQueryLength: originalQuery.length,
    queryTruncated: boundedQuery !== originalQuery,
    omittedClauseCount,
    truncatedClauseCount
  };
}

function resolveNormalizedQueryPacks(queryPacks = {}, marketTickers = []) {
  return normalizeNewsQueryPacks(queryPacks, {
    marketTickers,
    defaultEditorialPacks: {}
  }).flattened;
}

function trimQueryToLimit(query = "", maxLength = GNEWS_MAX_QUERY_LENGTH) {
  const normalized = String(query || "").trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }

  const sliced = normalized.slice(0, maxLength);
  const lastBoundary = Math.max(sliced.lastIndexOf(" OR "), sliced.lastIndexOf(" "));
  return (lastBoundary > 0 ? sliced.slice(0, lastBoundary) : sliced).trim();
}

function resolveProviderQuery(providerName, { baseQuery, composedQuery, queryPacks }) {
  if (providerName === "newsapi") {
    const boundedQuery = composeNewsQueryWithinLimit({
      query: baseQuery,
      queryPacks,
      maxLength: NEWSAPI_MAX_QUERY_LENGTH
    });
    return {
      ...boundedQuery,
      skipReason: boundedQuery.query ? null : "missing-query"
    };
  }

  if (providerName === "gnews" || providerName === "gdelt") {
    const normalizedBaseQuery = String(baseQuery || "").trim();
    if (!normalizedBaseQuery) {
      return {
        query: "",
        skipReason: "missing-base-query",
        originalQueryLength: 0,
        queryTruncated: false,
        omittedClauseCount: 0,
        truncatedClauseCount: 0
      };
    }

    const trimmedQuery = trimQueryToLimit(normalizedBaseQuery, GNEWS_MAX_QUERY_LENGTH);
    return {
      query: trimmedQuery,
      skipReason: null,
      originalQueryLength: normalizedBaseQuery.length,
      queryTruncated: trimmedQuery !== normalizedBaseQuery,
      omittedClauseCount: 0,
      truncatedClauseCount: 0
    };
  }

  const providerQuery = composedQuery || baseQuery;
  return {
    query: providerQuery,
    skipReason: null,
    originalQueryLength: providerQuery.length,
    queryTruncated: false,
    omittedClauseCount: 0,
    truncatedClauseCount: 0
  };
}

function countArticlesByProvider(articles = []) {
  return articles.reduce((accumulator, article) => {
    const provider = String(article?.provider || "unknown").toLowerCase();
    accumulator[provider] = (accumulator[provider] || 0) + 1;
    return accumulator;
  }, {});
}

export async function fetchAggregatedNews({
  providers = ["newsapi"],
  newsApiKey,
  newsApiBaseUrl,
  gnewsApiKey,
  gnewsBaseUrl,
  mediastackApiKey,
  mediastackBaseUrl,
  gdeltBaseUrl,
  rssFeeds = [],
  query,
  queryPacks = {},
  marketTickers = [],
  language,
  pageSize,
  countries,
  sourceAllowlist = [],
  domainAllowlist = [],
  timeoutMs,
  allowExhaustedProviders = true
}) {
  const normalizedProviders = normalizeProviders(providers);
  const normalizedQueryPacks = resolveNormalizedQueryPacks(queryPacks, marketTickers);
  const providerResolution = resolveProviderOrder(normalizedProviders, allowExhaustedProviders);
  const attempts = [];
  const aggregatedArticles = [];
  const keywordTokens = buildKeywordTokens(query, normalizedQueryPacks);
  const baseQuery = String(query || "").trim();
  const composedQuery = composeNewsQuery({ query, queryPacks: normalizedQueryPacks }) || baseQuery;
  const rateLimitsByProvider = {};
  const providerRequests = Object.fromEntries(
    normalizedProviders.map((providerName) => [
      providerName,
      resolveProviderQuery(providerName, { baseQuery, composedQuery, queryPacks: normalizedQueryPacks })
    ])
  );
  const upstreamRawArticles = [];
  const rawCountByProvider = Object.fromEntries(normalizedProviders.map((providerName) => [providerName, 0]));
  const queryLengthByProvider = Object.fromEntries(
    normalizedProviders.map((providerName) => [providerName, providerRequests[providerName]?.query?.length || 0])
  );
  const queryOriginalLengthByProvider = Object.fromEntries(
    normalizedProviders.map((providerName) => [
      providerName,
      providerRequests[providerName]?.originalQueryLength ?? providerRequests[providerName]?.query?.length ?? 0
    ])
  );
  const queryTruncatedByProvider = Object.fromEntries(
    normalizedProviders.map((providerName) => [providerName, providerRequests[providerName]?.queryTruncated === true])
  );
  const filteredCountByProvider = Object.fromEntries(normalizedProviders.map((providerName) => [providerName, 0]));
  const dynamicProvidersSkipped = [];
  const rssFeedStatus = [];
  const policySkippedProviders = new Map(
    providerResolution.providersSkipped.map((provider) => [provider.provider, provider])
  );

  for (const providerName of normalizedProviders) {
    const providerRequest = providerRequests[providerName] || {
      query: "",
      skipReason: null
    };
    const providerQuery = providerRequest.query || "";
    const requestQueryMeta = {
      queryLength: providerQuery.length,
      queryOriginalLength: providerRequest.originalQueryLength ?? providerQuery.length,
      queryTruncated: providerRequest.queryTruncated === true,
      omittedQueryClauseCount: providerRequest.omittedClauseCount || 0,
      truncatedQueryClauseCount: providerRequest.truncatedClauseCount || 0
    };

    if (policySkippedProviders.has(providerName)) {
      const skipped = policySkippedProviders.get(providerName);
      attempts.push({
        provider: providerName,
        status: "skipped",
        reason: skipped.reason || "skipped",
        rawCount: 0,
        count: 0,
        nextAllowedAt: skipped.nextAllowedAt || null,
        ...requestQueryMeta
      });
      continue;
    }

    if (providerRequest.skipReason) {
      dynamicProvidersSkipped.push({
        provider: providerName,
        reason: providerRequest.skipReason,
        nextAllowedAt: null
      });
      attempts.push({
        provider: providerName,
        status: "skipped",
        reason: providerRequest.skipReason,
        rawCount: 0,
        count: 0,
        nextAllowedAt: null,
        ...requestQueryMeta
      });
      log.info("news_provider_skipped", {
        provider: providerName,
        reason: providerRequest.skipReason,
        nextAllowedAt: null
      });
      continue;
    }

    const providerStartedAt = Date.now();
    log.info("news_provider_request_start", {
      provider: providerName,
      pageSize,
      language,
      queryHash: hashQuery(providerQuery),
      ...requestQueryMeta
    });

    try {
      const providerResult = await PROVIDERS[providerName]({
        newsApiKey,
        newsApiBaseUrl,
        gnewsApiKey,
        gnewsBaseUrl,
        mediastackApiKey,
        mediastackBaseUrl,
        gdeltBaseUrl,
        rssFeeds,
        query: providerQuery,
        language,
        pageSize,
        countries,
        sourceAllowlist,
        domainAllowlist,
        timeoutMs
      });

      const rateLimit = resolveRateLimit(providerResult.sourceMeta);
      const providerRawArticles = (providerResult.articles || []).map((article) => ({
        ...article,
        provider: article?.provider || providerName
      }));
      const rawCount = providerRawArticles.length;
      upstreamRawArticles.push(...providerRawArticles);
      const filteredArticles = applyEditorialFilters(providerRawArticles, {
        sourceAllowlist,
        domainAllowlist,
        keywordTokens
      }).map((article) => ({
        ...article,
        synthetic: false,
        dataMode: "observed"
      }));

      rateLimitsByProvider[providerName] = rateLimit;
      rawCountByProvider[providerName] = rawCount;
      filteredCountByProvider[providerName] = filteredArticles.length;
      if (providerName === "rss" && Array.isArray(providerResult.sourceMeta?.feedStatus)) {
        rssFeedStatus.push(...providerResult.sourceMeta.feedStatus);
      }
      attempts.push({
        provider: providerName,
        status: filteredArticles.length ? "ok" : "empty",
        count: filteredArticles.length,
        rawCount,
        ...requestQueryMeta
      });

      apiQuotaTracker.recordCall(providerName, {
        status: filteredArticles.length ? "success" : "empty",
        headers: rateLimit
      });
      log.info("news_provider_summary", {
        provider: providerName,
        count: filteredArticles.length,
        rawCount,
        durationMs: Date.now() - providerStartedAt
      });

      aggregatedArticles.push(...filteredArticles);
    } catch (error) {
      if (error.skipProvider) {
        dynamicProvidersSkipped.push({
          provider: providerName,
          reason: error.skipReason || "skipped",
          nextAllowedAt: error.nextAllowedAt || null
        });
        attempts.push({
          provider: providerName,
          status: "skipped",
          reason: error.skipReason || error.message,
          rawCount: 0,
          count: 0,
          nextAllowedAt: error.nextAllowedAt || null,
          ...requestQueryMeta
        });
        log.info("news_provider_skipped", {
          provider: providerName,
          reason: error.skipReason || error.message,
          nextAllowedAt: error.nextAllowedAt || null
        });
        continue;
      }

      attempts.push({
        provider: providerName,
        status: "error",
        reason: error.code || error.message,
        message: error.message,
        ...requestQueryMeta
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

  const dedupedArticles = dedupeArticles(aggregatedArticles);
  if (dedupedArticles.length) {
    const dedupedCountByProvider = countArticlesByProvider(dedupedArticles);
    const providersUsed = attempts
      .filter((attempt) => attempt.status === "ok")
      .map((attempt) => attempt.provider);

    return {
      articles: dedupedArticles,
      rawArticles: upstreamRawArticles,
      sourceMode: "live",
      sourceMeta: {
        provider: providersUsed.join("+") || "aggregated",
        providersUsed,
        providersSkipped: [...providerResolution.providersSkipped, ...dynamicProvidersSkipped],
        attempts,
        totalResults: dedupedArticles.length,
        rateLimitsByProvider,
        queryHash: hashQuery(composedQuery),
        rawCountByProvider,
        filteredCountByProvider: {
          ...filteredCountByProvider,
          ...dedupedCountByProvider
        },
        queryLengthByProvider,
        queryOriginalLengthByProvider,
        queryTruncatedByProvider,
        rssFeedStatus
      }
    };
  }

  const fallbackArticles = buildFallbackArticles();
  for (const attempt of attempts.filter((candidate) => candidate.status !== "skipped")) {
    apiQuotaTracker.markFallback(attempt.provider);
  }
  log.warn("news_fallback_engaged", {
    attempts,
    providersSkipped: [...providerResolution.providersSkipped, ...dynamicProvidersSkipped],
    reason: "all-providers-failed",
    fallbackCount: fallbackArticles.length
  });

  return {
    articles: fallbackArticles,
    rawArticles: upstreamRawArticles,
    sourceMode: "fallback",
    sourceMeta: {
      provider: "fallback",
      providersSkipped: [...providerResolution.providersSkipped, ...dynamicProvidersSkipped],
      attempts,
      reason: "all-providers-failed",
      totalResults: fallbackArticles.length,
      rawCountByProvider,
      filteredCountByProvider,
      queryLengthByProvider,
      queryOriginalLengthByProvider,
      queryTruncatedByProvider,
      rssFeedStatus
    }
  };
}
