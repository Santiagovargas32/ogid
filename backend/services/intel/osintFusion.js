import { createHash } from "node:crypto";
import { getCountryByIso2 } from "../../utils/countryCatalog.js";

export const OSINT_FUSION_METHODOLOGY = Object.freeze({
  version: "osint-event-fusion-v2",
  deduplicationKey: "articleId+country+eventType",
  newsTypeProjection: "one event per distinct topic tag and country",
  maximumTopicTypesPerArticle: 8,
  newsSeverityNormalization: "100*(1-exp(-log1p(rawThreatScore)/log1p(8)))"
});

function hashId(value = "") {
  return createHash("sha1").update(String(value || "")).digest("hex").slice(0, 14);
}

function articleIdentity(article = {}) {
  const url = String(article.url || "").trim().toLowerCase().replace(/[?#].*$/, "");
  if (url) {
    return `url:${url}`;
  }
  const title = String(article.title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `title:${title || article.id || "unknown"}`;
}

function normalizeSeverity(value = 0) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

function inferEventTypes(article = {}) {
  const topics = [...new Set((article.topicTags || []).map((topic) => String(topic || "").toLowerCase()).filter(Boolean))].slice(0, 8);
  if (topics.length) return topics;
  if ((article.conflict?.totalWeight || 0) > 0) {
    return ["conflict"];
  }
  return ["news"];
}

function normalizeNewsSeverity(value = 0) {
  const rawScore = Math.max(0, Number(value || 0));
  return normalizeSeverity(100 * (1 - Math.exp(-Math.log1p(rawScore) / Math.log1p(8))));
}

function eventLocationFromCountry(iso2) {
  const country = getCountryByIso2(iso2);
  if (!country) {
    return null;
  }
  return {
    country: iso2,
    location: {
      lat: country.lat,
      lng: country.lng
    }
  };
}

function normalizeCountryEvents(article = {}, options = {}) {
  const mentions = [...new Set(article.countryMentions || [])];
  const timestamp = article.publishedAt || article.timestamp || new Date().toISOString();
  const confidence = Number(options.confidence ?? article.credibilityScore ?? 0.62);
  const rawThreatScore = options.severity ?? article.threatScore ?? article.conflict?.totalWeight ??
    (article.sentiment?.label === "negative" ? 1 : 0);
  const severity = normalizeNewsSeverity(rawThreatScore);
  const eventTypes = options.eventType ? [String(options.eventType).toLowerCase()] : inferEventTypes(article);
  const articleId = articleIdentity(article);

  if (!mentions.length) {
    return [];
  }

  return mentions
    .flatMap((iso2) => {
      const base = eventLocationFromCountry(iso2);
      if (!base) {
        return [];
      }
      return eventTypes.map((eventType) => ({
          id: `evt-${hashId(`${articleId}:${iso2}:${eventType}`)}`,
          timestamp,
          location: base.location,
          country: base.country,
          event_type: eventType,
          severity,
          source: options.source || article.sourceName || article.provider || "news",
          sourceKind: "news",
          confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(2)),
          metadata: {
            title: article.title || null,
            articleId,
            url: article.url || null,
            provider: article.provider || options.provider || "news",
            topicTags: article.topicTags || [],
            threatLevel: article.threatLevel || null,
            linkedCountries: mentions
          }
        }));
    })
    .filter(Boolean);
}

function normalizeMarketEvents(snapshot = {}) {
  return Object.entries(snapshot.market?.quotes || {})
    .filter(([, quote]) => Math.abs(Number(quote?.changePct || 0)) >= 1)
    .map(([ticker, quote]) => ({
      id: `evt-${hashId(`market:${ticker}:${quote.asOf || snapshot.market?.updatedAt}`)}`,
      timestamp: quote.asOf || snapshot.market?.updatedAt || new Date().toISOString(),
      location: null,
      country: "US",
      event_type: "market",
      severity: normalizeSeverity(Math.abs(Number(quote.changePct || 0)) * 12),
      source: quote.source || "market-router",
      sourceKind: "market",
      confidence: Number(quote.synthetic ? 0.45 : 0.82),
      metadata: {
        ticker,
        articleId: `market:${ticker}:${quote.asOf || snapshot.market?.updatedAt}`,
        price: quote.price,
        changePct: quote.changePct,
        dataMode: quote.dataMode || (quote.synthetic ? "synthetic-fallback" : "live")
      }
    }));
}

function normalizePredictionEvents(snapshot = {}) {
  return (snapshot.predictions?.tickers || [])
    .filter((item) => Number(item.predictionScore || 0) > 0)
    .map((item) => ({
      id: `evt-${hashId(`prediction:${item.ticker}:${snapshot.predictions?.updatedAt}`)}`,
      timestamp: snapshot.predictions?.updatedAt || new Date().toISOString(),
      location: null,
      country: item.sector === "energy" ? "IR" : item.sector === "defense" ? "US" : "US",
      event_type: "prediction",
      severity: normalizeSeverity(Number(item.predictionScore || 0) * 8),
      source: "prediction-engine",
      sourceKind: "prediction",
      confidence: Number(Math.max(0, Math.min(1, Number(item.confidence || 50) / 100)).toFixed(2)),
      metadata: {
        ticker: item.ticker,
        articleId: `prediction:${item.ticker}:${snapshot.predictions?.updatedAt}`,
        sector: item.sector,
        direction: item.direction,
        confidence: item.confidence,
        predictionScore: item.predictionScore
      }
    }));
}

export function deduplicateOsintEvents(events = []) {
  const deduplicated = new Map();
  for (const event of events) {
    const articleId = event.metadata?.articleId || event.id || "unknown";
    const key = `${articleId}:${event.country || "global"}:${event.event_type || "unknown"}`;
    const current = deduplicated.get(key);
    if (!current || Number(event.confidence || 0) > Number(current.confidence || 0)) {
      deduplicated.set(key, event);
    }
  }
  return [...deduplicated.values()];
}

export function normalizeOsintEvents({
  snapshot = {},
  aggregateNews = { items: [] },
  maxEvents = 400,
  windowHours = null,
  now = Date.now()
} = {}) {
  const fromSnapshotNews = (snapshot.signalCorpus || []).flatMap((article) => normalizeCountryEvents(article));
  const fromAggregateRss = (aggregateNews.items || []).flatMap((article) =>
    normalizeCountryEvents(article, {
      source: article.sourceName || "rss-aggregate",
      provider: "rss-aggregate",
      confidence: Number(article.credibilityScore || 0.58),
      severity: Number(article.threatScore ?? 0)
    })
  );
  const fromMarket = normalizeMarketEvents(snapshot);
  const fromPredictions = normalizePredictionEvents(snapshot);

  const thresholdMs = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0
    ? Number(now) - Number(windowHours) * 60 * 60 * 1_000
    : null;

  return deduplicateOsintEvents([...fromSnapshotNews, ...fromAggregateRss, ...fromMarket, ...fromPredictions])
    .filter((event) => {
      if (thresholdMs === null) {
        return true;
      }
      const timestampMs = new Date(event.timestamp || 0).getTime();
      return Number.isFinite(timestampMs) && timestampMs >= thresholdMs && timestampMs <= Number(now) + 5 * 60 * 1_000;
    })
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, maxEvents);
}
