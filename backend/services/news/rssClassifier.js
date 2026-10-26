import {classifyNews, newsTopicTags, NEWS_CLASSIFICATION_VERSION, NEWS_LANGUAGES} from './newsClassification.js';
import {publisherByAlias, resolveEditorialIdentity} from './publisherIdentity.js';
import { BASELINE_COUNTRIES, getCountryByIso2 } from "../../utils/countryCatalog.js";
import { NEWS_SOURCE_CATALOG, coerceLegacyRssFeeds, projectLegacyGeneratedSearches } from "./newsSourceCatalog.js";

export const RULE_BASED_NEWS_SEVERITY_METHODOLOGY = Object.freeze({
  version: NEWS_CLASSIFICATION_VERSION, languageScope: NEWS_LANGUAGES,
  meaning: "News relevance heuristic; not incident occurrence or corroboration",
  thresholds: Object.freeze({critical:8,elevated:5,monitoring:2,low:0})
});
// Kept for compatibility; the value is a documented editorial weight.
export function rankSourceCredibility(name = "") { return publisherByAlias(name)?.priority ?? .55; }
export function extractTopicTags(text = "") { return newsTopicTags(text); }
export function classifyThreat({text = "", language = null} = {}) { return classifyNews({text,language}); }

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
  const headlineOnly = [article.usagePolicy,article.usagePolicy?.contentPolicy,article.usagePolicy?.mode,article.provenance?.contentPolicy].includes('headline-only-link-out');
  const text = headlineOnly ? article.title || '' : `${article.title || ""} ${article.description || article.excerpt || ""} ${article.content || ""}`;
  const editorial = resolveEditorialIdentity(article);
  const threat = classifyNews({text, language:article.language || article.classification?.language,
    textScope:headlineOnly ? 'headline' : article.usagePolicy?.allowFullText && article.fullText ? 'permitted-text' : article.description || article.excerpt || article.content ? 'excerpt' : 'headline'});
  const {countryMentions,topicTags} = threat;
  const location = enrichLocation(countryMentions);

  return {
    ...article,
    ...editorial,
    classification: threat.classification,
    countryMentions,
    country: location.country,
    lat: location.lat,
    lng: location.lng,
    topicTags,
    threatLevel: threat.level,
    threatScore: threat.score,
    credibilityScore: editorial.sourcePriority.value,
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
