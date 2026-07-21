import { BASELINE_COUNTRIES } from "../../utils/countryCatalog.js";

export const COUNTRY_INSTABILITY_METHODOLOGY = Object.freeze({
  version: "country-instability-v2",
  normalization: "100*(1-exp(-log1p(value)/log1p(reference)))",
  upstreamBaseline: Object.freeze({
    version: "country-risk-score-v1",
    formula: "newsVolume*2 + negativeSentiment*3 + conflictTagWeight*4"
  }),
  weights: Object.freeze({ baselineRisk: 0.4, unrestSignals: 0.2, securitySignals: 0.2, informationFlow: 0.2 }),
  references: Object.freeze({ baselineRiskScore: 2_000, unrestPerHour: 0.25, securityPerHour: 0.5, informationFlowPerHour: 4 })
});

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function logNormalize(value, reference) {
  const numeric = Math.max(0, Number(value || 0));
  const ceiling = Math.max(0.0001, Number(reference || 1));
  return clamp(100 * (1 - Math.exp(-Math.log1p(numeric) / Math.log1p(ceiling))));
}

function isWithinWindow(item = {}, windowHours, now) {
  if (!Number.isFinite(Number(windowHours)) || Number(windowHours) <= 0) return true;
  const timestampMs = new Date(item.publishedAt || item.timestamp || 0).getTime();
  const thresholdMs = Number(now) - Number(windowHours) * 60 * 60 * 1_000;
  return Number.isFinite(timestampMs) && timestampMs >= thresholdMs && timestampMs <= Number(now) + 5 * 60 * 1_000;
}

function resolveArticles({ articles, aggregateNews, signalCorpus, snapshot, windowHours, now }) {
  const source = Array.isArray(articles)
    ? articles
    : [...(aggregateNews.items || []), ...(Array.isArray(signalCorpus) ? signalCorpus : snapshot.signalCorpus || [])];
  return source.filter((item) => isWithinWindow(item, windowHours, now));
}

function countryNewsMetrics(countryIso2, articles = []) {
  const relevant = articles.filter((item) => (item.countryMentions || []).includes(countryIso2));
  const unrestSignals = relevant.filter((item) =>
    (item.topicTags || []).some((tag) => ["civil_unrest", "humanitarian"].includes(String(tag || "").toLowerCase()))
  ).length;
  const securitySignals = relevant.filter((item) =>
    (item.topicTags || []).some((tag) => ["conflict", "cyber"].includes(String(tag || "").toLowerCase())) ||
    Number(item.conflict?.totalWeight || 0) > 0
  ).length;
  const credibilityWeighted = relevant.reduce(
    (sum, item) => sum + Number(item.credibilityScore ?? 0.55) * (Number(item.threatScore ?? item.conflict?.totalWeight ?? 1) + 1),
    0
  );
  return { unrestSignals, securitySignals, newsVelocity: relevant.length, credibilityWeighted };
}

export function computeCountryInstability({
  snapshot = {},
  aggregateNews = { items: [] },
  signalCorpus = null,
  articles = null,
  windowHours = null,
  now = Date.now()
} = {}) {
  const countries = {};
  const resolvedWindowHours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : 24;
  const corpus = resolveArticles({ articles, aggregateNews, signalCorpus, snapshot, windowHours, now });
  const references = COUNTRY_INSTABILITY_METHODOLOGY.references;
  const weights = COUNTRY_INSTABILITY_METHODOLOGY.weights;

  for (const country of BASELINE_COUNTRIES) {
    const currentRisk = snapshot.countries?.[country.iso2] || { score: 0, metrics: {} };
    const metrics = countryNewsMetrics(country.iso2, corpus);
    const unrestRatePerHour = metrics.unrestSignals / resolvedWindowHours;
    const securityRatePerHour = metrics.securitySignals / resolvedWindowHours;
    const informationFlowPerHour = metrics.credibilityWeighted / resolvedWindowHours;
    const baselineRisk = logNormalize(currentRisk.score || 0, references.baselineRiskScore);
    const unrest = logNormalize(unrestRatePerHour, references.unrestPerHour);
    const security = logNormalize(securityRatePerHour, references.securityPerHour);
    const informationFlow = logNormalize(informationFlowPerHour, references.informationFlowPerHour);
    const cii = clamp(
      baselineRisk * weights.baselineRisk + unrest * weights.unrestSignals +
      security * weights.securitySignals + informationFlow * weights.informationFlow
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
      metrics: {
        ...metrics,
        unrestRatePerHour: Number(unrestRatePerHour.toFixed(3)),
        securityRatePerHour: Number(securityRatePerHour.toFixed(3)),
        informationFlowPerHour: Number(informationFlowPerHour.toFixed(3)),
        sampleSize: metrics.newsVelocity
      },
      explanation: {
        formula: "baselineRisk*0.40 + unrest*0.20 + security*0.20 + informationFlow*0.20",
        windowHours: resolvedWindowHours,
        methodologyVersion: COUNTRY_INSTABILITY_METHODOLOGY.version
      }
    };
  }

  const ranking = Object.values(countries).sort((left, right) => right.cii - left.cii);
  return {
    generatedAt: new Date(Number(now)).toISOString(),
    methodology: COUNTRY_INSTABILITY_METHODOLOGY,
    windowHours: resolvedWindowHours,
    sampleSize: corpus.length,
    countries,
    ranking
  };
}
