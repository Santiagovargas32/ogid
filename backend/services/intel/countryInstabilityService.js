import { BASELINE_COUNTRIES } from "../../utils/countryCatalog.js";

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function normalizeCountryScore(score = 0) {
  return clamp((Number(score || 0) / 80) * 100);
}

function countryNewsMetrics(countryIso2, aggregateNews = { items: [] }, signalCorpus = []) {
  const recentAggregate = (aggregateNews.items || []).filter((item) => (item.countryMentions || []).includes(countryIso2));
  const recentSignals = (signalCorpus || []).filter((item) => (item.countryMentions || []).includes(countryIso2));

  const unrestSignals = recentAggregate.filter((item) =>
    (item.topicTags || []).some((tag) => ["civil_unrest", "humanitarian"].includes(String(tag || "").toLowerCase()))
  ).length;
  const securitySignals = recentAggregate.filter((item) =>
    (item.topicTags || []).some((tag) => ["conflict", "cyber"].includes(String(tag || "").toLowerCase()))
  ).length + recentSignals.filter((item) => Number(item.conflict?.totalWeight || 0) > 0).length;
  const newsVelocity = recentAggregate.length + recentSignals.length;
  const credibilityWeighted = recentAggregate.reduce(
    (sum, item) => sum + Number(item.credibilityScore || 0.55) * (Number(item.threatScore || 1) + 1),
    0
  );

  return {
    unrestSignals,
    securitySignals,
    newsVelocity,
    credibilityWeighted
  };
}

export function computeCountryInstability({ snapshot = {}, aggregateNews = { items: [] } } = {}) {
  const countries = {};

  for (const country of BASELINE_COUNTRIES) {
    const currentRisk = snapshot.countries?.[country.iso2] || { score: 0, metrics: {} };
    const newsMetrics = countryNewsMetrics(country.iso2, aggregateNews, snapshot.signalCorpus || []);

    const baselineRisk = normalizeCountryScore(currentRisk.score || 0);
    const unrest = clamp((newsMetrics.unrestSignals / 6) * 100);
    const security = clamp(
      ((newsMetrics.securitySignals + Number(currentRisk.metrics?.conflictTagWeight || 0)) / 10) * 100
    );
    const informationFlow = clamp(
      ((newsMetrics.newsVelocity * 7 + newsMetrics.credibilityWeighted * 12) / 20)
    );

    const cii = clamp(
      baselineRisk * 0.4 +
        unrest * 0.2 +
        security * 0.2 +
        informationFlow * 0.2
    );

    countries[country.iso2] = {
      iso2: country.iso2,
      country: country.name,
      lat: country.lat,
      lng: country.lng,
      cii: Number(cii.toFixed(2)),
      currentRiskScore: Number(currentRisk.score || 0),
      components: {
        baselineRisk: Number(baselineRisk.toFixed(2)),
        unrestSignals: Number(unrest.toFixed(2)),
        securitySignals: Number(security.toFixed(2)),
        informationFlow: Number(informationFlow.toFixed(2))
      },
      metrics: newsMetrics
    };
  }

  const ranking = Object.values(countries).sort((left, right) => right.cii - left.cii);
  return {
    generatedAt: new Date().toISOString(),
    countries,
    ranking
  };
}
