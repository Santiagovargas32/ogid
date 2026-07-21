import { BASELINE_COUNTRIES } from "../../utils/countryCatalog.js";
import { computeCountryInstability, COUNTRY_INSTABILITY_METHODOLOGY } from "./countryInstabilityService.js";
import { computeHotspotEscalation, HOTSPOT_ESCALATION_METHODOLOGY } from "./hotspotEscalationService.js";
import { GEO_CONVERGENCE_METHODOLOGY } from "./geoEventIndex.js";
import { normalizeOsintEvents, OSINT_FUSION_METHODOLOGY } from "./osintFusion.js";
import { SIGNAL_ANOMALY_METHODOLOGY } from "./signalCorrelator.js";
import {
  classifyThreat,
  extractTopicTags,
  RULE_BASED_NEWS_SEVERITY_METHODOLOGY
} from "../news/rssClassifier.js";

export const FREQUENT_HEADLINE_TERMS_METHODOLOGY = Object.freeze({
  version: "frequent-headline-terms-v2",
  comparison: "active window versus immediately preceding equal-length window",
  counting: "maximum once per normalized term per article",
  normalization: "Unicode NFKD, lowercase, multilingual stopwords"
});

export const COUNTRY_ENTITY_EXTRACTION_METHODOLOGY = Object.freeze({
  version: "multilingual-country-entity-v1",
  entityTypes: Object.freeze(["country"]),
  languages: Object.freeze(["en", "es", "fr", "de", "pt"]),
  matching: "normalized deterministic aliases with ambiguous America contexts excluded"
});

export const ADVANCED_INTELLIGENCE_METHODOLOGY = Object.freeze({
  version: "advanced-intelligence-v2",
  hotspot: HOTSPOT_ESCALATION_METHODOLOGY,
  geoConvergence: GEO_CONVERGENCE_METHODOLOGY,
  countryInstability: COUNTRY_INSTABILITY_METHODOLOGY,
  eventFusion: OSINT_FUSION_METHODOLOGY,
  severity: RULE_BASED_NEWS_SEVERITY_METHODOLOGY,
  frequentTerms: FREQUENT_HEADLINE_TERMS_METHODOLOGY,
  entityExtraction: COUNTRY_ENTITY_EXTRACTION_METHODOLOGY,
  anomaly: SIGNAL_ANOMALY_METHODOLOGY
});

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "from", "into", "amid", "after", "before", "over", "under", "this", "have", "will", "news", "live", "says", "said",
  "los", "las", "una", "uno", "unos", "unas", "para", "con", "por", "del", "desde", "entre", "sobre", "esta", "este", "esto", "tras", "ante", "como", "pero",
  "les", "des", "une", "pour", "avec", "dans", "sur", "apres", "avant", "entre", "cette", "mais", "plus",
  "der", "die", "das", "und", "mit", "von", "fur", "auf", "nach", "eine", "einer",
  "uma", "uns", "das", "dos", "com", "para", "por", "sobre", "apos"
]);

const MULTILINGUAL_COUNTRY_ALIASES = Object.freeze({
  US: ["estados unidos", "etats unis", "vereinigte staaten"],
  RU: ["rusia", "russie", "russland"],
  CN: ["chine"],
  UA: ["ucrania"],
  IL: ["israel"],
  IR: ["iran"],
  SY: ["siria", "syrie"],
  IQ: ["irak"],
  AF: ["afganistan"],
  KP: ["corea del norte", "coree du nord", "nordkorea"],
  KR: ["corea del sur", "coree du sud", "sudkorea"],
  TW: ["taiwan"],
  IN: ["inde"],
  PK: ["paquistan"],
  TR: ["turquia", "turquie"],
  YE: ["yemen"],
  SD: ["sudan"],
  ET: ["etiopia", "ethiopie"],
  VE: ["venezuela"],
  CO: ["colombie"],
  MM: ["birmania", "birmanie"]
});

const AMBIGUOUS_US_CONTEXTS = Object.freeze([
  "latin america", "america latina", "south america", "america del sur",
  "central america", "america central", "north america", "america del norte"
]);

const MULTILINGUAL_TOPIC_ALIASES = Object.freeze({
  conflict: ["misil", "misiles", "guerra", "ataque aereo", "tropas", "frappe aerienne", "guerre", "rakete", "krieg", "missil"],
  cyber: ["ciberataque", "ciberseguridad", "cyberattaque", "cyberangriff", "ataque cibernetico"],
  sanctions: ["sancion", "sanciones", "sanctions", "sanktionen", "sancoes"],
  civil_unrest: ["protesta", "protestas", "manifestacion", "manifestation", "proteste", "manifestacao"],
  humanitarian: ["refugiados", "desplazados", "aide humanitaire", "fluchtlinge", "ajuda humanitaria"],
  energy: ["petroleo", "oleoducto", "gazoduc", "erdol", "gasoduto"],
  space: ["satelite", "lanzamiento espacial", "lancement spatial", "weltraumstart", "lancamento espacial"]
});

function normalizeText(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

function normalizedTitle(value = "") {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function includesNormalizedPhrase(haystack, value) {
  return haystack.includes(` ${normalizedTitle(value)} `);
}

function extractMultilingualTopicTags(text = "") {
  const haystack = ` ${normalizedTitle(text)} `;
  return Object.entries(MULTILINGUAL_TOPIC_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => includesNormalizedPhrase(haystack, alias)))
    .map(([topic]) => topic);
}

function extractCountryEntities(item = {}) {
  const haystack = ` ${normalizedTitle(`${item.title || ""} ${item.description || ""} ${item.summary || ""}`)} `;
  const matches = new Set(item.countryMentions || []);
  for (const country of BASELINE_COUNTRIES) {
    const aliases = [country.name, ...(country.aliases || []), ...(MULTILINGUAL_COUNTRY_ALIASES[country.iso2] || [])]
      .filter((alias) => !(country.iso2 === "US" && normalizedTitle(alias) === "america"));
    if (aliases.some((alias) => includesNormalizedPhrase(haystack, alias))) matches.add(country.iso2);
  }
  const ambiguousUsContext = AMBIGUOUS_US_CONTEXTS.some((alias) => includesNormalizedPhrase(haystack, alias));
  if (ambiguousUsContext) {
    const us = BASELINE_COUNTRIES.find((country) => country.iso2 === "US");
    const explicitUs = [us?.name, ...(us?.aliases || []), ...(MULTILINGUAL_COUNTRY_ALIASES.US || [])]
      .filter((alias) => normalizedTitle(alias) !== "america")
      .some((alias) => includesNormalizedPhrase(haystack, alias));
    if (!explicitUs) matches.delete("US");
  }
  return [...matches];
}

function enrichAdvancedArticle(item = {}, countryMentions = []) {
  const text = `${item.title || ""} ${item.description || ""} ${item.summary || ""} ${item.content || ""}`;
  const topicTags = [...new Set([
    ...extractTopicTags(text),
    ...extractMultilingualTopicTags(text),
    ...(Number(item.conflict?.totalWeight || 0) > 0 ? ["conflict"] : []),
    ...(item.topicTags || [])
  ].map((tag) => String(tag || "").toLowerCase()).filter(Boolean))].slice(0, 8);
  const threat = classifyThreat({ text, topicTags });
  const threatRank = { low: 0, monitoring: 1, elevated: 2, critical: 3 };
  const existingThreatLevel = String(item.threatLevel || "low").toLowerCase();
  const threatLevel = Number(threatRank[existingThreatLevel] || 0) > Number(threatRank[threat.level] || 0)
    ? existingThreatLevel
    : threat.level;
  const existingThreatScore = Number(item.threatScore);
  return {
    ...item,
    countryMentions,
    topicTags,
    threatLevel,
    threatScore: Math.max(Number.isFinite(existingThreatScore) ? existingThreatScore : 0, Number(threat.score || 0)),
    credibilityScore: Number(item.credibilityScore ?? 0.55)
  };
}

function canonicalUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
  }
}

export function advancedArticleIdentity(item = {}) {
  const url = canonicalUrl(item.url);
  if (url) return `url:${url}`;
  const dedupeKey = String(item.dedupeKey || "").trim().toLowerCase();
  if (dedupeKey) return `dedupe:${dedupeKey}`;
  const title = normalizedTitle(item.title);
  return `title:${title || item.id || "unknown"}`;
}

function mergeArticle(current, candidate) {
  if (!current) return { ...candidate };
  const currentRank = Number(current.credibilityScore || 0) * 10 + Number(current.threatScore || 0);
  const candidateRank = Number(candidate.credibilityScore || 0) * 10 + Number(candidate.threatScore || 0);
  const preferred = candidateRank > currentRank ? candidate : current;
  const secondary = preferred === current ? candidate : current;
  return {
    ...secondary,
    ...preferred,
    countryMentions: [...new Set([...(current.countryMentions || []), ...(candidate.countryMentions || [])])],
    topicTags: [...new Set([...(current.topicTags || []), ...(candidate.topicTags || [])])].slice(0, 8)
  };
}

export function buildAdvancedCorpus({ signalCorpus = [], aggregateItems = [], countries = [], windowHours = 24, now = Date.now() } = {}) {
  const input = [...(signalCorpus || []), ...(aggregateItems || [])];
  const fromMs = Number(now) - Math.max(1, Number(windowHours || 24)) * 60 * 60 * 1_000;
  const countriesSet = new Set(countries || []);
  const unique = new Map();
  let invalidTimestamps = 0;
  let outsideWindow = 0;
  let filteredByCountry = 0;

  for (const item of input) {
    const timestampMs = new Date(item.publishedAt || item.timestamp || 0).getTime();
    if (!Number.isFinite(timestampMs)) {
      invalidTimestamps += 1;
      continue;
    }
    if (timestampMs < fromMs || timestampMs > Number(now) + 5 * 60 * 1_000) {
      outsideWindow += 1;
      continue;
    }
    const countryMentions = extractCountryEntities(item);
    if (countriesSet.size && !countryMentions.some((iso2) => countriesSet.has(iso2))) {
      filteredByCountry += 1;
      continue;
    }
    const identity = advancedArticleIdentity(item);
    unique.set(identity, mergeArticle(
      unique.get(identity),
      { ...enrichAdvancedArticle(item, countryMentions), advancedArticleId: identity }
    ));
  }

  const articles = [...unique.values()].sort((left, right) =>
    new Date(right.publishedAt || right.timestamp).getTime() - new Date(left.publishedAt || left.timestamp).getTime()
  );
  return {
    articles,
    stats: {
      inputArticles: input.length,
      windowedArticles: input.length - invalidTimestamps - outsideWindow,
      uniqueArticles: articles.length,
      duplicatesRemoved: Math.max(0, input.length - invalidTimestamps - outsideWindow - filteredByCountry - articles.length),
      invalidTimestamps,
      outsideWindow,
      filteredByCountry
    }
  };
}

function countRecord(values = []) {
  return values.reduce((counts, value) => {
    const key = String(value || "low").toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

export function buildSeveritySummary(articles = []) {
  const counts = { critical: 0, elevated: 0, monitoring: 0, low: 0, ...countRecord(articles.map((item) => item.threatLevel)) };
  const topicCounts = countRecord(articles.flatMap((item) => item.topicTags || []).filter(Boolean));
  return {
    methodology: RULE_BASED_NEWS_SEVERITY_METHODOLOGY,
    sampleSize: articles.length,
    counts,
    topTopics: Object.entries(topicCounts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([topic, count]) => ({ topic, count }))
  };
}

function tokenizeTitle(title = "") {
  return normalizedTitle(title)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function termCounts(articles = []) {
  const counts = new Map();
  for (const item of articles) {
    for (const token of new Set(tokenizeTitle(item.title))) counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

export function buildFrequentTerms(articles = [], { previousArticles = null, windowHours = 24, now = Date.now() } = {}) {
  const resolvedWindowHours = Math.max(1, Number(windowHours || 24));
  const currentFromMs = Number(now) - resolvedWindowHours * 60 * 60 * 1_000;
  const previousFromMs = Number(now) - resolvedWindowHours * 2 * 60 * 60 * 1_000;
  const currentArticles = articles.filter((item) => {
    const timestampMs = new Date(item.publishedAt || item.timestamp).getTime();
    return Number.isFinite(timestampMs) && timestampMs >= currentFromMs && timestampMs <= Number(now) + 5 * 60 * 1_000;
  });
  const previousCandidates = Array.isArray(previousArticles) ? previousArticles : articles;
  const resolvedPreviousArticles = previousCandidates.filter((item) => {
    const timestampMs = new Date(item.publishedAt || item.timestamp).getTime();
    return Number.isFinite(timestampMs) && timestampMs >= previousFromMs && timestampMs < currentFromMs;
  });
  const current = termCounts(currentArticles);
  const previous = termCounts(resolvedPreviousArticles);
  const previousTimestamps = resolvedPreviousArticles
    .map((item) => new Date(item.publishedAt || item.timestamp).getTime())
    .filter(Number.isFinite);
  const oldestPreviousMs = previousTimestamps.length ? Math.min(...previousTimestamps) : null;
  const observedPreviousSpanHours = oldestPreviousMs === null
    ? 0
    : Math.min(resolvedWindowHours, (currentFromMs - oldestPreviousMs) / (60 * 60 * 1_000));
  const comparisonStatus = !resolvedPreviousArticles.length
    ? "insufficient_comparison"
    : observedPreviousSpanHours >= resolvedWindowHours - 1
      ? "observed"
      : "partial";
  const comparisonAvailable = comparisonStatus !== "insufficient_comparison";
  const countryNames = new Map(BASELINE_COUNTRIES.map((country) => [country.iso2, country.name]));
  const entityCounts = new Map();
  for (const item of articles) {
    for (const iso2 of new Set(item.countryMentions || [])) entityCounts.set(iso2, (entityCounts.get(iso2) || 0) + 1);
  }

  return {
    methodology: FREQUENT_HEADLINE_TERMS_METHODOLOGY,
    comparison: {
      currentHours: resolvedWindowHours,
      previousHours: resolvedWindowHours,
      currentFrom: new Date(currentFromMs).toISOString(),
      currentTo: new Date(Number(now)).toISOString(),
      previousFrom: new Date(previousFromMs).toISOString(),
      previousTo: new Date(currentFromMs).toISOString(),
      currentSampleSize: currentArticles.length,
      previousSampleSize: resolvedPreviousArticles.length,
      status: comparisonStatus,
      coverageMode: "observed-corpus-span",
      observedPreviousSpanHours: Number(observedPreviousSpanHours.toFixed(2)),
      oldestPreviousArticleAt: oldestPreviousMs === null ? null : new Date(oldestPreviousMs).toISOString()
    },
    items: [...new Set([...current.keys(), ...previous.keys()])]
      .map((term) => {
        const count = current.get(term) || 0;
        const previousCount = comparisonAvailable ? previous.get(term) || 0 : null;
        return {
          term,
          count,
          previousCount,
          delta: comparisonAvailable ? count - previousCount : null,
          changePct: comparisonAvailable && previousCount
            ? Number((((count - previousCount) / previousCount) * 100).toFixed(1))
            : null,
          direction: comparisonAvailable ? count > previousCount ? "up" : count < previousCount ? "down" : "flat" : "unavailable"
        };
      })
      .sort((left, right) =>
        Math.max(right.count, right.previousCount) - Math.max(left.count, left.previousCount) ||
        Math.abs(Number(right.delta || 0)) - Math.abs(Number(left.delta || 0)) ||
        right.count - left.count ||
        left.term.localeCompare(right.term)
      )
      .slice(0, 10),
    entities: [...entityCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([iso2, count]) => ({ type: "country", iso2, label: countryNames.get(iso2) || iso2, count }))
  };
}

function worldBriefArticles(articles, iso2) {
  return articles
    .filter((item) => (item.countryMentions || []).includes(iso2))
    .sort((left, right) =>
      Number(right.threatScore || 0) - Number(left.threatScore || 0) ||
      Number(right.credibilityScore || 0) - Number(left.credibilityScore || 0) ||
      new Date(right.publishedAt || right.timestamp).getTime() - new Date(left.publishedAt || left.timestamp).getTime()
    )
    .slice(0, 3)
    .map((item) => ({
      id: item.id || item.advancedArticleId,
      title: item.title || "Headline",
      url: item.url || null,
      sourceName: item.sourceName || item.provider || "Source",
      threatLevel: item.threatLevel || "low",
      excerpt: item.excerpt || item.summary || item.description || "",
      publishedAt: item.publishedAt || item.timestamp || null,
      countryMentions: item.countryMentions || []
    }));
}

function buildWorldBrief(hotspots = [], articles = [], windowHours = 24) {
  const leader = hotspots.find((item) => Number(item.hotspotScore || 0) > 0) || null;
  if (!leader) {
    return { leader: null, summary: "No active escalation clusters detected in the selected window.", drivers: [], articles: [], emptyReason: "no-active-hotspot" };
  }
  const componentEntries = Object.entries(leader.components || {})
    .map(([key, value]) => {
      const score = Number(value?.score || 0);
      const weight = Number(value?.weight || 0);
      return { key, score, weight, contribution: Number((score * weight).toFixed(2)) };
    })
    .sort((left, right) => right.contribution - left.contribution || right.score - left.score);
  const drivers = componentEntries;
  const relevantArticles = worldBriefArticles(articles, leader.iso2);
  return {
    leader,
    summary: `${leader.country} leads escalation monitoring with hotspot score ${leader.hotspotScore.toFixed(1)}. Components: ${drivers.map((item) => `${item.key} ${item.score.toFixed(1)} (${item.contribution.toFixed(1)} weighted)`).join(", ")}.`,
    drivers,
    articles: relevantArticles,
    emptyReason: relevantArticles.length ? null : "no-related-articles",
    windowHours
  };
}

export class AdvancedIntelligenceService {
  constructor({ stateManager, rssAggregator, signalCorrelator, cacheTtlMs = 30_000, maxCacheEntries = 64, now = () => Date.now() } = {}) {
    this.stateManager = stateManager;
    this.rssAggregator = rssAggregator;
    this.signalCorrelator = signalCorrelator;
    this.cacheTtlMs = Math.max(0, Number(cacheTtlMs || 0));
    this.maxCacheEntries = Math.max(1, Number(maxCacheEntries || 64));
    this.now = now;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  async getSnapshot({ countries = [], force = false, windowHours = 24, maxEvents = 450, activeWindowHours = null, baselineDays = 7 } = {}) {
    const resolvedCountries = [...new Set((countries || []).map((iso2) => String(iso2 || "").toUpperCase()).filter(Boolean))];
    const resolvedWindowHours = Math.max(1, Math.min(168, Number(windowHours || 24)));
    const resolvedActiveWindowHours = activeWindowHours === null || activeWindowHours === undefined
      ? Math.min(48, resolvedWindowHours)
      : Math.max(1, Math.min(48, Number(activeWindowHours || 2)));
    const stateRevision = this.stateManager.getSnapshot()?.meta?.lastRefreshAt || null;
    const key = JSON.stringify({
      countries: resolvedCountries,
      windowHours: resolvedWindowHours,
      maxEvents,
      activeWindowHours: resolvedActiveWindowHours,
      baselineDays,
      stateRevision
    });
    const cached = !force ? this.cache.get(key) : null;
    if (cached && this.now() - cached.createdAtMs < this.cacheTtlMs) return structuredClone(cached.value);
    if (this.inFlight.has(key)) return structuredClone(await this.inFlight.get(key));
    const promise = this.#buildSnapshot({
      countries: resolvedCountries,
      force,
      windowHours: resolvedWindowHours,
      maxEvents,
      activeWindowHours: resolvedActiveWindowHours,
      baselineDays
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    const value = await promise;
    if (!this.cache.has(key) && this.cache.size >= this.maxCacheEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, { createdAtMs: this.now(), value });
    return structuredClone(value);
  }

  async #buildSnapshot({ countries, force, windowHours, maxEvents, activeWindowHours, baselineDays }) {
    const aggregateNews = await this.rssAggregator.getSnapshot({
      force,
      countries: [],
      limit: Math.max(500, Number(this.rssAggregator.maxCorpusItems || 500))
    });
    const nowMs = this.now();
    const stateSnapshot = this.stateManager.getSnapshot();
    const signalCorpus = this.stateManager.getSignalCorpus();
    const corpus = buildAdvancedCorpus({ signalCorpus, aggregateItems: aggregateNews.items || [], countries, windowHours, now: nowMs });
    const comparisonCorpus = buildAdvancedCorpus({
      signalCorpus,
      aggregateItems: aggregateNews.items || [],
      countries,
      windowHours: windowHours * 2,
      now: nowMs
    });
    const currentFromMs = nowMs - windowHours * 60 * 60 * 1_000;
    const previousArticles = comparisonCorpus.articles.filter((item) => {
      const timestampMs = new Date(item.publishedAt || item.timestamp).getTime();
      return Number.isFinite(timestampMs) && timestampMs < currentFromMs;
    });
    const countrySet = new Set(countries);
    const fusedSnapshot = { ...stateSnapshot, signalCorpus: corpus.articles };
    const allEvents = normalizeOsintEvents({
      snapshot: fusedSnapshot,
      aggregateNews: { items: [] },
      maxEvents: Number.MAX_SAFE_INTEGER,
      windowHours,
      now: nowMs
    });
    const scoredEvents = countrySet.size
      ? allEvents.filter((event) => countrySet.has(event.country))
      : allEvents;
    const countryInstability = computeCountryInstability({
      snapshot: stateSnapshot,
      articles: corpus.articles,
      windowHours,
      now: nowMs
    });
    const ranking = countrySet.size ? countryInstability.ranking.filter((item) => countrySet.has(item.iso2)) : countryInstability.ranking;
    const countryMap = Object.fromEntries(ranking.map((item) => [item.iso2, item]));
    const filteredInstability = { ...countryInstability, ranking, countries: countryMap };
    const hotspots = computeHotspotEscalation({
      fusedEvents: scoredEvents,
      countryInstability: filteredInstability,
      gridSize: 1,
      windowHours,
      now: nowMs
    });
    const topCii = ranking.slice(0, 5);
    const selectedNewsQuality = stateSnapshot.meta?.dataQuality?.news || {};
    const selectedProvider = selectedNewsQuality.provider || stateSnapshot.meta?.sourceMeta?.provider || "selected-news";
    const aggregateProvider = aggregateNews.meta?.provider || "rss-aggregate";
    const quality = {
      mode: selectedNewsQuality.mode || "fallback",
      modeScope: "selected-news-pipeline",
      provider: [...new Set([selectedProvider, aggregateProvider])].join("+"),
      reason: selectedNewsQuality.reason || null,
      pipelineMode: aggregateNews.meta?.pipelineMode || null,
      sourceGeneratedAt: aggregateNews.generatedAt || null,
      providers: [
        {
          role: "selected-news-pipeline",
          provider: selectedProvider,
          mode: selectedNewsQuality.mode || "fallback",
          sampleSize: signalCorpus.length,
          generatedAt: stateSnapshot.meta?.lastRefreshAt || null
        },
        {
          role: "rss-aggregate",
          provider: aggregateProvider,
          mode: "aggregate",
          pipelineMode: aggregateNews.meta?.pipelineMode || null,
          sampleSize: (aggregateNews.items || []).length,
          generatedAt: aggregateNews.generatedAt || null
        }
      ]
    };
    const generatedAt = new Date(nowMs).toISOString();
    const anomalyResult = this.signalCorrelator.getAnomalies({ activeWindowHours, baselineDays, countries });
    const anomalies = {
      ...anomalyResult,
      generatedAt,
      alignedWithSnapshotWindow: Number(anomalyResult.window?.activeWindowHours) === Number(windowHours)
    };

    return {
      schemaVersion: "advanced-intelligence-snapshot-v1",
      generatedAt,
      methodology: ADVANCED_INTELLIGENCE_METHODOLOGY,
      window: {
        from: new Date(nowMs - windowHours * 60 * 60 * 1_000).toISOString(),
        to: generatedAt,
        hours: windowHours,
        label: `last ${windowHours}h`
      },
      filters: { countries },
      corpus: {
        ...corpus.stats,
        previousWindowArticles: previousArticles.length,
        availableEventCount: scoredEvents.length,
        eventCount: scoredEvents.length,
        eventsFilteredByCountry: allEvents.length - scoredEvents.length,
        truncated: false,
        requestedEventLimit: Math.max(50, Number(maxEvents || 450)),
        scoringUsesCompleteWindow: true
      },
      quality,
      worldBrief: buildWorldBrief(hotspots, corpus.articles, windowHours),
      countryInstability: {
        generatedAt,
        ranking,
        countries: countryMap,
        averageTopCii: Number((topCii.reduce((sum, item) => sum + Number(item.cii || 0), 0) / Math.max(1, topCii.length)).toFixed(2)),
        sampleSize: corpus.articles.length,
        methodology: COUNTRY_INSTABILITY_METHODOLOGY
      },
      severity: buildSeveritySummary(corpus.articles),
      frequentTerms: buildFrequentTerms(corpus.articles, { previousArticles, windowHours, now: nowMs }),
      hotspots,
      anomalies
    };
  }
}
