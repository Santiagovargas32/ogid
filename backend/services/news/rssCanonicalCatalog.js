import { createHash } from "node:crypto";

export function canonicalizeFeedUrl(value) {
  const url = new URL(String(value || "").trim());
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  const sorted = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, entry] of sorted) url.searchParams.append(key, entry);
  return url.toString();
}

export function deriveFeedId(canonicalUrl) {
  return `feed-${createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16)}`;
}

function normalizeFeed(feed, origin, defaults) {
  const canonicalUrl = canonicalizeFeedUrl(feed?.url || feed);
  return {
    feedId: String(feed?.feedId || deriveFeedId(canonicalUrl)),
    sourceId: feed?.sourceId || null,
    type: feed?.type || (feed?.generated || origin === "secondary" ? "generated_search" : "rss"),
    label: String(feed?.label || new URL(canonicalUrl).hostname),
    publisher: feed?.publisher ?? null,
    url: canonicalUrl,
    canonicalUrl,
    aliases: [String(feed?.url || feed)],
    origins: [origin],
    priority: Number.isFinite(Number(feed?.priority)) ? Number(feed.priority) : defaults.priority,
    minPollIntervalMs: Number.isFinite(Number(feed?.minPollIntervalMs)) ? Number(feed.minPollIntervalMs) : defaults.minPollIntervalMs,
    disabled: Boolean(feed?.disabled),
    reason: feed?.reason || null,
    generated: Boolean(feed?.generated || origin === "secondary"),
    queryDefinition: feed?.queryDefinition || null,
    queryProvider: feed?.queryProvider || null,
    provenance: feed?.provenance || null
  };
}

export function buildCanonicalRssCatalog({ primaryFeeds = [], secondaryFeeds = [] } = {}) {
  const byUrl = new Map();
  const byId = new Map();
  let invalidCount = 0;
  const add = (feed, origin, defaults) => {
    let candidate;
    try { candidate = normalizeFeed(feed, origin, defaults); } catch { invalidCount += 1; return; }
    const existing = byId.get(candidate.feedId) || byUrl.get(candidate.canonicalUrl);
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...candidate.aliases])];
      existing.origins = [...new Set([...existing.origins, origin])];
      existing.priority = Math.max(existing.priority, candidate.priority);
      existing.minPollIntervalMs = Math.min(existing.minPollIntervalMs, candidate.minPollIntervalMs);
      existing.disabled = existing.disabled && candidate.disabled;
      byId.set(candidate.feedId, existing); byUrl.set(candidate.canonicalUrl, existing); return;
    }
    byId.set(candidate.feedId, candidate); byUrl.set(candidate.canonicalUrl, candidate);
  };
  for (const feed of primaryFeeds) add(feed, "primary", { priority: 100, minPollIntervalMs: 15 * 60_000 });
  for (const feed of secondaryFeeds) add(feed, "secondary", { priority: 20, minPollIntervalMs: 60 * 60_000 });
  const feeds = [...new Set(byUrl.values())].sort((left, right) => right.priority - left.priority || left.feedId.localeCompare(right.feedId));
  return { feeds, byId: new Map(feeds.map((feed) => [feed.feedId, feed])), stats: {
    primaryInputCount: primaryFeeds.length, secondaryInputCount: secondaryFeeds.length,
    generatedSearchInputCount: secondaryFeeds.filter((feed) => feed?.type === "generated_search" || feed?.generated).length,
    typeCounts: {
      rss: feeds.filter((feed) => feed.type === "rss").length,
      generated_search: feeds.filter((feed) => feed.type === "generated_search").length,
      discovery: feeds.filter((feed) => feed.type === "discovery").length
    },
    canonicalCount: feeds.length, duplicatesRemoved: primaryFeeds.length + secondaryFeeds.length - invalidCount - feeds.length, invalidCount
  } };
}
