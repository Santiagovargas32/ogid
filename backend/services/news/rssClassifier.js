import { BASELINE_COUNTRIES, detectCountryMentions, getCountryByIso2 } from "../../utils/countryCatalog.js";
import { NEWS_SOURCE_CATALOG, coerceLegacyRssFeeds, projectLegacyGeneratedSearches } from "./newsSourceCatalog.js";

const SOURCE_CREDIBILITY = Object.freeze({
  reuters: 0.98,
  "associated press": 0.97,
  ap: 0.96,
  bloomberg: 0.95,
  "financial times": 0.94,
  bbc: 0.9,
  dw: 0.89,
  france24: 0.86,
  aljazeera: 0.85,
  cnn: 0.82,
  fox: 0.72
});

const TOPIC_RULES = Object.freeze([
  { tag: "conflict", keywords: ["conflict", "missile", "drone", "airstrike", "troop", "artillery"] },
  { tag: "cyber", keywords: ["cyber", "ransomware", "hacked", "malware", "intrusion"] },
  { tag: "sanctions", keywords: ["sanction", "asset freeze", "embargo", "export control"] },
  { tag: "energy", keywords: ["oil", "gas", "lng", "pipeline", "refinery", "opec"] },
  { tag: "shipping", keywords: ["shipping", "strait", "tanker", "maritime", "port"] },
  { tag: "economics", keywords: ["tariff", "inflation", "default", "debt", "market"] },
  { tag: "space", keywords: ["satellite", "rocket", "space launch", "orbital"] },
  { tag: "civil_unrest", keywords: ["protest", "riot", "demonstration", "uprising", "strike"] },
  { tag: "humanitarian", keywords: ["refugee", "displaced", "aid", "famine", "food insecurity"] },
  { tag: "environment", keywords: ["earthquake", "flood", "storm", "wildfire", "drought"] }
]);

const THREAT_LEVELS = Object.freeze([
  { id: "critical", minScore: 8 },
  { id: "elevated", minScore: 5 },
  { id: "monitoring", minScore: 2 },
  { id: "low", minScore: 0 }
]);

function normalizeText(value = "") {
  return ` ${String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

export function rankSourceCredibility(sourceName = "") {
  const normalized = String(sourceName || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  if (!normalized) {
    return 0.55;
  }

  const exact = SOURCE_CREDIBILITY[normalized];
  if (Number.isFinite(exact)) {
    return exact;
  }

  const partial = Object.entries(SOURCE_CREDIBILITY).find(([key]) => normalized.includes(key));
  return partial ? partial[1] : 0.55;
}

export function extractTopicTags(text = "") {
  const haystack = normalizeText(text);
  return TOPIC_RULES.filter((rule) => rule.keywords.some((keyword) => haystack.includes(normalizeText(keyword))))
    .map((rule) => rule.tag)
    .slice(0, 4);
}

export function classifyThreat({ text = "", topicTags = [] } = {}) {
  const haystack = normalizeText(text);
  let score = 0;

  if (topicTags.includes("conflict")) {
    score += 3;
  }
  if (topicTags.includes("cyber")) {
    score += 2;
  }
  if (topicTags.includes("sanctions")) {
    score += 2;
  }
  if (topicTags.includes("civil_unrest")) {
    score += 2;
  }
  if (topicTags.includes("humanitarian")) {
    score += 1;
  }

  if (haystack.includes(normalizeText("ballistic missile"))) {
    score += 3;
  }
  if (haystack.includes(normalizeText("missile strike"))) {
    score += 3;
  }
  if (haystack.includes(normalizeText("airstrike")) || haystack.includes(normalizeText("troop deployment"))) {
    score += 2;
  }

  const level = THREAT_LEVELS.find((item) => score >= item.minScore)?.id || "low";
  return { level, score };
}

function resolvePrimaryCountry(countryMentions = []) {
  if (!countryMentions.length) {
    return null;
  }
  const iso2 = countryMentions[0];
  return getCountryByIso2(iso2);
}

function enrichLocation(countryMentions = []) {
  const country = resolvePrimaryCountry(countryMentions);
  if (!country) {
    return {
      country: null,
      lat: null,
      lng: null
    };
  }

  return {
    country: country.iso2,
    lat: country.lat,
    lng: country.lng
  };
}

export function classifyRssArticle(article = {}) {
  const sourceName = article.sourceName || article.source?.name || article.provider || "rss";
  const text = `${article.title || ""} ${article.description || ""} ${article.content || ""}`;
  const countryMentions = detectCountryMentions(text);
  const topicTags = extractTopicTags(text);
  const threat = classifyThreat({ text, topicTags });
  const location = enrichLocation(countryMentions);

  return {
    ...article,
    countryMentions,
    country: location.country,
    lat: location.lat,
    lng: location.lng,
    topicTags,
    threatLevel: threat.level,
    threatScore: threat.score,
    credibilityScore: rankSourceCredibility(sourceName),
    summary: article.summary || article.excerpt || article.description || "",
    sourceName
  };
}

function dedupeFeeds(feeds = []) {
  const seen = new Set();
  return feeds.filter((feed) => {
    const key = String(feed.url || "").trim().toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function buildExtendedRssFeedCatalog(configuredFeeds = []) {
  const configured = coerceLegacyRssFeeds(configuredFeeds);
  const generated = projectLegacyGeneratedSearches(NEWS_SOURCE_CATALOG);

  const catalog = dedupeFeeds([
    ...configured,
    ...generated
  ]);

  return {
    feeds: catalog,
    stats: {
      generatedCount: generated.length,
      configuredCount: configured.length,
      totalCount: catalog.length,
      supportedCountries: BASELINE_COUNTRIES.length,
      catalogVersion: NEWS_SOURCE_CATALOG.catalogVersion,
      methodVersion: NEWS_SOURCE_CATALOG.methodVersion,
      typeCounts: {
        rss: configured.filter((feed) => feed.type === "rss").length,
        generated_search: generated.length,
        discovery: configured.filter((feed) => feed.type === "discovery").length
      }
    }
  };
}
