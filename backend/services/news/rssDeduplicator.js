function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function headlineFingerprint(value = "") {
  return normalizeText(value)
    .split(" ")
    .filter(Boolean)
    .slice(0, 12)
    .join("|");
}

function sourceKey(value = "") {
  return normalizeText(value).replace(/\s+/g, "-");
}

function dedupeKey(item = {}) {
  const url = String(item.url || "").trim().toLowerCase();
  if (url) {
    return `url:${url}`;
  }

  return `headline:${sourceKey(item.sourceName || item.provider || "rss")}:${headlineFingerprint(item.title || "")}`;
}

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

    const existingScore = Number(existing.credibilityScore || 0) + Number(existing.duplicateCount || 1) * 0.02;
    const candidateScore = Number(item.credibilityScore || 0) + 0.05;
    const existingTime = new Date(existing.publishedAt || 0).getTime();
    const candidateTime = new Date(item.publishedAt || 0).getTime();

    if (candidateScore > existingScore || candidateTime > existingTime) {
      deduped.set(key, {
        ...existing,
        ...item
      });
    }
  }

  const ordered = [...deduped.entries()]
    .map(([key, item]) => ({
      ...item,
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
