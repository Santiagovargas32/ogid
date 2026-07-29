import stateManager from "../state/stateManager.js";
import {
  applyCountryFilter,
  filterNewsBySources,
  parseCountries,
  parsePositiveInt,
  parseSources
} from "../utils/filters.js";
import { resolveClientIp } from "../utils/clientIp.js";
import { AppError } from "../utils/error.js";

function mapResponse(data) {
  return {
    ok: true,
    data
  };
}

function parseCsv(value) {
  return [...new Set(String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}

const AWARENESS_DOMAINS = new Set(["financial", "macro", "market", "corporate", "regulatory", "geopolitical", "security"]);
const AWARENESS_KINDS = new Set(["macro_scheduled", "macro_release", "market_moving_news", "regulatory_filing", "official_security_release", "maritime_alert"]);
const AWARENESS_STATUSES = new Set(["scheduled", "live", "released", "updated", "cancelled"]);

function validateAwarenessValues(values, allowed, name) {
  if (values.length > 50 || values.some((value) => value.length > 128 || (allowed && !allowed.has(value.toLowerCase())))) {
    throw new AppError(`${name} contains an unsupported value.`, 400, "INVALID_AWARENESS_FILTER");
  }
  return values;
}

function parseOptionalDate(value, name) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new AppError(`${name} must be a valid ISO date.`, 400, "INVALID_AWARENESS_DATE");
  return new Date(timestamp).toISOString();
}

function withActiveFilters(meta, countries, sources) {
  return {
    ...meta,
    activeCountries: countries,
    activeSources: sources
  };
}

function hasCountryScores(countriesMap = {}) {
  return Object.values(countriesMap || {}).some((country) => Number(country?.score || 0) > 0);
}

function buildInsightsEmptyReason({ filteredInsights = [], sourceSnapshot, countries = [] }) {
  if (filteredInsights.length) {
    return null;
  }

  const fullInsights = sourceSnapshot?.insights || [];
  if (fullInsights.length && countries.length) {
    return "Current watchlist filter removed all country insights. Switch to ALL to inspect global signals.";
  }

  if (!hasCountryScores(sourceSnapshot?.countries || {})) {
    return "No country-level risk signals available in the current news selection.";
  }

  return "No country insights available for the current filters.";
}

function buildImpactEmptyReason({ impact = { items: [] }, filteredNews = [] }) {
  if ((impact.items || []).length) {
    return null;
  }

  if (!filteredNews.length) {
    return "No intelligence items available for the current filters.";
  }

  return "No linked news-to-ticker signals in the current event window.";
}

function withEmptyStates(meta, emptyStates = {}) {
  return {
    ...meta,
    emptyStates
  };
}

function buildFilters(req, res) {
  const config = res.app.locals.config;
  const defaultCountries = config.watchlistCountries || [];
  const countries = parseCountries(req.query.countries, defaultCountries);
  const sources = parseSources(req.query.sources);
  const limit = parsePositiveInt(req.query.limit, 50, { min: 1, max: 500 });

  return {
    countries,
    sources,
    limit
  };
}

function applyNewsFilters(news, { sources, limit }) {
  const bySource = filterNewsBySources(news, sources);
  return bySource
    .slice()
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, limit);
}

function filterAiProjection(ai = {}, { news = [], countries = [], impact = { items: [] } } = {}) {
  const articleIds = new Set(news.map((article) => String(article.id || "")).filter(Boolean));
  const countryIds = new Set(countries || []);
  const visibleTickers = new Set((impact.items || []).map((item) => String(item.ticker || "").toUpperCase()).filter(Boolean));
  return {
    ...ai,
    articleSummaries: Object.fromEntries(Object.entries(ai.articleSummaries || {}).filter(([legacyId]) => articleIds.has(legacyId))),
    countryInsights: Object.fromEntries(Object.entries(ai.countryInsights || {}).filter(([iso2]) => !countryIds.size || countryIds.has(iso2))),
    marketExplanations: Object.fromEntries(Object.entries(ai.marketExplanations || {}).filter(([, entry]) => !countryIds.size || visibleTickers.has(String(entry?.ticker || "").toUpperCase())))
  };
}

export function getSnapshot(req, res) {
  const filters = buildFilters(req, res);
  const snapshot = stateManager.getSnapshot();
  const filtered = applyCountryFilter(snapshot, filters.countries);
  filtered.news = applyNewsFilters(filtered.news, filters);
  filtered.ai = filterAiProjection(filtered.ai || {}, {
    news: filtered.news,
    countries: filters.countries,
    impact: filtered.impact
  });
  const insightsEmptyReason = buildInsightsEmptyReason({
    filteredInsights: filtered.insights,
    sourceSnapshot: snapshot,
    countries: filters.countries
  });
  const impactEmptyReason = buildImpactEmptyReason({
    impact: filtered.impact,
    filteredNews: filtered.news
  });
  filtered.impact = {
    ...(filtered.impact || {}),
    emptyReason: impactEmptyReason
  };
  filtered.meta = withEmptyStates(
    withActiveFilters(filtered.meta, filters.countries, filters.sources),
    {
      insights: insightsEmptyReason,
      impact: impactEmptyReason
    }
  );

  res.json(mapResponse(filtered));
}

export function getHotspots(req, res) {
  const filters = buildFilters(req, res);
  const snapshot = stateManager.getSnapshot();
  const filtered = applyCountryFilter(snapshot, filters.countries);
  res.json(
    mapResponse({
      hotspots: filtered.hotspots,
      meta: withActiveFilters(filtered.meta, filters.countries, filters.sources)
    })
  );
}

export function getRisks(req, res) {
  const filters = buildFilters(req, res);
  const snapshot = stateManager.getSnapshot();
  const filtered = applyCountryFilter(snapshot, filters.countries);
  res.json(
    mapResponse({
      countries: filtered.countries,
      meta: withActiveFilters(filtered.meta, filters.countries, filters.sources)
    })
  );
}

export function getNews(req, res) {
  const filters = buildFilters(req, res);
  const snapshot = stateManager.getSnapshot();
  const filtered = applyCountryFilter(snapshot, filters.countries);
  const news = applyNewsFilters(filtered.news, filters);

  res.json(
    mapResponse({
      news,
      meta: withActiveFilters(filtered.meta, filters.countries, filters.sources)
    })
  );
}

export function getInsights(req, res) {
  const filters = buildFilters(req, res);
  const snapshot = stateManager.getSnapshot();
  const filtered = applyCountryFilter(snapshot, filters.countries);
  const insightsEmptyReason = buildInsightsEmptyReason({
    filteredInsights: filtered.insights,
    sourceSnapshot: snapshot,
    countries: filters.countries
  });
  res.json(
    mapResponse({
      insights: filtered.insights,
      meta: withEmptyStates(
        withActiveFilters(filtered.meta, filters.countries, filters.sources),
        {
          insights: insightsEmptyReason
        }
      )
    })
  );
}

export function getAwarenessSnapshot(req, res) {
  const service = res.app.locals.awarenessService;
  const limit = parsePositiveInt(req.query.limit, 100, { min: 1, max: 500 });
  const filters = {
    domains: validateAwarenessValues(parseCsv(req.query.domain), AWARENESS_DOMAINS, "domain").map((value) => value.toLowerCase()),
    kinds: validateAwarenessValues(parseCsv(req.query.kinds), AWARENESS_KINDS, "kinds").map((value) => value.toLowerCase()),
    statuses: validateAwarenessValues(parseCsv(req.query.status), AWARENESS_STATUSES, "status").map((value) => value.toLowerCase()),
    countries: validateAwarenessValues(parseCsv(req.query.countries).map((value) => value.toUpperCase()), null, "countries")
      .filter((value) => {
        if (!/^[A-Z]{2}$/.test(value)) throw new AppError("countries contains an unsupported value.", 400, "INVALID_AWARENESS_FILTER");
        return true;
      }),
    instrumentIds: validateAwarenessValues(parseCsv(req.query.instrumentIds), null, "instrumentIds")
      .filter((value) => {
        if (!/^[A-Za-z0-9._:^=/-]+$/.test(value)) throw new AppError("instrumentIds contains an unsupported value.", 400, "INVALID_AWARENESS_FILTER");
        return true;
      }),
    from: parseOptionalDate(req.query.from, "from"),
    to: parseOptionalDate(req.query.to, "to"),
    limit
  };
  if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) {
    throw new AppError("from must be earlier than or equal to to.", 400, "INVALID_AWARENESS_WINDOW");
  }
  const snapshot = service?.getSnapshot?.(filters, { publicView: true }) || stateManager.getSnapshot().awareness;
  res.json(mapResponse(snapshot));
}

function mapRefreshError(outcome) {
  return {
    ok: false,
    error: {
      code: outcome.code || "REFRESH_REJECTED",
      message: outcome.message || "Manual refresh request rejected.",
      details: {
        status: outcome.status || "rejected",
        retryAfterMs: outcome.retryAfterMs || 0,
        nextAllowedAt: outcome.nextAllowedAt || null
      }
    }
  };
}

export function postRefresh(req, res) {
  const refreshService = res.app.locals.manualRefreshService;
  if (!refreshService) {
    throw new AppError("Manual refresh service unavailable", 503, "REFRESH_UNAVAILABLE");
  }

  const config = res.app.locals.config;
  const defaultCountries = config.watchlistCountries || [];
  const countries = parseCountries(req.body?.countries ?? req.query.countries, defaultCountries);
  const reason = String(req.body?.reason || "manual").trim().toLowerCase() || "manual";
  const clientIpInfo = req.clientIpInfo || resolveClientIp(req);
  const clientId = String(clientIpInfo.clientIp || req.requestId || "anonymous");
  const outcome = refreshService.request({
    clientId,
    countries,
    reason
  });

  const retryAfterMs = Number(outcome.retryAfterMs || 0);
  if (retryAfterMs > 0) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1_000)));
  }

  if (!outcome.accepted) {
    res.status(outcome.httpStatus || 429).json(mapRefreshError(outcome));
    return;
  }

  res.status(202).json(
    mapResponse({
      accepted: true,
      status: outcome.status,
      refreshId: outcome.refreshId,
      requestedAt: outcome.requestedAt,
      retryAfterMs,
      nextAllowedAt: outcome.nextAllowedAt,
      countries
    })
  );
}
