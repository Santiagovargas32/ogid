import stateManager from "../state/stateManager.js";
import {
  applyCountryFilter,
  filterNewsBySources,
  parseCountries,
  parsePositiveInt,
  parseSources
} from "../utils/filters.js";
import { AppError } from "../utils/error.js";

function mapResponse(data) {
  return {
    ok: true,
    data
  };
}

function withActiveFilters(meta, countries, sources) {
  return {
    ...meta,
    activeCountries: countries,
    activeSources: sources
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

export function getSnapshot(req, res) {
  const filters = buildFilters(req, res);
  const snapshot = stateManager.getSnapshot();
  const filtered = applyCountryFilter(snapshot, filters.countries);
  filtered.news = applyNewsFilters(filtered.news, filters);
  filtered.meta = withActiveFilters(filtered.meta, filters.countries, filters.sources);

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
  res.json(
    mapResponse({
      insights: filtered.insights,
      meta: withActiveFilters(filtered.meta, filters.countries, filters.sources)
    })
  );
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
  const clientId = String(req.ip || req.requestId || "anonymous");
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
