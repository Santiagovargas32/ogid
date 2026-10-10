import { articleIdentity, publicationDate } from "./news/articleIdentity.js";
import { classifyRssArticle } from "./news/rssClassifier.js";
import { createHash } from "node:crypto";
import { detectCountryMentions } from "../utils/countryCatalog.js";
import { analyzeSentiment } from "../utils/sentimentRules.js";
import { extractConflictSignal } from "../utils/conflictTags.js";
import { sanitizeArticleContent } from "./news/newsContentSanitizer.js";
import { DATA_MODES, normalizeDataMode } from "../utils/dataMode.js";

function toIsoDate(value, fallback) {
  const date = value ? new Date(value) : new Date(fallback);
  if (Number.isNaN(date.getTime())) {
    return new Date(fallback).toISOString();
  }
  return date.toISOString();
}

function hashId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeMetadataList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function normalizeSourceMetadata(rawArticle = {}) {
  const sourceRole = rawArticle?.sourceRole || rawArticle?.source?.role || rawArticle?.role || null;
  const role = rawArticle?.role || rawArticle?.source?.role || rawArticle?.sourceRole || null;

  return {
    sourceId: rawArticle?.sourceId || rawArticle?.source?.sourceId || rawArticle?.provenance?.sourceId || null,
    role,
    sourceRole,
    publisher: rawArticle?.publisher || rawArticle?.source?.publisher || null,
    topics: normalizeMetadataList(rawArticle?.topics || rawArticle?.source?.topics),
    instrumentIds: normalizeMetadataList(rawArticle?.instrumentIds || rawArticle?.source?.instrumentIds),
    provenance: rawArticle?.provenance ? structuredClone(rawArticle.provenance) : null
  };
}

function normalizeArticle(rawArticle, index, provider) {
  const sanitized = sanitizeArticleContent(rawArticle);
  const title = sanitized.title;
  const description = sanitized.description;
  const content = sanitized.content;

  if (!title && !description && !content) {
    return null;
  }

  const date = publicationDate(rawArticle?.publishedAt);
  const publishedAt = date.publishedAt;
  const receivedAt = toIsoDate(rawArticle?.receivedAt || rawArticle?.fetchedAt, Date.now());
  const textBlob = `${title}. ${description}. ${content}`;
  const countryMentions = detectCountryMentions(textBlob);
  const sentiment = analyzeSentiment(textBlob);
  const conflict = extractConflictSignal(textBlob);

  return {
    id: rawArticle.id || articleIdentity({...rawArticle, publishedAt}),
    identity: articleIdentity({...rawArticle, publishedAt}),
    aliases: [...new Set([...(rawArticle.aliases || []), hashId(`${rawArticle?.url || title}-${rawArticle?.publishedAt || publishedAt}-${index}`)])],
    publishedAtQuality: rawArticle?.provenance?.publishedAtQuality || date.publishedAtQuality,
    provider: rawArticle?.provider || provider,
    sourceName: rawArticle?.source?.name || rawArticle?.sourceName || "Unknown Source",
    ...normalizeSourceMetadata(rawArticle),
    title,
    description,
    content,
    excerpt: sanitized.excerpt,
    fullText: sanitized.fullText,
    url: rawArticle?.url || null,
    imageUrl: sanitized.leadImageUrl,
    leadImageUrl: sanitized.leadImageUrl,
    publishedAt,
    receivedAt,
    firstSeenAt: rawArticle.firstSeenAt || receivedAt,
    updatedAt: rawArticle.updatedAt || null,
    threatLevel: rawArticle.threatLevel || classifyRssArticle({title, description, content}).threatLevel,
    severityOrigin: rawArticle.severityOrigin || "rss-classifier-rules",
    topicTags: rawArticle.topicTags || classifyRssArticle({title, description, content}).topicTags,
    countryMentions,
    synthetic: Boolean(rawArticle?.synthetic),
    dataMode: normalizeDataMode(
      rawArticle?.dataMode,
      String(rawArticle?.provider || provider) === "fallback" ? DATA_MODES.SYNTHETIC : DATA_MODES.OBSERVED
    ),
    usagePolicy: rawArticle?.usagePolicy || "standard-link-out",
    sentiment,
    conflict
  };
}

function normalizeAdminArticle(rawArticle, index, provider) {
  const sanitized = sanitizeArticleContent(rawArticle);
  const title =
    sanitized.title ||
    sanitized.excerpt ||
    sanitized.description ||
    rawArticle?.title ||
    rawArticle?.description ||
    "Untitled";

  return {
    id: rawArticle.id || articleIdentity(rawArticle),
    provider: rawArticle?.provider || provider,
    sourceName: rawArticle?.source?.name || rawArticle?.sourceName || "Unknown Source",
    ...normalizeSourceMetadata(rawArticle),
    title: String(title).trim() || "Untitled",
    url: rawArticle?.url || `https://local.osint/admin-raw/${index}`,
    publishedAt: publicationDate(rawArticle?.publishedAt).publishedAt
  };
}

export function normalizeArticles(rawArticles = [], provider = "newsapi") {
  return rawArticles
    .map((article, index) => normalizeArticle(article, index, provider))
    .filter(Boolean)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}

export function normalizeAdminArticles(rawArticles = [], provider = "newsapi") {
  return rawArticles
    .map((article, index) => normalizeAdminArticle(article, index, provider))
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}
