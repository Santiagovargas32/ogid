import { BASELINE_COUNTRIES } from "../utils/countryCatalog.js";

export function classifyRisk(score) {
  if (score >= 71) {
    return "Critical";
  }
  if (score >= 41) {
    return "Elevated";
  }
  if (score >= 21) {
    return "Monitoring";
  }
  return "Stable";
}

function buildCountryAccumulator(country, timestamp) {
  return {
    iso2: country.iso2,
    country: country.name,
    lat: country.lat,
    lng: country.lng,
    score: 0,
    level: "Stable",
    trend: "Stable",
    metrics: {
      newsVolume: 0,
      negativeSentiment: 0,
      conflictTagWeight: 0
    },
    topTags: [],
    updatedAt: timestamp,
    tagCounts: {}
  };
}

function classifyTrend(delta) {
  if (delta >= 8) {
    return "Rising";
  }
  if (delta <= -8) {
    return "Declining";
  }
  return "Stable";
}

export function computeCountryRisk({ articles = [], previousCountries = {} }) {
  const timestamp = new Date().toISOString();
  const countries = Object.fromEntries(
    BASELINE_COUNTRIES.map((country) => [country.iso2, buildCountryAccumulator(country, timestamp)])
  );

  for (const article of articles) {
    const mentions = [...new Set(article.countryMentions || [])];
    if (!mentions.length) {
      continue;
    }

    const conflictWeight = article.conflict?.totalWeight ?? 0;
    const isNegative = article.sentiment?.label === "negative";
    const tags = article.conflict?.tags || [];

    for (const iso2 of mentions) {
      const target = countries[iso2];
      if (!target) {
        continue;
      }

      target.metrics.newsVolume += 1;
      if (isNegative) {
        target.metrics.negativeSentiment += 1;
      }
      target.metrics.conflictTagWeight += conflictWeight;

      for (const tagItem of tags) {
        target.tagCounts[tagItem.tag] = (target.tagCounts[tagItem.tag] || 0) + tagItem.count;
      }
    }
  }

  for (const country of Object.values(countries)) {
    country.score =
      country.metrics.newsVolume * 2 +
      country.metrics.negativeSentiment * 3 +
      country.metrics.conflictTagWeight * 4;
    country.level = classifyRisk(country.score);

    const previousScore = previousCountries[country.iso2]?.score ?? 0;
    country.trend = classifyTrend(country.score - previousScore);
    country.topTags = Object.entries(country.tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag, count]) => ({ tag, count }));

    delete country.tagCounts;
  }

  const hotspots = Object.values(countries)
    .sort((a, b) => b.score - a.score)
    .map((country) => ({
      iso2: country.iso2,
      country: country.country,
      lat: country.lat,
      lng: country.lng,
      score: country.score,
      level: country.level,
      metrics: country.metrics,
      topTags: country.topTags,
      updatedAt: country.updatedAt
    }));

  return {
    countries,
    hotspots
  };
}
