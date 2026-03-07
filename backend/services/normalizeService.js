import { createHash } from "node:crypto";
import { detectCountryMentions } from "../utils/countryCatalog.js";
import { analyzeSentiment } from "../utils/sentimentRules.js";
import { extractConflictSignal } from "../utils/conflictTags.js";

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

function normalizeArticle(rawArticle, index, provider) {
  const title = String(rawArticle?.title || "").trim();
  const description = String(rawArticle?.description || "").trim();
  const content = String(rawArticle?.content || "").trim();

  if (!title && !description) {
    return null;
  }

  const publishedAt = toIsoDate(rawArticle?.publishedAt, Date.now() - index * 60_000);
  const textBlob = `${title}. ${description}. ${content}`;
  const countryMentions = detectCountryMentions(textBlob);
  const sentiment = analyzeSentiment(textBlob);
  const conflict = extractConflictSignal(textBlob);

  return {
    id: hashId(`${rawArticle?.url || title}-${publishedAt}-${index}`),
    provider: rawArticle?.provider || provider,
    sourceName: rawArticle?.source?.name || rawArticle?.sourceName || "Unknown Source",
    title,
    description,
    content,
    url: rawArticle?.url || `https://local.osint/article/${index}`,
    imageUrl: rawArticle?.urlToImage || null,
    publishedAt,
    countryMentions,
    synthetic: Boolean(rawArticle?.synthetic),
    dataMode: rawArticle?.dataMode || (String(rawArticle?.provider || provider) === "fallback" ? "fallback" : "live"),
    usagePolicy: rawArticle?.usagePolicy || "standard-link-out",
    sentiment,
    conflict
  };
}

export function normalizeArticles(rawArticles = [], provider = "newsapi") {
  return rawArticles
    .map((article, index) => normalizeArticle(article, index, provider))
    .filter(Boolean)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}
