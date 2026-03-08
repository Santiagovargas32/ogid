const ENTITY_MAP = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
});

const BOILERPLATE_PATTERNS = [
  /^country:\s+/i,
  /^source:\s+/i,
  /^please refer to the attached file\.?$/i,
  /^continue reading\.?$/i
];

function decodeEntity(entity = "") {
  const normalized = String(entity || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("#x")) {
    const codePoint = Number.parseInt(normalized.slice(2), 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
  }

  if (normalized.startsWith("#")) {
    const codePoint = Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
  }

  return ENTITY_MAP[normalized] || "";
}

export function decodeHtmlEntities(value = "") {
  return String(value || "").replace(/&([a-z0-9#]+);/gi, (_match, entity) => decodeEntity(entity));
}

function normalizeInlineWhitespace(value = "") {
  return String(value || "").replace(/[ \t\f\v]+/g, " ").trim();
}

function stripHtmlToText(value = "") {
  return decodeHtmlEntities(String(value || ""))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<img\b[^>]*>/gi, "\n\n")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|li|ul|ol|h[1-6]|blockquote|tr|table)>/gi, "\n\n")
    .replace(/<(?:p|div|section|article|li|ul|ol|h[1-6]|blockquote|tr|table)[^>]*>/gi, "\n\n")
    .replace(/<(?:td|th)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "\n");
}

function cleanParagraphs(value = "") {
  return stripHtmlToText(value)
    .split(/\n{1,}/)
    .map((paragraph) => normalizeInlineWhitespace(paragraph))
    .filter(Boolean)
    .filter((paragraph) => !BOILERPLATE_PATTERNS.some((pattern) => pattern.test(paragraph)));
}

function joinParagraphs(paragraphs = []) {
  return (paragraphs || []).filter(Boolean).join("\n\n").trim();
}

function shortenSentence(value = "", maxLength = 280) {
  const normalized = normalizeInlineWhitespace(value);
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const sliced = normalized.slice(0, maxLength + 1);
  const boundary = Math.max(
    sliced.lastIndexOf(". "),
    sliced.lastIndexOf("! "),
    sliced.lastIndexOf("? "),
    sliced.lastIndexOf("; "),
    sliced.lastIndexOf(", ")
  );
  const trimmed = boundary >= Math.floor(maxLength * 0.55) ? sliced.slice(0, boundary + 1) : sliced.slice(0, maxLength);
  return `${trimmed.trim().replace(/[,\s]+$/, "")}...`;
}

function extractFirstImageUrl(value = "") {
  const match = String(value || "").match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? decodeHtmlEntities(match[1].trim()) : "";
}

function isLikelyImageUrl(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const withoutQuery = normalized.split("?")[0];
  if (/\.(pdf|html?)$/.test(withoutQuery)) {
    return false;
  }

  if (/^data:image\//.test(normalized)) {
    return true;
  }

  return /^(https?:)?\/\//.test(normalized) || normalized.startsWith("/");
}

export function sanitizeArticleContent(article = {}) {
  const title = joinParagraphs(cleanParagraphs(article.title || ""));
  const description = joinParagraphs(cleanParagraphs(article.description || ""));
  const content = joinParagraphs(cleanParagraphs(article.content || ""));
  const fullText = content || description || title;
  const excerpt = shortenSentence(description || fullText || title, 280);
  const embeddedImageUrl = extractFirstImageUrl(`${article.content || ""}\n${article.description || ""}`);
  const leadImageUrl =
    (isLikelyImageUrl(article.leadImageUrl) && String(article.leadImageUrl).trim()) ||
    (isLikelyImageUrl(article.imageUrl) && String(article.imageUrl).trim()) ||
    (isLikelyImageUrl(article.urlToImage) && String(article.urlToImage).trim()) ||
    (isLikelyImageUrl(embeddedImageUrl) && embeddedImageUrl) ||
    null;

  return {
    title,
    description,
    content: fullText,
    excerpt: excerpt || description || fullText || title,
    fullText,
    leadImageUrl
  };
}
