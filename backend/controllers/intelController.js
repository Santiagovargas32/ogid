import stateManager from "../state/stateManager.js";
import {
  applyCountryFilter,
  filterNewsBySources,
  parseCountries,
  parsePositiveInt,
  parseSources
} from "../utils/filters.js";

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
