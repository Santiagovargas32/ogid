const LEVEL_WEIGHT = {
  Critical: 4,
  Elevated: 3,
  Monitoring: 2,
  Stable: 1
};

const DEFENSE_TICKERS = ["GD", "BA", "NOC", "LMT", "RTX", "ITA"];
const ENERGY_TICKERS = ["XOM", "CVX", "COP", "XLE"];
const INDEX_TICKERS = ["SPY"];

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

function normalizeText(value = "") {
  return ` ${String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function classifyImpact(impactScore) {
  if (impactScore >= 25) {
    return "High";
  }
  if (impactScore >= 10) {
    return "Medium";
  }
  return "Low";
}

function deriveArticleLevel(article, countries = {}) {
  const mentions = article.countryMentions || [];
  if (!mentions.length) {
    return "Monitoring";
  }

  let selected = "Stable";
  for (const iso2 of mentions) {
    const level = countries[iso2]?.level || "Stable";
    if ((LEVEL_WEIGHT[level] || 0) > (LEVEL_WEIGHT[selected] || 0)) {
      selected = level;
    }
  }
  return selected;
}

function getSentimentWeight(article) {
  if (article.sentiment?.label === "negative") {
    return 2;
  }
  if (article.sentiment?.label === "neutral") {
    return 1;
  }
  return 0;
}

function getConflictWeightNorm(article) {
  const raw = article.conflict?.totalWeight ?? 0;
  return Math.min(5, Number((raw / 4).toFixed(2)));
}

function inferTickersForArticle(article, allowedTickersSet) {
  const tickers = new Set();
  const conflictWeight = article.conflict?.totalWeight ?? 0;
  const negative = article.sentiment?.label === "negative";
  const text = normalizeText(`${article.title || ""}. ${article.description || ""}. ${article.content || ""}`);
  const hasEnergySignal = ENERGY_KEYWORDS.some((keyword) => text.includes(` ${keyword} `));

  if (conflictWeight > 0 || negative) {
    for (const ticker of DEFENSE_TICKERS) {
      if (allowedTickersSet.has(ticker)) {
        tickers.add(ticker);
      }
    }
  }

  if (hasEnergySignal) {
    for (const ticker of ENERGY_TICKERS) {
      if (allowedTickersSet.has(ticker)) {
        tickers.add(ticker);
      }
    }
  }

  for (const ticker of INDEX_TICKERS) {
    if (allowedTickersSet.has(ticker)) {
      tickers.add(ticker);
    }
  }

  return [...tickers];
}

function shouldIncludeArticle(article, countryFilterSet) {
  if (!countryFilterSet.size) {
    return true;
  }

  const mentions = article.countryMentions || [];
  if (!mentions.length) {
    return false;
  }
  return mentions.some((iso2) => countryFilterSet.has(iso2));
}

function inEventWindow(article, thresholdMs) {
  const timestamp = new Date(article.publishedAt || 0).getTime();
  return Number.isFinite(timestamp) && timestamp >= thresholdMs;
}

function tickerSector(ticker) {
  if (DEFENSE_TICKERS.includes(ticker)) {
    return "defense";
  }
  if (ENERGY_TICKERS.includes(ticker)) {
    return "energy";
  }
  return "broad";
}

function buildSectorBreakdown(items = []) {
  const sectorMap = {
    defense: { sector: "defense", eventScore: 0, impactScore: 0, tickers: new Set(), itemCount: 0 },
    energy: { sector: "energy", eventScore: 0, impactScore: 0, tickers: new Set(), itemCount: 0 },
    broad: { sector: "broad", eventScore: 0, impactScore: 0, tickers: new Set(), itemCount: 0 }
  };

  for (const item of items) {
    const sector = tickerSector(item.ticker);
    const accumulator = sectorMap[sector];
    accumulator.eventScore = Number((accumulator.eventScore + item.eventScore).toFixed(2));
    accumulator.impactScore = Number((accumulator.impactScore + item.impactScore).toFixed(2));
    accumulator.itemCount += 1;
    accumulator.tickers.add(item.ticker);
  }

  return Object.values(sectorMap)
    .map((entry) => ({
      sector: entry.sector,
      eventScore: entry.eventScore,
      impactScore: entry.impactScore,
      itemCount: entry.itemCount,
      tickers: [...entry.tickers].sort()
    }))
    .sort((a, b) => b.impactScore - a.impactScore);
}

function buildScatterPoints(items = []) {
  return items.map((item) => ({
    ticker: item.ticker,
    sector: tickerSector(item.ticker),
    eventScore: item.eventScore,
    priceReaction: item.priceReaction,
    impactScore: item.impactScore,
    level: item.level
  }));
}

function buildCouplingSeries({
  impactHistory = [],
  tickers = [],
  predictionScores = {},
  topItems = []
}) {
  const selectedTickers = tickers.length
    ? tickers
    : topItems.slice(0, 4).map((item) => item.ticker);

  if (!selectedTickers.length || !impactHistory.length) {
    return [];
  }

  const ordered = [...impactHistory].slice(-24);
  return selectedTickers.map((ticker) => ({
    ticker,
    predictionScore: Number(predictionScores[ticker] || 0),
    points: ordered
      .map((entry) => {
        const item = (entry.items || []).find((candidate) => candidate.ticker === ticker);
        if (!item) {
          return null;
        }
        return {
          timestamp: entry.timestamp,
          impactScore: Number(item.impactScore || 0),
          priceReaction: Number(item.priceReaction || 0)
        };
      })
      .filter(Boolean)
  }));
}

export function computeMarketImpact({
  articles = [],
  countries = {},
  marketQuotes = {},
  tickers = [],
  countryFilter = [],
  windowMin = 120,
  inputMode = "live",
  impactHistory = [],
  predictionScores = {}
}) {
  const normalizedTickers = tickers.map((ticker) => String(ticker).toUpperCase());
  const tickerSet = new Set(normalizedTickers);
  const countryFilterSet = new Set(countryFilter);
  const minTimestamp = Date.now() - windowMin * 60_000;
  const accumulators = Object.fromEntries(
    normalizedTickers.map((ticker) => [
      ticker,
      {
        ticker,
        eventScore: 0,
        linkedCountries: new Set(),
        linkedArticles: new Set()
      }
    ])
  );

  for (const article of articles) {
    if (!inEventWindow(article, minTimestamp)) {
      continue;
    }
    if (!shouldIncludeArticle(article, countryFilterSet)) {
      continue;
    }

    const level = deriveArticleLevel(article, countries);
    const levelWeight = LEVEL_WEIGHT[level] || 1;
    const sentimentWeight = getSentimentWeight(article);
    const conflictWeightNorm = getConflictWeightNorm(article);
    const articleWeight = Number((levelWeight + sentimentWeight + conflictWeightNorm).toFixed(2));
    const matchedTickers = inferTickersForArticle(article, tickerSet);

    for (const ticker of matchedTickers) {
      const accumulator = accumulators[ticker];
      if (!accumulator) {
        continue;
      }
      accumulator.eventScore = Number((accumulator.eventScore + articleWeight).toFixed(2));
      for (const iso2 of article.countryMentions || []) {
        accumulator.linkedCountries.add(iso2);
      }
      accumulator.linkedArticles.add(article.id);
    }
  }

  const items = normalizedTickers.map((ticker) => {
    const accumulator = accumulators[ticker];
    const quote = marketQuotes[ticker] || {
      price: null,
      changePct: 0,
      asOf: null,
      source: "unknown",
      synthetic: true
    };

    const priceReaction = Number(Math.abs(quote.changePct || 0).toFixed(2));
    const impactScore = Number((accumulator.eventScore * priceReaction).toFixed(2));

    return {
      ticker,
      impactScore,
      eventScore: accumulator.eventScore,
      priceReaction,
      windowMin,
      level: classifyImpact(impactScore),
      linkedCountries: [...accumulator.linkedCountries],
      linkedArticles: [...accumulator.linkedArticles].slice(0, 12),
      inputMode,
      quote: {
        price: quote.price,
        changePct: quote.changePct,
        asOf: quote.asOf,
        source: quote.source,
        synthetic: Boolean(quote.synthetic)
      }
    };
  });

  const orderedItems = items.sort((a, b) => b.impactScore - a.impactScore);
  return {
    updatedAt: new Date().toISOString(),
    windowMin,
    inputMode,
    items: orderedItems,
    sectorBreakdown: buildSectorBreakdown(orderedItems),
    scatterPoints: buildScatterPoints(orderedItems),
    couplingSeries: buildCouplingSeries({
      impactHistory,
      tickers: normalizedTickers,
      predictionScores,
      topItems: orderedItems
    })
  };
}
