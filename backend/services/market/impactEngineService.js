const LEVEL_WEIGHT = {
  Critical: 4,
  Elevated: 3,
  Monitoring: 2,
  Stable: 1
};

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

function normalizeSector(instrument = {}) {
  const metadata = normalizeText(`${instrument.sector || ""} ${instrument.industry || ""} ${instrument.displayName || ""}`);
  if (["defense", "aerospace", "weapon", "military"].some((value) => metadata.includes(` ${value} `))) return "defense";
  if (["energy", "oil", "gas", "petroleum"].some((value) => metadata.includes(` ${value} `))) return "energy";
  if (["index", "fund", "etf"].includes(String(instrument.assetType || "").toLowerCase())) return "broad";
  const sector = String(instrument.sector || instrument.assetType || "broad").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return sector || "broad";
}

function instrumentMatchesArticle(instrument, text) {
  const symbol = normalizeText(instrument.canonicalSymbol || instrument.symbol || "").trim();
  const displayName = normalizeText(instrument.displayName || "").trim();
  const sector = normalizeText(instrument.sector || "").trim();
  const industry = normalizeText(instrument.industry || "").trim();
  return [symbol, displayName, sector, industry].filter((value) => value.length >= 3).some((value) => text.includes(` ${value} `));
}

function inferTickersForArticle(article, instrumentsByTicker) {
  const tickers = new Set();
  const conflictWeight = article.conflict?.totalWeight ?? 0;
  const negative = article.sentiment?.label === "negative";
  const text = normalizeText(`${article.title || ""}. ${article.description || ""}. ${article.content || ""}`);
  const hasEnergySignal = ENERGY_KEYWORDS.some((keyword) => text.includes(` ${keyword} `));

  for (const [ticker, instrument] of instrumentsByTicker) {
    const sector = normalizeSector(instrument);
    if (instrumentMatchesArticle(instrument, text)
      || (sector === "defense" && (conflictWeight > 0 || negative))
      || (sector === "energy" && hasEnergySignal)
      || sector === "broad") tickers.add(ticker);
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

function buildSectorBreakdown(items = []) {
  const sectorMap = new Map();

  for (const item of items) {
    const sector = item.sector || "broad";
    if (!sectorMap.has(sector)) sectorMap.set(sector, { sector, eventScore: 0, impactScore: 0, tickers: new Set(), itemCount: 0 });
    const accumulator = sectorMap.get(sector);
    accumulator.eventScore = Number((accumulator.eventScore + item.eventScore).toFixed(2));
    accumulator.impactScore = Number((accumulator.impactScore + item.impactScore).toFixed(2));
    accumulator.itemCount += 1;
    accumulator.tickers.add(item.ticker);
  }

  return [...sectorMap.values()]
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
    sector: item.sector || "broad",
    eventScore: item.eventScore,
    priceReaction: item.priceReaction,
    impactScore: item.impactScore,
    level: item.level
  }));
}

function buildCouplingSeries({ impactHistory = [], tickers = [], predictionScores = {}, topItems = [] }) {
  const selectedTickers = tickers.length ? tickers : topItems.slice(0, 4).map((item) => item.ticker);

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

export function computeMarketImpact({ articles = [], countries = {}, marketQuotes = {}, tickers = [], instruments = [], countryFilter = [], windowMin = 120, inputMode = "live", impactHistory = [], predictionScores = {} }) {
  const normalizedTickers = tickers.map((ticker) => String(ticker).toUpperCase());
  const instrumentsByTicker = new Map(normalizedTickers.map((ticker) => {
    const instrument = instruments.find((item) => String(item.canonicalSymbol || item.symbol || "").toUpperCase() === ticker) || marketQuotes[ticker] || { canonicalSymbol: ticker };
    return [ticker, instrument];
  }));
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
    const matchedTickers = inferTickersForArticle(article, instrumentsByTicker);

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
      sector: normalizeSector(instrumentsByTicker.get(ticker)),
      methodVersion: "news-price-coupling-v1",
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
        sourceDetail: quote.sourceDetail || null,
        synthetic: Boolean(quote.synthetic),
        dataMode: quote.dataMode || (quote.synthetic ? "synthetic" : "observed"),
        providerScore: Number.isFinite(Number(quote.providerScore)) ? Number(quote.providerScore) : null,
        providerLatencyMs: Number.isFinite(Number(quote.providerLatencyMs)) ? Number(quote.providerLatencyMs) : null,
        marketState: quote.marketState || null
      }
    };
  });

  const orderedItems = items.sort((a, b) => b.impactScore - a.impactScore);
  return {
    methodVersion: "news-price-coupling-v1",
    methodLabel: "Heuristic temporal association; correlation, not causality.",
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
