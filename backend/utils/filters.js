import { BASELINE_COUNTRIES } from "./countryCatalog.js";

const VALID_ISO2 = new Set(BASELINE_COUNTRIES.map((country) => country.iso2));

function normalizeCsv(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeCsv(entry));
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseCountries(rawValue, defaults = []) {
  const normalized = normalizeCsv(rawValue).map((value) => value.toUpperCase());

  if (!normalized.length) {
    return [...defaults];
  }

  if (normalized.includes("ALL")) {
    return [...VALID_ISO2];
  }

  const filtered = normalized.filter((iso2) => VALID_ISO2.has(iso2));
  return filtered.length ? [...new Set(filtered)] : [...defaults];
}

export function parseSources(rawValue, defaults = ["newsapi", "gnews", "mediastack", "rss", "gdelt", "fallback"]) {
  const normalized = normalizeCsv(rawValue).map((value) => value.toLowerCase());
  const allowed = new Set(["newsapi", "gnews", "mediastack", "rss", "gdelt", "fallback"]);
  const filtered = normalized.filter((source) => allowed.has(source));
  return filtered.length ? [...new Set(filtered)] : [...defaults];
}

export function parseTickers(rawValue, defaults = []) {
  const normalized = normalizeCsv(rawValue).map((value) => value.toUpperCase());
  return normalized.length ? [...new Set(normalized)] : [...defaults];
}

export function parsePositiveInt(rawValue, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(rawValue ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < min) {
    return min;
  }
  if (parsed > max) {
    return max;
  }
  return parsed;
}

function includesAnyCountry(article, countriesSet) {
  const mentions = article?.countryMentions || [];
  if (!mentions.length) {
    return false;
  }
  return mentions.some((iso2) => countriesSet.has(iso2));
}

export function filterNewsByCountries(news = [], countries = []) {
  if (!countries.length) {
    return news;
  }

  const set = new Set(countries);
  return news.filter((article) => includesAnyCountry(article, set));
}

export function filterHotspotsByCountries(hotspots = [], countries = []) {
  if (!countries.length) {
    return hotspots;
  }
  const set = new Set(countries);
  return hotspots.filter((hotspot) => set.has(hotspot.iso2));
}

export function filterCountriesMap(countriesMap = {}, countries = []) {
  if (!countries.length) {
    return countriesMap;
  }
  const set = new Set(countries);
  return Object.fromEntries(
    Object.entries(countriesMap).filter(([iso2]) => set.has(iso2))
  );
}

export function filterInsightsByCountries(insights = [], countries = []) {
  if (!countries.length) {
    return insights;
  }
  const set = new Set(countries);
  return insights.filter((insight) => (insight.iso2 ? set.has(insight.iso2) : false));
}

export function filterImpactByCountries(impact = { items: [] }, countries = []) {
  if (!countries.length) {
    return impact;
  }

  const set = new Set(countries);
  const items = (impact.items || []).filter((item) =>
    (item.linkedCountries || []).some((iso2) => set.has(iso2))
  );

  return {
    ...impact,
    items
  };
}

export function filterMapAssetsByCountries(mapAssets = { staticPoints: [], movingSeeds: [] }, countries = []) {
  if (!countries.length) {
    return mapAssets;
  }

  const set = new Set(countries);
  const filterAssets = (items = []) =>
    items.filter((item) => {
      const linkedCountries = item?.countries?.length ? item.countries : item?.country ? [item.country] : [];
      return linkedCountries.some((iso2) => set.has(String(iso2 || "").toUpperCase()));
    });

  return {
    ...mapAssets,
    staticPoints: filterAssets(mapAssets.staticPoints || []),
    movingSeeds: filterAssets(mapAssets.movingSeeds || [])
  };
}

export function filterNewsBySources(news = [], sources = []) {
  if (!sources.length) {
    return news;
  }

  const set = new Set(sources);
  return news.filter((article) => set.has(String(article.provider || "").toLowerCase()));
}

export function applyCountryFilter(snapshot, countries = []) {
  const filteredNews = filterNewsByCountries(snapshot.news, countries);
  const filteredHotspots = filterHotspotsByCountries(snapshot.hotspots, countries);
  const filteredCountries = filterCountriesMap(snapshot.countries, countries);
  const filteredInsights = filterInsightsByCountries(snapshot.insights, countries);
  const filteredImpact = filterImpactByCountries(snapshot.impact || { items: [] }, countries);
  const filteredMapAssets = filterMapAssetsByCountries(snapshot.mapAssets || { staticPoints: [], movingSeeds: [] }, countries);

  return {
    ...snapshot,
    news: filteredNews,
    hotspots: filteredHotspots,
    countries: filteredCountries,
    insights: filteredInsights,
    impact: filteredImpact,
    mapAssets: filteredMapAssets
  };
}
