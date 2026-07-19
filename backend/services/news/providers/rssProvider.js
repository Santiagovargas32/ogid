import { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";
import { providerRuntime } from "../../providers/providerRuntime.js";
import { sanitizeArticleContent } from "../newsContentSanitizer.js";

const INVALID_FEED_CACHE_MS = 6 * 60 * 60 * 1_000;
const invalidFeedCache = new Map();

function decodeEntities(value = "") {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function stripCdata(value = "") {
  return String(value).replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function extractTag(block, tagName) {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = String(block || "").match(pattern);
  return match ? decodeEntities(stripCdata(match[1]).trim()) : "";
}

function extractAtomLink(block) {
  const match = String(block || "").match(/<link[^>]+href="([^"]+)"[^>]*\/?>/i);
  return match ? decodeEntities(match[1].trim()) : "";
}

function extractImage(block) {
  const mediaMatch = String(block || "").match(/<media:content[^>]+url="([^"]+)"[^>]*\/?>/i);
  if (mediaMatch) {
    return decodeEntities(mediaMatch[1].trim());
  }

  const enclosureMatch = String(block || "").match(/<enclosure[^>]+url="([^"]+)"[^>]*\/?>/i);
  return enclosureMatch ? decodeEntities(enclosureMatch[1].trim()) : null;
}

function resolvePublishedAt(value, fallbackMs) {
  const candidate = String(value || "").trim();
  const parsed = candidate ? new Date(candidate) : null;
  if (parsed && Number.isFinite(parsed.getTime())) {
    return { value: candidate, quality: "source" };
  }

  return {
    value: new Date(fallbackMs).toISOString(),
    quality: candidate ? "fallback-invalid" : "fallback-missing"
  };
}

export function parseFeedArticles(xml = "", feedLabel = "RSS Feed", sourceDefinition = {}) {
  const sourceName = extractTag(xml, "title") || feedLabel;
  const sourceType = sourceDefinition.type || "rss";
  const items = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || String(xml || "").match(/<entry\b[\s\S]*?<\/entry>/gi) || [];

  return items.map((item, index) => {
    const title = extractTag(item, "title");
    const description =
      extractTag(item, "description") ||
      extractTag(item, "summary") ||
      extractTag(item, "content:encoded");
    const content = extractTag(item, "content:encoded") || description;
    const imageUrl = extractImage(item);
    const sanitized = sanitizeArticleContent({
      title,
      description,
      content,
      urlToImage: imageUrl
    });
    const link = extractTag(item, "link") || extractAtomLink(item);
    const rawPublishedAt =
      extractTag(item, "pubDate") ||
      extractTag(item, "published") ||
      extractTag(item, "updated");
    const publishedAt = resolvePublishedAt(rawPublishedAt, Date.now() - index * 60_000);

    return {
      provider: "rss",
      source: {
        name: sourceName,
        sourceId: sourceDefinition.sourceId || null,
        type: sourceType
      },
      publisher: sourceType === "generated_search" ? null : sourceDefinition.publisher || sourceName,
      title: sanitized.title,
      description: sanitized.description,
      content: sanitized.content,
      excerpt: sanitized.excerpt,
      fullText: sanitized.fullText,
      url: link,
      urlToImage: sanitized.leadImageUrl,
      leadImageUrl: sanitized.leadImageUrl,
      publishedAt: publishedAt.value,
      usagePolicy: "headline-only-link-out",
      dataMode: "observed",
      provenance: {
        sourceId: sourceDefinition.sourceId || null,
        sourceType,
        queryProvider: sourceDefinition.queryProvider || null,
        methodVersion: sourceDefinition.provenance?.methodVersion || "rss-parser-v1",
        publishedAtQuality: publishedAt.quality
      }
    };
  });
}

export function hasFeedEntries(xml = "") {
  return /<item\b[\s\S]*?<\/item>/i.test(String(xml || "")) || /<entry\b[\s\S]*?<\/entry>/i.test(String(xml || ""));
}

export function hasFeedEnvelope(xml = "") {
  return /<rss\b/i.test(String(xml || "")) || /<feed\b/i.test(String(xml || ""));
}

function shouldSkipInvalidFeed(url) {
  const expiresAt = invalidFeedCache.get(url);
  if (!expiresAt) {
    return false;
  }

  if (expiresAt <= Date.now()) {
    invalidFeedCache.delete(url);
    return false;
  }

  return true;
}

function markInvalidFeed(url) {
  invalidFeedCache.set(url, Date.now() + INVALID_FEED_CACHE_MS);
}

async function fetchWithTimeout(url, options, timeoutMs, retries) {
  return providerRuntime.fetch("rss", url, { ...options, timeoutMs, retries });
}

export async function fetchRss({
  feeds = [],
  timeoutMs = 9_000,
  retries
}) {
  const activeFeeds = Array.isArray(feeds) ? feeds.filter(Boolean) : [];
  if (!activeFeeds.length) {
    throw new Error("rss-feeds-missing");
  }

  const articles = [];
  let lastRateLimit = null;
  const feedStatus = [];

  for (const feed of activeFeeds) {
    let url;
    let urlValue = "";
    let label = "";

    try {
      url = new URL(feed.url || feed);
      urlValue = url.toString();
      label = feed.label || url.hostname;
    } catch {
      feedStatus.push({
        label: feed?.label || "RSS feed",
        url: String(feed?.url || feed || ""),
        status: "error",
        count: 0,
        error: "rss-invalid-url"
      });
      continue;
    }

    if (feed?.disabled) {
      feedStatus.push({
        label,
        url: urlValue,
        status: "skipped",
        count: 0,
        error: feed.reason || "feed-disabled"
      });
      continue;
    }

    if (shouldSkipInvalidFeed(urlValue)) {
      feedStatus.push({
        label,
        url: urlValue,
        status: "invalid-feed",
        count: 0,
        error: "cached-invalid-feed"
      });
      continue;
    }

    try {
      const response = await fetchWithTimeout(
        url,
        {
          headers: {
            Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
            "User-Agent": "ogid/1.0"
          }
        },
        timeoutMs,
        retries
      );
      const rateLimit = parseRateLimitHeaders(response.headers);
      lastRateLimit = rateLimit || lastRateLimit;
      const responseMeta = {
        httpStatus: response.status,
        contentType: response.headers.get("content-type") || null,
        responseUrl: response.url || urlValue,
        redirected: Boolean(response.redirected)
      };

      if (!response.ok) {
        feedStatus.push({
          label,
          url: urlValue,
          status: "error",
          count: 0,
          error: `rss-upstream-${response.status}`,
          ...responseMeta
        });
        continue;
      }

      const payload = await response.text();
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      if (!hasFeedEntries(payload)) {
        if (!hasFeedEnvelope(payload)) {
          markInvalidFeed(urlValue);
          feedStatus.push({
            label,
            url: urlValue,
            status: "invalid-feed",
            count: 0,
            error: "missing-rss-or-atom-items",
            payloadBytes,
            ...responseMeta
          });
          continue;
        }

        feedStatus.push({
          label,
          url: urlValue,
          status: "empty",
          count: 0,
          error: "feed-without-items",
          payloadBytes,
          ...responseMeta
        });
        continue;
      }

      const parsedArticles = parseFeedArticles(payload, label, feed);
      const timestampFallbackCount = parsedArticles.filter((article) =>
        String(article.provenance?.publishedAtQuality || "").startsWith("fallback-")
      ).length;
      articles.push(...parsedArticles);
      feedStatus.push({
        label,
        url: urlValue,
        status: parsedArticles.length ? "ok" : "empty",
        count: parsedArticles.length,
        timestampFallbackCount,
        error: null,
        payloadBytes,
        ...responseMeta
      });
    } catch (error) {
      feedStatus.push({
        label,
        url: urlValue,
        status: "error",
        count: 0,
        error: error?.name === "AbortError" ? "rss-timeout" : error?.message || "rss-fetch-failed"
      });
    }
  }

  return {
    provider: "rss",
    articles,
    sourceMeta: {
      provider: "rss",
      totalResults: articles.length,
      timestampFallbackCount: articles.filter((article) =>
        String(article.provenance?.publishedAtQuality || "").startsWith("fallback-")
      ).length,
      rateLimit: lastRateLimit,
      feedStatus,
      reason: articles.length ? null : "no-valid-rss-feed-results"
    }
  };
}

export function resetRssFeedValidationCacheForTests() {
  invalidFeedCache.clear();
}
