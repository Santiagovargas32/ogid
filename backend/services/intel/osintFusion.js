import { createHash } from "node:crypto";
import { getCountryByIso2 } from "../../utils/countryCatalog.js";

function hashId(value = "") {
  return createHash("sha1").update(String(value || "")).digest("hex").slice(0, 14);
}

function normalizeSeverity(value = 0) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

function inferEventType(article = {}) {
  const topic = String(article.topicTags?.[0] || "").toLowerCase();
  if (topic) {
    return topic;
  }
  if ((article.conflict?.totalWeight || 0) > 0) {
    return "conflict";
  }
  return "news";
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
  const severity = normalizeSeverity(
    options.severity ??
      article.threatScore ??
      (article.conflict?.totalWeight || 0) * 10 ??
      (article.sentiment?.label === "negative" ? 25 : 10)
  );
  const eventType = options.eventType || inferEventType(article);

  if (!mentions.length) {
    return [];
  }

  return mentions
    .map((iso2) => {
      const base = eventLocationFromCountry(iso2);
      if (!base) {
        return null;
      }
      return {
        id: `evt-${hashId(`${eventType}:${article.id || article.url || article.title}:${iso2}`)}`,
        timestamp,
        location: base.location,
        country: base.country,
        event_type: eventType,
        severity,
        source: options.source || article.sourceName || article.provider || "news",
        confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(2)),
        metadata: {
          title: article.title || null,
          url: article.url || null,
          provider: article.provider || options.provider || "news",
          topicTags: article.topicTags || [],
          threatLevel: article.threatLevel || null,
          linkedCountries: mentions
        }
      };
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
      confidence: Number(quote.synthetic ? 0.45 : 0.82),
      metadata: {
        ticker,
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
      confidence: Number(Math.max(0, Math.min(1, Number(item.confidence || 50) / 100)).toFixed(2)),
      metadata: {
        ticker: item.ticker,
        sector: item.sector,
        direction: item.direction,
        confidence: item.confidence,
        predictionScore: item.predictionScore
      }
    }));
}

export function normalizeOsintEvents({ snapshot = {}, aggregateNews = { items: [] }, maxEvents = 400 } = {}) {
  const fromSnapshotNews = (snapshot.signalCorpus || []).flatMap((article) => normalizeCountryEvents(article));
  const fromAggregateRss = (aggregateNews.items || []).flatMap((article) =>
    normalizeCountryEvents(article, {
      source: article.sourceName || "rss-aggregate",
      provider: "rss-aggregate",
      confidence: Number(article.credibilityScore || 0.58),
      severity: Number(article.threatScore || 10)
    })
  );
  const fromMarket = normalizeMarketEvents(snapshot);
  const fromPredictions = normalizePredictionEvents(snapshot);

  return [...fromSnapshotNews, ...fromAggregateRss, ...fromMarket, ...fromPredictions]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, maxEvents);
}
