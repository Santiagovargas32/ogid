// Salida para investigación. Nunca reenvía cuerpos de proveedores, prompts o rutas locales.
export function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) if (/token|key|secret|password|signature|auth/i.test(key)) url.searchParams.delete(key);
    url.hash = "";
    return url.href;
  } catch { return null; }
}
export function pick(value, keys) { return Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]])); }
export function cleanText(value, max = 500) { return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : null; }
export function permittedArticle(value, now = new Date().toISOString()) {
  const quality = value.provenance?.publishedAtQuality;
  const fallback = String(quality || "").startsWith("fallback-");
  const updateOnly = value.provenance?.publishedAtBasis === "updated";
  const policy = value.usagePolicy || value.provenance?.contentPolicy || "standard-link-out";
  const headlineOnly = [policy, policy?.contentPolicy, policy?.mode, value.provenance?.contentPolicy].includes("headline-only-link-out");
  const instant = date => typeof date === "string" && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
  const synthetic = Boolean(value.synthetic || value.provenance?.synthetic || ["synthetic", "fallback"].includes(value.dataMode) || value.provider === "fallback");
  return {
    ...pick(value, ["id", "provider", "sourceId", "sourceName", "publisher", "topics", "topicTags", "sectors", "instrumentIds", "countryMentions", "synthetic", "dataMode"]),
    synthetic, dataMode: value.dataMode || (synthetic ? "synthetic" : "observed"),
    title: cleanText(value.title), excerpt: headlineOnly ? null : cleanText(value.excerpt || value.description), url: safeUrl(value.url || value.canonicalUrl),
    publishedAt: fallback || updateOnly ? null : instant(value.publishedAt),
    updatedAt: updateOnly && !fallback ? instant(value.publishedAt) : instant(value.updatedAt),
    receivedAt: instant(value.receivedAt || value.fetchedAt || (fallback ? value.publishedAt : null)) || now,
    usagePolicy: typeof policy === "string" ? cleanText(policy, 100) : pick(policy, ["contentPolicy", "mode", "allowFullText", "attributionRequired"]),
    provenance: { ...pick(value.provenance, ["sourceId", "provider", "publisher", "fetchedAt", "publishedAtQuality", "publishedAtBasis", "stale", "synthetic", "methodVersion", "contentPolicy"]), ...(value.provenance?.sourceUrl ? { sourceUrl: safeUrl(value.provenance.sourceUrl) } : {}) }
  };
}
const privateKey = /token|secret|password|api.?key|authorization|cookie|requestUrls?|responsePreview|fullText|\bcontent\b|rawBody|prompt|headers|diagnostic|endpoint|baseUrl|stateFile|snapshotPath|historyDir|persistenceError|lastError|lastUpstreamError|errorMessage|lastDiagnostic|lastPoll|logs|stack|command|providerErrors|recentCycleErrors|transportDiagnostics|^error$|^message$|^body$|^payload$|^rawArticles$|^attempts$/i;
export function publicProjection(value, depth = 0) {
  if (depth > 18) return null;
  if (Array.isArray(value)) return value.map(item => publicProjection(item, depth + 1));
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value ?? null;
    if (/^https?:\/\//i.test(value)) return safeUrl(value);
    if (/^(?:\/(?!api(?:\/|$))|file:|Bearer\s)/i.test(value)) return null;
    return cleanText(value, 2000);
  }
  if (!value.eventId && value.title && (value.publishedAt !== undefined || value.provider) && value.url) {
    return { ...permittedArticle(value), ...publicProjection(pick(value, ["originalIds", "archiveFirstSeenAt", "archiveLastSeenAt", "archiveChangedAt", "contentRevision", "revision", "provenances", "matchReasons", "materiality", "claimStatus"]), depth + 1) };
  }
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => !privateKey.test(key)).map(([key, entry]) => [key, publicProjection(entry, depth + 1)]));
  if ("changePct" in result && (result.price == null || result.synthetic || ["synthetic", "fallback"].includes(result.dataMode))) result.changePct = null;
  return result;
}
export function projectOperation(operation, data) {
  if (operation.projection === "health") return publicProjection(pick(data, ["build", "status", "timestamp", "uptimeSeconds", "lastRefreshAt", "refreshIntervalMs", "sourceMode", "dataQuality", "market"]));
  if (operation.projection === "admin-counts") return { generatedAt: data.generatedAt || null, summary: numericProjection(data.summary || {}), pagination: numericProjection(data.pagination || {}), itemCount: data.items?.length ?? data.entries?.length ?? null, metrics: numericProjection(data) };
  if (operation.projection === "quotes") return publicProjection({ ...pick(data,["contractVersion","tickers","snapshotId","asOf","warnings"]), quotes: data.quotes || {}, ...(data.contractVersion === "quotes-compact-v1" && data.timeseries ? {timeseries:data.timeseries}: {}) });
  const projected = publicProjection(data);
  if (operation.projection === "quotes") {
    for (const quote of Object.values(projected.quotes || {})) if (quote.price == null || quote.synthetic || ["synthetic", "fallback"].includes(quote.dataMode)) quote.changePct = null;
    for (const quote of Object.values(projected.market?.quotes || {})) if (quote.price == null || quote.synthetic || ["synthetic", "fallback"].includes(quote.dataMode)) quote.changePct = null;
  }
  return projected;
}
export function numericProjection(value, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return value;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => numericProjection(item, depth + 1)).filter(item => item !== undefined);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKey.test(key)).map(([key, item]) => [key, numericProjection(item, depth + 1)]).filter(([, item]) => item !== undefined));
}
