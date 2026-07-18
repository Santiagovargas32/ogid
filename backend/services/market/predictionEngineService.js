import { normalizeQuoteDataMode } from "./quoteMetadata.js";

const ENERGY_KEYWORDS = [
  "oil",
  "crude",
  "gas",
  "pipeline",
  "opec",
  "energy",
  "tanker",
  "strait of hormuz",
  "export terminal"
];

const LEVEL_WEIGHT = {
  Critical: 4,
  Elevated: 3,
  Monitoring: 2,
  Stable: 1
};
const MODE_CONFIDENCE_PENALTY = Object.freeze({
  observed: 0,
  derived: 4,
  seeded: 10,
  stale: 12,
  synthetic: 18
});

function normalizeText(value = "") {
  return ` ${String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function scoreArticle(article, countries = {}) {
  const sentimentWeight = article.sentiment?.label === "negative" ? 2 : article.sentiment?.label === "neutral" ? 1 : 0;
  const conflictWeight = Math.min(5, (article.conflict?.totalWeight || 0) / 4);
  const levelWeight = Math.max(
    1,
    ...(article.countryMentions || []).map((iso2) => LEVEL_WEIGHT[countries[iso2]?.level] || 1)
  );

  return Number((sentimentWeight + conflictWeight + levelWeight).toFixed(2));
}

function normalizeSector(instrument = {}) {
  const metadata = normalizeText(`${instrument.sector || ""} ${instrument.industry || ""} ${instrument.displayName || ""}`);
  if (["defense", "aerospace", "weapon", "military"].some((value) => metadata.includes(` ${value} `))) return "defense";
  if (["energy", "oil", "gas", "petroleum"].some((value) => metadata.includes(` ${value} `))) return "energy";
  if (["index", "fund", "etf"].includes(String(instrument.assetType || "").toLowerCase())) return "broad";
  return String(instrument.sector || instrument.assetType || "broad").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "broad";
}

function sectorTickers(allowedTickers = [], instruments = [], marketQuotes = {}) {
  const groups = {};
  for (const ticker of allowedTickers.map((value) => String(value).toUpperCase())) {
    const instrument = instruments.find((item) => String(item.canonicalSymbol || item.symbol || "").toUpperCase() === ticker) || marketQuotes[ticker] || { canonicalSymbol: ticker };
    const sector = normalizeSector(instrument);
    if (!groups[sector]) groups[sector] = { tickers: [], instruments: [] };
    groups[sector].tickers.push(ticker);
    groups[sector].instruments.push(instrument);
  }
  return groups;
}

function isDefenseArticle(article) {
  return (article.conflict?.totalWeight || 0) > 0 || article.sentiment?.label === "negative";
}

function isEnergyArticle(article) {
  const text = normalizeText(`${article.title || ""}. ${article.description || ""}. ${article.content || ""}`);
  return ENERGY_KEYWORDS.some((keyword) => text.includes(` ${keyword} `));
}

function isRelevantToGroup(article, sector, instruments = []) {
  if (sector === "defense") return isDefenseArticle(article);
  if (sector === "energy") return isEnergyArticle(article);
  if (sector === "broad") return true;
  const text = normalizeText(`${article.title || ""}. ${article.description || ""}. ${article.content || ""}`);
  const terms = [sector.replaceAll("-", " "), ...instruments.flatMap((instrument) => [instrument.canonicalSymbol, instrument.symbol, instrument.displayName, instrument.sector, instrument.industry])]
    .map((value) => normalizeText(value || "").trim())
    .filter((value) => value.length >= 3);
  return terms.some((term) => text.includes(` ${term} `));
}

function latestArticles(articles = [], predicate, maxItems) {
  return articles
    .filter(predicate)
    .slice()
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, maxItems);
}

function summarizeDrivers(articles = [], tickers = []) {
  const tags = new Map();
  for (const article of articles) {
    for (const tag of article.conflict?.tags || []) {
      const key = String(tag.tag || "").trim();
      if (!key) {
        continue;
      }
      tags.set(key, (tags.get(key) || 0) + Number(tag.count || 1));
    }
  }

  const topTags = [...tags.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([tag, count]) => `${tag.toLowerCase()}:${count}`);
  const tickerDriver = tickers.length ? `tickers:${tickers.join(",")}` : "tickers:none";
  return [...topTags, tickerDriver].slice(0, 4);
}

function average(values = []) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function classifyDirection(momentum, pressure) {
  if (momentum >= 0.6) {
    return "Bullish";
  }
  if (momentum <= -0.6) {
    return "Bearish";
  }
  if (pressure >= 5) {
    return "Volatile";
  }
  return "Sideways";
}

function quoteQualityPenalty(quote = {}) {
  const normalizedMode = normalizeQuoteDataMode(quote?.dataMode || (quote?.synthetic ? "synthetic" : "observed"));
  const modePenalty = MODE_CONFIDENCE_PENALTY[normalizedMode] ?? MODE_CONFIDENCE_PENALTY.synthetic;
  const latencyPenalty = Number.isFinite(Number(quote?.providerLatencyMs))
    ? Math.min(8, Math.round(Number(quote.providerLatencyMs) / 250))
    : 0;
  const scoreBonus = Number.isFinite(Number(quote?.providerScore))
    ? Math.min(6, Math.round(Number(quote.providerScore) / 20))
    : 0;
  return Math.max(0, modePenalty + latencyPenalty - scoreBonus);
}

function buildSectorPrediction({ sector, articles, tickers, countries, marketQuotes, inputMode }) {
  const pressures = articles.map((article) => scoreArticle(article, countries));
  const sectorPressure = Number(average(pressures).toFixed(2));
  const momentum = Number(
    average(tickers.map((ticker) => Number(marketQuotes[ticker]?.changePct || 0))).toFixed(2)
  );
  const averageMarketPenalty = Math.round(average(tickers.map((ticker) => quoteQualityPenalty(marketQuotes[ticker]))) * 0.6);
  const direction = classifyDirection(momentum, sectorPressure);
  const confidence = Math.max(
    35,
    Math.min(95, Math.round(48 + sectorPressure * 6 + Math.min(20, Math.abs(momentum) * 4) - averageMarketPenalty))
  );

  return {
    sector,
    direction,
    confidence,
    signalStrength: confidence,
    horizonHours: 24,
    score: Number((sectorPressure + Math.abs(momentum)).toFixed(2)),
    drivers: summarizeDrivers(articles, tickers),
    basedOnArticles: articles.map((article) => article.id),
    tickers,
    inputMode,
    dataMode: "derived",
    marketCoveragePenalty: averageMarketPenalty
  };
}

function buildTickerPredictions(sectorPredictions = [], marketQuotes = {}) {
  const items = [];

  for (const sectorPrediction of sectorPredictions) {
    for (const ticker of sectorPrediction.tickers) {
      const quote = marketQuotes[ticker] || {};
      const dataMode = normalizeQuoteDataMode(quote?.dataMode || (quote?.synthetic ? "synthetic" : "observed"));
      const changePct = Number(quote.changePct || 0);
      const confidenceBoost = Math.min(8, Math.round(Math.abs(changePct)));
      const confidence = Math.max(
        25,
        Math.min(95, sectorPrediction.confidence + confidenceBoost - quoteQualityPenalty(quote))
      );
      const predictionScore = Number((sectorPrediction.score * (confidence / 100)).toFixed(2));
      items.push({
        ticker,
        sector: sectorPrediction.sector,
        direction: sectorPrediction.direction,
        confidence,
        predictedConfidence: confidence,
        signalStrength: confidence,
        predictionScore,
        horizonHours: sectorPrediction.horizonHours,
        drivers: [...sectorPrediction.drivers].slice(0, 3),
        basedOnArticles: [...sectorPrediction.basedOnArticles].slice(0, 5),
        marketDataMode: dataMode,
        dataMode: "derived"
      });
    }
  }

  return items;
}

function toPredictionScoreByTicker(items = []) {
  return Object.fromEntries(items.map((item) => [item.ticker, item.predictionScore || 0]));
}

export function generatePredictions({
  articles = [],
  countries = {},
  marketQuotes = {},
  tickers = [],
  instruments = [],
  inputMode = "live",
  maxNewsPerSector = 5
}) {
  const normalizedArticles = [...articles].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
  const allowed = sectorTickers(tickers, instruments, marketQuotes);
  const sectorPredictions = Object.entries(allowed).map(([sector, group]) =>
    buildSectorPrediction({
      sector,
      articles: latestArticles(normalizedArticles, (article) => isRelevantToGroup(article, sector, group.instruments), maxNewsPerSector),
      tickers: group.tickers,
      countries,
      marketQuotes,
      inputMode
    })
  );
  const tickerPredictions = buildTickerPredictions(sectorPredictions, marketQuotes);

  return {
    updatedAt: new Date().toISOString(),
    inputMode,
    dataMode: "derived",
    sectors: sectorPredictions,
    tickers: tickerPredictions,
    predictionScoreByTicker: toPredictionScoreByTicker(tickerPredictions)
  };
}
