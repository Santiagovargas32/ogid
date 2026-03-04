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
    inputMode: snapshot.meta?.dataQuality?.impact?.inputMode || "live"
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
  return {
    ...predictions,
    tickers: (predictions.tickers || []).filter((item) => allowed.has(item.ticker)),
    sectors: (predictions.sectors || []).map((sector) => ({
      ...sector,
      tickers: (sector.tickers || []).filter((ticker) => allowed.has(ticker))
    }))
  };
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
    inputMode: snapshot.meta?.dataQuality?.impact?.inputMode || "live"
  });

  res.json(
    mapResponse({
      tickers,
      countries,
      windowMin,
      impactHistory: filterImpactHistory(snapshot.impactHistory || [], tickers),
      sectorBreakdown: impact.sectorBreakdown || [],
      scatterPoints: impact.scatterPoints || [],
      predictions: filterPredictions(snapshot.predictions || {}, tickers),
      meta: snapshot.meta
    })
  );
}
