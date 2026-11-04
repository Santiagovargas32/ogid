import { articleIdentity } from "./articleIdentity.js";
function dedupeKey(item = {}) { return articleIdentity(item); }
const provenanceKey = p => JSON.stringify([p.feedId, p.sourceId, p.provider, p.canonicalUrl]);
const routes = item => item.provenances || (item.provenance ? [item.provenance] : []);

export function deduplicateRssArticles(items = [], { maxItems = 800 } = {}) {
  const deduped = new Map();
  const clusters = new Map();

  for (const item of items) {
    const key = dedupeKey(item);
    if (!key || key.endsWith(":")) {
      continue;
    }

    const cluster = clusters.get(key) || new Set();
    // A retained corpus entry is already an aggregate. Replaying it alongside
    // a known source must not count that aggregate as another publication.
    // Aliases recover source IDs from older aggregates whose duplicateIds
    // contained repeated canonical IDs. Provenances remain separate routes,
    // never an assertion of independent corroboration.
    for (const reference of [
      ...(Array.isArray(item.duplicateIds) ? item.duplicateIds : []),
      ...(Array.isArray(item.aliases) ? item.aliases : []),
      item.id || item.url || item.title || key
    ]) if (typeof reference === "string" && reference) cluster.add(reference);
    if (cluster.size > 1) cluster.delete(key);
    clusters.set(key, cluster);

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { ...item,
        receivedAt: item.receivedAt,
        firstSeenAt: item.firstSeenAt || item.receivedAt,
        provenances: [...new Map(routes(item).map(p => [provenanceKey(p), p])).values()],
        publisher: item.publisher
      });
      continue;
    }

    const provenances = new Map([...routes(existing), ...routes(item)].map(p => [provenanceKey(p), p]));
    const preferExisting = existing.provenance?.sourceType !== "generated_search" && item.provenance?.sourceType === "generated_search";
    deduped.set(key, { ...(preferExisting ? { ...item, ...existing } : { ...existing, ...item }), id: existing.id || item.id,
      receivedAt: existing.receivedAt || item.receivedAt,
      firstSeenAt: existing.firstSeenAt || existing.receivedAt || item.firstSeenAt || item.receivedAt,
      provenances: [...provenances.values()],
      publisher: item.publisher || existing.publisher,
      aliases: [...new Set([...(existing.aliases || []), ...(item.aliases || []), existing.id, item.id].filter(Boolean))]
    });
  }

  const ordered = [...deduped.entries()]
    .map(([key, item]) => ({
      ...item,
      id: articleIdentity(item),
      aliases: [...new Set([...(item.aliases || []), item.id, articleIdentity(item)].filter(Boolean))],
      dedupeKey: key,
      duplicateCount: clusters.get(key)?.size || 0,
      duplicateIds: [...(clusters.get(key) || [])].slice(0, 10)
    }))
    .sort((left, right) => {
      const leftTime = new Date(left.publishedAt || 0).getTime();
      const rightTime = new Date(right.publishedAt || 0).getTime();
      if (rightTime !== leftTime) {
        return rightTime - leftTime;
      }
      return Number(right.credibilityScore || 0) - Number(left.credibilityScore || 0);
    })
    .slice(0, Math.max(1, Number.parseInt(String(maxItems ?? 800), 10) || 800));

  return {
    items: ordered,
    clusters: Object.fromEntries([...clusters.entries()].map(([key, values]) => [key, [...values].slice(0, 20)]))
  };
}
