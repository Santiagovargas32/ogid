import { createHash } from "node:crypto";
import { buildArticleInstrumentLinks } from "../market/impactEngineService.js";

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "mc_cid", "mc_eid", "igshid", "ref_src", "ref_url"
]);

function hash(value, prefix) {
  return `${prefix}_${createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24)}`;
}

function normalizeText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeArticleUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (normalized.startsWith("utm_") || TRACKING_PARAMS.has(normalized)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

function rawLookupKeys(article = {}) {
  const canonicalUrl = canonicalizeArticleUrl(article.url);
  const title = normalizeText(article.title);
  return [canonicalUrl ? `url:${canonicalUrl}` : "", title ? `title:${title}` : ""].filter(Boolean);
}

function buildRawLookup(rawArticles = []) {
  const lookup = new Map();
  for (const article of rawArticles || []) {
    for (const key of rawLookupKeys(article)) if (!lookup.has(key)) lookup.set(key, article);
  }
  return lookup;
}

function resolveRawArticle(article, lookup) {
  for (const key of rawLookupKeys(article)) {
    if (lookup.has(key)) return lookup.get(key);
  }
  return {};
}

function pickProvenance(raw = {}) {
  const provenance = raw.provenance || {};
  return {
    sourceId: provenance.sourceId || raw.source?.sourceId || null,
    sourceType: provenance.sourceType || raw.source?.type || null,
    queryProvider: provenance.queryProvider || null,
    feedId: provenance.feedId || null,
    pipeline: provenance.pipeline || null,
    methodVersion: provenance.methodVersion || null,
    publishedAtQuality: provenance.publishedAtQuality || null,
    stale: provenance.stale === true
  };
}

function identitySeed(article, raw, canonicalUrl) {
  if (canonicalUrl) return `canonical-article-v1|url|${canonicalUrl}`;
  const publisher = raw.publisher || article.sourceName || article.provider || "unknown";
  return `canonical-article-v1|fallback|${normalizeText(publisher)}|${normalizeText(article.title)}|${article.publishedAt || ""}`;
}

function clusterSeed(article, raw, canonicalUrl) {
  if (raw.dedupeKey) return `canonical-cluster-v1|dedupe|${raw.dedupeKey}`;
  if (canonicalUrl) return `canonical-cluster-v1|url|${canonicalUrl}`;
  const headline = normalizeText(article.title).split(" ").filter(Boolean).slice(0, 12).join("|");
  return `canonical-cluster-v1|headline|${headline}`;
}

function resolvePublisher(article, raw, provenance) {
  if (provenance.sourceType === "generated_search") return null;
  return raw.publisher || article.sourceName || null;
}

function selectRepresentatives(articles = []) {
  const clusters = new Map();
  for (const article of articles) {
    const existing = clusters.get(article.clusterId);
    const isBetter = !existing
      || article.relevance.score > existing.relevance.score
      || (article.relevance.score === existing.relevance.score && Date.parse(article.publishedAt) > Date.parse(existing.publishedAt));
    if (isBetter) clusters.set(article.clusterId, article);
  }
  return [...clusters.values()];
}

export function buildCanonicalArticleLayer({
  signalCorpus = [],
  displaySelection = [],
  rawArticles = [],
  instruments = [],
  marketQuotes = {}
} = {}) {
  const rawLookup = buildRawLookup(rawArticles);
  const displayedIds = new Set(displaySelection.map((article) => String(article.id || "")));
  const tickers = instruments.map((instrument) => instrument.canonicalSymbol || instrument.symbol).filter(Boolean);
  const articles = signalCorpus.map((article) => {
    const raw = resolveRawArticle(article, rawLookup);
    const canonicalUrl = canonicalizeArticleUrl(article.url);
    const provenance = pickProvenance(raw);
    const canonicalArticleId = hash(identitySeed(article, raw, canonicalUrl), "ca");
    const clusterId = hash(clusterSeed(article, raw, canonicalUrl), "cl");
    return {
      schemaVersion: "canonical-article-v1",
      canonicalArticleId,
      legacyArticleId: String(article.id || ""),
      clusterId,
      canonicalUrl: canonicalUrl || null,
      provider: article.provider || "unknown",
      sourceName: article.sourceName || "Unknown Source",
      publisher: resolvePublisher(article, raw, provenance),
      title: String(article.title || "").trim(),
      excerpt: String(article.excerpt || article.description || "").trim(),
      publishedAt: article.publishedAt || null,
      receivedAt: article.receivedAt || null,
      language: raw.language || "und",
      countryMentions: [...new Set(article.countryMentions || [])],
      usagePolicy: article.usagePolicy || raw.usagePolicy || "standard-link-out",
      dataMode: article.dataMode || "observed",
      synthetic: article.synthetic === true,
      relevance: {
        score: Math.max(0, Math.min(100, Number(article.analysisScore || 0))),
        methodVersion: "news-selection-analysis-score-v1"
      },
      corpusMembership: displayedIds.has(String(article.id || "")) ? ["signal", "display"] : ["signal"],
      instrumentLinks: buildArticleInstrumentLinks(article, { tickers, instruments, marketQuotes }),
      sentiment: article.sentiment || null,
      conflict: article.conflict || null,
      provenance
    };
  });

  const membersByCluster = articles.reduce((result, article) => {
    if (!result[article.clusterId]) result[article.clusterId] = [];
    result[article.clusterId].push(article.canonicalArticleId);
    return result;
  }, {});

  return {
    schemaVersion: "canonical-article-layer-v1",
    generatedAt: new Date().toISOString(),
    articles,
    representatives: selectRepresentatives(articles),
    membersByCluster
  };
}
