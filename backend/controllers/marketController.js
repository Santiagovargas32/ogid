import stateManager from "../state/stateManager.js";
import { computeMarketImpact } from "../services/market/impactEngineService.js";
import { buildCoverageByMode, computeQuoteAgeMin, decorateQuote, resolveQuoteOriginStage } from "../services/market/quoteMetadata.js";
import { parseCountries, parsePositiveInt, parseTickers } from "../utils/filters.js";

function mapResponse(data) {
  return {
    ok: true,
    data
  };
}

function buildImpactEmptyReason(impact = { items: [] }) {
  if ((impact.items || []).some((item) => Number(item?.eventScore || 0) > 0 || Number(item?.impactScore || 0) > 0)) {
    return null;
  }

  return "No linked news-to-ticker signals in the current event window.";
}

function buildDataModesByTicker(tickers = [], marketQuotes = {}) {
  return Object.fromEntries(
    tickers.map((ticker) => {
      const quote = decorateQuote(marketQuotes[ticker] || {});
      return [
        ticker,
        {
          dataMode: quote.dataMode || "synthetic-fallback",
          synthetic: Boolean(quote.synthetic),
          source: quote.source || "unknown",
          sourceDetail: quote.sourceDetail || null,
          quoteOriginStage: quote.quoteOriginStage || resolveQuoteOriginStage(quote),
          quoteAgeMin: quote.quoteAgeMin ?? computeQuoteAgeMin(quote),
          providerScore: Number.isFinite(Number(quote.providerScore)) ? Number(quote.providerScore) : null,
          providerLatencyMs: Number.isFinite(Number(quote.providerLatencyMs)) ? Number(quote.providerLatencyMs) : null,
          marketState: quote.marketState || null
        }
      ];
    })
  );
}

function hasHistoricalCoupling(couplingSeries = []) {
  return (couplingSeries || []).some((series) => (series.points || []).length >= 2);
}

function latestArticleAgeMin(articles = []) {
  if (!articles.length) {
    return null;
  }

  const newestTimestamp = Math.max(
    ...articles.map((article) => new Date(article?.publishedAt || 0).getTime()).filter(Number.isFinite)
  );
  if (!Number.isFinite(newestTimestamp)) {
    return null;
  }

  return Math.max(0, Math.round((Date.now() - newestTimestamp) / 60_000));
}

function buildSignalWindow({ articles = [], requestedWindowMin, hasCurrentSignals, usesHistoricalOnly }) {
  return {
    requestedWindowMin,
    latestSelectedArticleAgeMin: latestArticleAgeMin(articles),
    hasCurrentSignals,
    usesHistoricalOnly
  };
}

function decorateQuotesMap(quotes = {}) {
  const referenceNow = Date.now();
  return Object.fromEntries(
    Object.entries(quotes || {}).map(([ticker, quote]) => [ticker, decorateQuote(quote, referenceNow)])
  );
}

function decorateImpactItems(items = [], marketQuotes = {}) {
  const referenceNow = Date.now();
  return (items || []).map((item) => {
    const quote = decorateQuote(item?.quote || marketQuotes[item?.ticker] || {}, referenceNow);
    return {
      ...item,
      quote
    };
  });
}

export function getQuotes(req, res) {
  const snapshot = stateManager.getSnapshot();
  const config = res.app.locals.config;
  const defaultTickers = config.market.tickers;
  const tickers = parseTickers(req.query.tickers, defaultTickers);
  const decoratedMarketQuotes = decorateQuotesMap(snapshot.market?.quotes || {});

  const quotes = Object.fromEntries(
    tickers.map((ticker) => [
      ticker,
      decoratedMarketQuotes[ticker] || {
        price: null,
        changePct: 0,
        asOf: null,
        source: "unavailable",
        synthetic: true,
        dataMode: "synthetic-fallback",
        quoteOriginStage: "unknown",
        quoteAgeMin: null
      }
    ])
  );

  const timeseries = Object.fromEntries(
    tickers.map((ticker) => [ticker, snapshot.market?.timeseries?.[ticker] || []])
  );

  res.json(
    mapResponse({
      tickers,
      quotes,
      timeseries,
      market: {
        ...(snapshot.market || {}),
        quotes: decoratedMarketQuotes,
        coverageByMode:
          snapshot.market?.sourceMeta?.coverageByMode || buildCoverageByMode(snapshot.market?.quotes || {})
      },
      meta: snapshot.meta
    })
  );
}

export function getImpact(req, res) {
  const snapshot = stateManager.getSnapshot();
  const config = res.app.locals.config;

  const tickers = parseTickers(req.query.tickers, config.market.tickers);
  const countries = parseCountries(req.query.countries, config.watchlistCountries);
  const windowMin = parsePositiveInt(req.query.windowMin, config.market.impactWindowMin, {
    min: 10,
    max: 1_440
  });
  const analysisArticles = stateManager.getSignalCorpus();

  const impact = computeMarketImpact({
    articles: analysisArticles,
    countries: snapshot.countries,
    marketQuotes: snapshot.market?.quotes || {},
    tickers,
    countryFilter: countries,
    windowMin,
    inputMode: snapshot.meta?.dataQuality?.impact?.inputMode || "live",
    impactHistory: snapshot.impactHistory || [],
    predictionScores: snapshot.predictions?.predictionScoreByTicker || {}
  });
  impact.items = decorateImpactItems(impact.items || [], snapshot.market?.quotes || {});
  impact.emptyReason = buildImpactEmptyReason(impact);
  impact.signalWindow = buildSignalWindow({
    articles: analysisArticles,
    requestedWindowMin: windowMin,
    hasCurrentSignals: (impact.items || []).some(
      (item) => Number(item?.eventScore || 0) > 0 || Number(item?.impactScore || 0) > 0
    ),
    usesHistoricalOnly: hasHistoricalCoupling(impact.couplingSeries || [])
  });

  res.json(
    mapResponse({
      impact,
      tickers,
      countries,
      meta: snapshot.meta
    })
  );
}

function filterImpactHistory(history = [], tickers = []) {
  if (!tickers.length) {
    return history;
  }
  const allowed = new Set(tickers);
  return history
    .map((entry) => ({
      ...entry,
      items: (entry.items || []).filter((item) => allowed.has(item.ticker))
    }))
    .filter((entry) => entry.items.length);
}

function filterPredictions(predictions = { sectors: [], tickers: [] }, tickers = []) {
  if (!tickers.length) {
    return predictions;
  }
  const allowed = new Set(tickers);
  const tickerItems = (predictions.tickers || []).filter((item) => allowed.has(item.ticker));
  return {
    ...predictions,
    tickers: tickerItems,
    predictionScoreByTicker: Object.fromEntries(
      tickerItems.map((item) => [item.ticker, Number(item.predictionScore || 0)])
    ),
    sectors: (predictions.sectors || []).map((sector) => ({
      ...sector,
      tickers: (sector.tickers || []).filter((ticker) => allowed.has(ticker))
    }))
  };
}

function buildPredictedSectorDirection(predictions = { sectors: [] }) {
  return (predictions.sectors || []).map((sector) => ({
    sector: sector.sector,
    direction: sector.direction,
    confidence: sector.confidence,
    score: sector.score,
    inputMode: sector.inputMode
  }));
}

function buildTickerOutlookMatrix({ impactItems = [], predictionTickers = [], marketQuotes = {} }) {
  const impactByTicker = Object.fromEntries((impactItems || []).map((item) => [item.ticker, item]));
  return (predictionTickers || []).map((prediction) => {
    const impact = impactByTicker[prediction.ticker] || {
      eventScore: 0,
      impactScore: 0
    };
    const quote = decorateQuote(marketQuotes[prediction.ticker] || { changePct: 0 });

    return {
      ticker: prediction.ticker,
      sector: prediction.sector,
      direction: prediction.direction,
      eventScore: Number(impact.eventScore || 0),
      impactScore: Number(impact.impactScore || 0),
      predictedConfidence: Number(prediction.predictedConfidence || prediction.confidence || 0),
      predictionScore: Number(prediction.predictionScore || 0),
      changePct: Number(quote.changePct || 0),
      radius: Math.max(
        4,
        Math.min(20, 4 + Math.abs(Number(quote.changePct || 0)) * 1.5 + Math.min(8, Number(impact.impactScore || 0) / 5))
      ),
      dataMode: quote.dataMode || "synthetic-fallback",
      quoteSource: quote.source || "unknown",
      synthetic: Boolean(quote.synthetic),
      quoteOriginStage: quote.quoteOriginStage || resolveQuoteOriginStage(quote),
      quoteAgeMin: quote.quoteAgeMin ?? computeQuoteAgeMin(quote)
    };
  });
}

export function getAnalytics(req, res) {
  const snapshot = stateManager.getSnapshot();
  const config = res.app.locals.config;

  const tickers = parseTickers(req.query.tickers, config.market.tickers);
  const countries = parseCountries(req.query.countries, config.watchlistCountries);
  const windowMin = parsePositiveInt(req.query.windowMin, config.market.impactWindowMin, {
    min: 10,
    max: 1_440
  });
  const analysisArticles = stateManager.getSignalCorpus();

  const impact = computeMarketImpact({
    articles: analysisArticles,
    countries: snapshot.countries,
    marketQuotes: snapshot.market?.quotes || {},
    tickers,
    countryFilter: countries,
    windowMin,
    inputMode: snapshot.meta?.dataQuality?.impact?.inputMode || "live",
    impactHistory: snapshot.impactHistory || [],
    predictionScores: snapshot.predictions?.predictionScoreByTicker || {}
  });
  impact.items = decorateImpactItems(impact.items || [], snapshot.market?.quotes || {});
  const predictions = filterPredictions(snapshot.predictions || {}, tickers);
  const predictedSectorDirection = buildPredictedSectorDirection(predictions);
  const tickerOutlookMatrix = buildTickerOutlookMatrix({
    impactItems: impact.items || [],
    predictionTickers: predictions.tickers || [],
    marketQuotes: snapshot.market?.quotes || {}
  });
  const hasCurrentSignals = (impact.items || []).some(
    (item) => Number(item?.eventScore || 0) > 0 || Number(item?.impactScore || 0) > 0
  );
  const usesHistoricalOnly = !hasCurrentSignals && hasHistoricalCoupling(impact.couplingSeries || []);
  const emptyReason = hasCurrentSignals
    ? null
    : usesHistoricalOnly
      ? "Current window has no linked news-to-ticker signals; showing historical coupling only."
      : "No linked news-to-ticker signals in the current event window.";
  const signalWindow = buildSignalWindow({
    articles: analysisArticles,
    requestedWindowMin: windowMin,
    hasCurrentSignals,
    usesHistoricalOnly
  });

  res.json(
    mapResponse({
      tickers,
      countries,
      windowMin,
      impactHistory: filterImpactHistory(snapshot.impactHistory || [], tickers),
      sectorBreakdown: impact.sectorBreakdown || [],
      scatterPoints: impact.scatterPoints || [],
      impactItems: impact.items || [],
      couplingSeries: impact.couplingSeries || [],
      predictedSectorDirection,
      tickerOutlookMatrix,
      predictions,
      hasCurrentSignals,
      usesHistoricalOnly,
      dataModesByTicker: buildDataModesByTicker(tickers, snapshot.market?.quotes || {}),
      signalWindow,
      emptyReason,
      meta: snapshot.meta
    })
  );
}
