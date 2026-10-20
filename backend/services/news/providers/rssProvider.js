import { Semaphore } from "../../shared/cancellableSemaphore.js";
import { publicationDate } from "../articleIdentity.js";
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
  const name = tagName.includes(":") ? tagName : `(?:[A-Za-z_][\\w.-]*:)?${tagName}`;
  const pattern = new RegExp(`<(${name})(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, "i");
  const match = String(block || "").match(pattern);
  return match ? decodeEntities(stripCdata(match[2]).trim()) : "";
}

function extractAtomLink(block) {
  const match = String(block || "").match(/<(?:[A-Za-z_][\w.-]*:)?link\b[^>]+href="([^"]+)"[^>]*\/?>/i);
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

export function parseFeedArticles(xml = "", feedLabel = "RSS Feed", sourceDefinition = {}, maxItems = 200) {
  const sourceName = extractTag(xml, "title") || feedLabel;
  const sourceType = sourceDefinition.type || "rss";
  const items = String(xml || "").match(/<((?:[A-Za-z_][\w.-]*:)?item)\b[\s\S]*?<\/\1\s*>/gi) || String(xml || "").match(/<((?:[A-Za-z_][\w.-]*:)?entry)\b[\s\S]*?<\/\1\s*>/gi) || [];

  return items.slice(0, maxItems).map((item, index) => {
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
    const dateTags = ["pubDate", "dc:date", "published", "cb:publicationDate", "cb:occurrenceDate", "updated"];
    const publishedAtBasis = dateTags.find(tag => extractTag(item, tag)) || null;
    const rawPublishedAt = publishedAtBasis ? extractTag(item, publishedAtBasis) : "";
    const publishedAt = publicationDate(publishedAtBasis === "updated" ? null : rawPublishedAt);

    return {
      provider: "rss",
      source: {
        name: sourceName,
        sourceId: sourceDefinition.sourceId || null,
        type: sourceType,
        role: sourceDefinition.role || null,
        publisher: sourceDefinition.publisher || null,
        topics: Array.isArray(sourceDefinition.topics) ? sourceDefinition.topics : [],
        instrumentIds: Array.isArray(sourceDefinition.instrumentIds) ? sourceDefinition.instrumentIds : []
      },
      sourceRole: sourceDefinition.role || null,
      role: sourceDefinition.role || null,
      topics: Array.isArray(sourceDefinition.topics) ? sourceDefinition.topics : [],
      instrumentIds: Array.isArray(sourceDefinition.instrumentIds) ? sourceDefinition.instrumentIds : [],
      publisher: sourceType === "generated_search" ? null : sourceDefinition.publisher || sourceName,
      title: sanitized.title,
      description: sanitized.description,
      content: sanitized.content,
      excerpt: sanitized.excerpt,
      fullText: sanitized.fullText,
      url: link,
      urlToImage: sanitized.leadImageUrl,
      leadImageUrl: sanitized.leadImageUrl,
      publishedAt: publishedAt.publishedAt,
      updatedAt: publishedAtBasis === "updated" ? publicationDate(rawPublishedAt).publishedAt : null,
      usagePolicy: "headline-only-link-out",
      dataMode: "observed",
      provenance: {
        sourceId: sourceDefinition.sourceId || null,
        sourceType,
        queryProvider: sourceDefinition.queryProvider || null,
        methodVersion: sourceDefinition.provenance?.methodVersion || "rss-parser-v1",
        publishedAtQuality: publishedAt.publishedAtQuality,
        publishedAtBasis
      }
    };
  });
}

export function hasFeedEntries(xml = "") {
  return /<((?:[A-Za-z_][\w.-]*:)?(?:item|entry))\b[\s\S]*?<\/\1\s*>/i.test(String(xml || ""));
}

export function hasFeedEnvelope(xml = "") {
  return /<(?:[A-Za-z_][\w.-]*:)?(?:rss|feed)\b/i.test(String(xml || ""));
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
  return providerRuntime.fetch("rss", url, { ...options, circuitKey:`rss:${new URL(url).host}`, timeoutMs, retries });
}

export async function fetchRss({
  feeds = [],
  timeoutMs = 9_000,
  retries,
  concurrency = 4,
  deadlineMs = 60000
}) {
  const activeFeeds = Array.isArray(feeds) ? feeds.filter(Boolean) : [];
  if (!activeFeeds.length) {
    throw new Error("rss-feeds-missing");
  }

  if (activeFeeds.length > 1) {
    const deadline = Date.now() + deadlineMs, results = new Array(activeFeeds.length);
    const global=new Semaphore(concurrency),hosts=new Map();
    await Promise.all(activeFeeds.map(async(feed,index)=>{
      let host;try{host=new URL(String(feed.url || feed)).host;}catch{host='invalid';}
      if(!hosts.has(host))hosts.set(host,new Semaphore(1));
      await hosts.get(host).use(()=>global.use(async()=>{
        const remaining=deadline-Date.now();
        results[index]=remaining<=0
          ? {articles:[],sourceMeta:{feedStatus:[{label:feed.label || 'RSS',url:String(feed.url || feed),status:'deadline',count:0}]}}
          : await fetchRss({feeds:[feed],timeoutMs:Math.min(timeoutMs,remaining),retries:retries ?? 0,concurrency:1,deadlineMs:remaining});
      }));
    }));
    const articles = results.flatMap(r => r.articles);
    return { provider: "rss", articles, sourceMeta: { provider: "rss", totalResults: articles.length,
      timestampFallbackCount: results.reduce((n,r)=>n+(r.sourceMeta.timestampFallbackCount || 0),0),
      rateLimit: results.map(r=>r.sourceMeta.rateLimit).filter(Boolean).at(-1) || null,
      feedStatus: results.flatMap(r=>r.sourceMeta.feedStatus || []), reason: articles.length ? null : "no-valid-rss-feed-results" } };
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
          }, bufferResponse: true, maxResponseBytes: 2097152
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

      if(response.status===304){feedStatus.push({label,url:urlValue,status:'not-modified',count:0,error:null,...responseMeta});await response.body?.cancel();continue;}
      if (!response.ok) {
        feedStatus.push({
          label,
          url: urlValue,
          status: "error",
          count: 0,
          error: `rss-upstream-${response.status}`,
          ...responseMeta
        });
        await response.body?.cancel();
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
          error: null,
          reason: "feed-without-items",
          payloadBytes,
          ...responseMeta
        });
        continue;
      }

      const parsedArticles = parseFeedArticles(payload, label, feed, Number.MAX_SAFE_INTEGER);
      const timestampFallbackCount = parsedArticles.filter((article) =>
        !article.publishedAt
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
      const circuit=providerRuntime.getCircuitSnapshot(`rss:${new URL(urlValue).host}`);
      const cooldownUntil=circuit.state==='open'?new Date(circuit.openedAt+providerRuntime.recoveryMs).toISOString():null;
      feedStatus.push({
        label,
        url: urlValue,
        status: "error",
        count: 0,
        cooldownUntil,
        nextEligibleAt:cooldownUntil,
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
        !article.publishedAt
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
