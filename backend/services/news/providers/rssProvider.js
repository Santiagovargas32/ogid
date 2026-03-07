import { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";

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

function parseFeedArticles(xml = "", feedLabel = "RSS Feed") {
  const sourceName = extractTag(xml, "title") || feedLabel;
  const items = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || String(xml || "").match(/<entry\b[\s\S]*?<\/entry>/gi) || [];

  return items.map((item, index) => {
    const title = extractTag(item, "title");
    const description =
      extractTag(item, "description") ||
      extractTag(item, "summary") ||
      extractTag(item, "content:encoded");
    const content = extractTag(item, "content:encoded") || description;
    const link = extractTag(item, "link") || extractAtomLink(item);
    const publishedAt =
      extractTag(item, "pubDate") ||
      extractTag(item, "published") ||
      extractTag(item, "updated") ||
      new Date(Date.now() - index * 60_000).toISOString();

    return {
      provider: "rss",
      source: {
        name: sourceName
      },
      title,
      description,
      content,
      url: link,
      urlToImage: extractImage(item),
      publishedAt,
      usagePolicy: "headline-only-link-out"
    };
  });
}

function hasFeedEntries(xml = "") {
  return /<item\b[\s\S]*?<\/item>/i.test(String(xml || "")) || /<entry\b[\s\S]*?<\/entry>/i.test(String(xml || ""));
}

function hasFeedEnvelope(xml = "") {
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRss({
  feeds = [],
  timeoutMs = 9_000
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
            "User-Agent": "ogid/1.0"
          }
        },
        timeoutMs
      );
      const rateLimit = parseRateLimitHeaders(response.headers);
      lastRateLimit = rateLimit || lastRateLimit;

      if (!response.ok) {
        feedStatus.push({
          label,
          url: urlValue,
          status: "error",
          count: 0,
          error: `rss-upstream-${response.status}`
        });
        continue;
      }

      const payload = await response.text();
      if (!hasFeedEntries(payload)) {
        if (!hasFeedEnvelope(payload)) {
          markInvalidFeed(urlValue);
          feedStatus.push({
            label,
            url: urlValue,
            status: "invalid-feed",
            count: 0,
            error: "missing-rss-or-atom-items"
          });
          continue;
        }

        feedStatus.push({
          label,
          url: urlValue,
          status: "empty",
          count: 0,
          error: "feed-without-items"
        });
        continue;
      }

      const parsedArticles = parseFeedArticles(payload, label);
      articles.push(...parsedArticles);
      feedStatus.push({
        label,
        url: urlValue,
        status: parsedArticles.length ? "ok" : "empty",
        count: parsedArticles.length,
        error: null
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
      rateLimit: lastRateLimit,
      feedStatus,
      reason: articles.length ? null : "no-valid-rss-feed-results"
    }
  };
}

export function resetRssFeedValidationCacheForTests() {
  invalidFeedCache.clear();
}
