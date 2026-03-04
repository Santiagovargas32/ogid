import stateManager from "../state/stateManager.js";
import { computeMarketImpact } from "../services/market/impactEngineService.js";
import { parseCountries, parsePositiveInt, parseTickers } from "../utils/filters.js";

function mapResponse(data) {
  return {
    ok: true,
    data
  };
}

export function getQuotes(req, res) {
  const snapshot = stateManager.getSnapshot();
  const config = res.app.locals.config;
  const defaultTickers = config.market.tickers;
  const tickers = parseTickers(req.query.tickers, defaultTickers);

  const quotes = Object.fromEntries(
    tickers.map((ticker) => [
      ticker,
      snapshot.market?.quotes?.[ticker] || {
        price: null,
        changePct: 0,
        asOf: null,
        source: "unavailable",
        synthetic: true,
        dataMode: "fallback"
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
      market: snapshot.market,
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
    max: 720
  });

  const impact = computeMarketImpact({
    articles: snapshot.news,
    countries: snapshot.countries,
    marketQuotes: snapshot.market?.quotes || {},
    tickers,
    countryFilter: countries,
    windowMin,
    inputMode: snapshot.meta?.dataQuality?.impact?.inputMode || "live",
    impactHistory: snapshot.impactHistory || [],
    predictionScores: snapshot.predictions?.predictionScoreByTicker || {}
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
    const quote = marketQuotes[prediction.ticker] || { changePct: 0 };

    return {
      ticker: prediction.ticker,
      sector: prediction.sector,
      direction: prediction.direction,
      eventScore: Number(impact.eventScore || 0),
      impactScore: Number(impact.impactScore || 0),
      predictedConfidence: Number(prediction.predictedConfidence || prediction.confidence || 0),
      predictionScore: Number(prediction.predictionScore || 0),
      changePct: Number(quote.changePct || 0),
      radius: Math.max(3, Math.min(18, Math.abs(Number(quote.changePct || 0)) * 2 + 4))
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
    max: 720
  });

  const impact = computeMarketImpact({
    articles: snapshot.news,
    countries: snapshot.countries,
    marketQuotes: snapshot.market?.quotes || {},
    tickers,
    countryFilter: countries,
    windowMin,
    inputMode: snapshot.meta?.dataQuality?.impact?.inputMode || "live",
    impactHistory: snapshot.impactHistory || [],
    predictionScores: snapshot.predictions?.predictionScoreByTicker || {}
  });
  const predictions = filterPredictions(snapshot.predictions || {}, tickers);
  const predictedSectorDirection = buildPredictedSectorDirection(predictions);
  const tickerOutlookMatrix = buildTickerOutlookMatrix({
    impactItems: impact.items || [],
    predictionTickers: predictions.tickers || [],
    marketQuotes: snapshot.market?.quotes || {}
  });

  res.json(
    mapResponse({
      tickers,
      countries,
      windowMin,
      impactHistory: filterImpactHistory(snapshot.impactHistory || [], tickers),
      sectorBreakdown: impact.sectorBreakdown || [],
      scatterPoints: impact.scatterPoints || [],
      couplingSeries: impact.couplingSeries || [],
      predictedSectorDirection,
      tickerOutlookMatrix,
      predictions,
      meta: snapshot.meta
    })
  );
}
