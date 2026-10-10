import { articleIdentity } from "./articleIdentity.js";
function dedupeKey(item = {}) { return articleIdentity(item); }

export function deduplicateRssArticles(items = [], { maxItems = 800 } = {}) {
  const deduped = new Map();
  const clusters = new Map();

  for (const item of items) {
    const key = dedupeKey(item);
    if (!key || key.endsWith(":")) {
      continue;
    }

    const cluster = clusters.get(key) || [];
    cluster.push(item.id || item.url || item.title || key);
    clusters.set(key, cluster);

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { ...item });
      continue;
    }

    const provenanceKey = p => JSON.stringify([p.feedId, p.sourceId, p.provider, p.canonicalUrl]);
    const provenances = new Map([...(existing.provenances || [existing.provenance || {}]), ...(item.provenances || [item.provenance || {}])].map(p => [provenanceKey(p), p]));
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
      aliases: [...new Set([...(item.aliases || []), item.id].filter(Boolean))],
      dedupeKey: key,
      duplicateCount: (clusters.get(key) || []).length,
      duplicateIds: (clusters.get(key) || []).slice(0, 10)
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
    clusters: Object.fromEntries([...clusters.entries()].map(([key, values]) => [key, values.slice(0, 20)]))
  };
}
