import stateManager from "../state/stateManager.js";
import { computeMarketImpact } from "../services/market/impactEngineService.js";
import { buildCoverageByMode, computeQuoteAgeMin, decorateQuote, resolveQuoteOriginStage } from "../services/market/quoteMetadata.js";
import { parseCountries, parsePositiveInt, parseTickers } from "../utils/filters.js";
import { getInstrumentByCanonicalSymbol, getInstrumentById } from "../services/market/instrumentRegistry.js";
import { SUPPORTED_CANDLE_INTERVALS } from "../services/market/canonicalCandle.js";
import { MarketDataValidationError } from "../services/marketData/normalizer.js";
import { isRetryableYahooError, isYahooRateLimitError, SlidingWindowRateLimiter, yahooRetryAfterMs } from "../services/marketData/rateLimit.js";
import { normalizeNewsQueryPacks } from "../services/news/newsQueryPackService.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("backend/controllers/marketController");
const fallbackInstrumentSearchLimiter = new SlidingWindowRateLimiter();

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
          dataMode: quote.dataMode || "synthetic",
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

function buildCouplingV2({ req, service, articles, impact }) {
  if (!service) return [];
  const interval = SUPPORTED_CANDLE_INTERVALS.includes(String(req.query.couplingInterval || "15min")) ? String(req.query.couplingInterval || "15min") : "15min";
  const windows = String(req.query.couplingWindows || "60,240").split(",").map(Number).filter((value) => Number.isInteger(value) && value >= 15 && value <= 1_440).slice(0, 4); const links = []; const seen = new Set();
  for (const item of impact.items || []) { const instrument = getInstrumentByCanonicalSymbol(item.ticker); if (!instrument) continue; for (const newsId of item.linkedArticles || []) { const key = `${newsId}|${instrument.instrumentId}`; if (!seen.has(key)) { seen.add(key); links.push({ newsId, instrumentId: instrument.instrumentId }); } } }
  return service.calculate({ articles, links, benchmarkInstrumentId: req.query.benchmarkInstrumentId ? String(req.query.benchmarkInstrumentId) : null, parameters: { interval, postEventWindowsMin: windows.length ? windows : [60, 240] } });
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
        dataMode: "synthetic",
        providerDataMode: "synthetic-fallback",
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
        quotes,
        coverageByMode:
          snapshot.market?.sourceMeta?.coverageByMode || buildCoverageByMode(snapshot.market?.quotes || {})
      },
      meta: snapshot.meta
    })
  );
}

export function getWatchlist(_req, res) { return res.json(mapResponse(res.app.locals.marketWatchlistService.snapshot())); }

export function getProviderStatus(_req, res) {
  const snapshot = stateManager.getSnapshot();
  const market = snapshot.market || {};
  return res.json(mapResponse({
    provider: res.app.locals.config.market?.provider || "yahoo",
    session: market.session || null,
    sourceMode: market.sourceMode || "fallback",
    upstreamPaused: market.sourceMeta?.upstreamPaused === true,
    pauseReason: market.sourceMeta?.pauseReason || null,
    lastUpstreamError: market.sourceMeta?.lastUpstreamError || null,
    diagnostics: res.app.locals.marketDataService?.getDiagnostics?.() || null,
  }));
}

function syncMarketTickerConfig(config, tickers) {
  config.market.tickers = [...tickers];
  config.news.marketTickers = [...tickers];
  const queryPackGroups = structuredClone(config.news.queryPackGroups || {});
  if (queryPackGroups.marketSignals) delete queryPackGroups.marketSignals.tickers;
  const normalized = normalizeNewsQueryPacks(queryPackGroups, { marketTickers: tickers });
  config.news.queryPackGroups = { editorial: normalized.editorial, marketSignals: normalized.marketSignals };
  config.news.queryPacks = normalized.flattened;
}

export async function searchInstruments(req, res, next) {
  try {
    const query = String(req.query.q || "").trim();
    if (query.length < 2 || query.length > 80) return res.status(400).json({ ok: false, error: { code: "INVALID_SEARCH_QUERY", message: "q must contain between 2 and 80 characters." } });
    const limiter = res.app.locals.marketSearchRateLimiter || fallbackInstrumentSearchLimiter;
    const rate = limiter.consume(req.ip || req.socket?.remoteAddress || "unknown");
    if (!rate.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(rate.retryAfterMs / 1_000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ ok: false, error: { code: "MARKET_SEARCH_RATE_LIMITED", message: "Too many market instrument searches. Try again shortly.", retryAfterSeconds } });
    }
    const limit = parsePositiveInt(req.query.limit, 10, { min: 1, max: 20 });
    const result = await res.app.locals.marketDataService.searchSymbols(query, { limit });
    const instruments = Array.isArray(result) ? result : result?.instruments || result?.results || [];
    const searchMeta = result?.searchMeta || result?.meta || null;
    const selected = new Set(res.app.locals.marketWatchlistService.selectedInstrumentIds);
    const decorated = instruments.map((instrument) => ({
      ...instrument,
      selected: selected.has(instrument.instrumentId)
    }));
    res.app.locals.marketWatchlistService.rememberCandidates(decorated);
    return res.json(mapResponse({ query, instruments: decorated, meta: searchMeta }));
  } catch (error) {
    if (error?.code === "YAHOO_SYMBOL_TYPE_UNSUPPORTED") {
      return res.status(400).json({
        ok: false,
        error: { code: error.code, message: error.message, details: error.details || null }
      });
    }
    if (isYahooRateLimitError(error)) {
      const retryAfterSeconds = Math.max(1, Math.ceil(yahooRetryAfterMs(error, 60_000) / 1_000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      log.warn("market_search_provider_rate_limited", { retryAfterSeconds });
      return res.status(503).json({
        ok: false,
        error: {
          code: "MARKET_SEARCH_PROVIDER_RATE_LIMITED",
          message: "Yahoo Finance instrument lookup is temporarily rate limited. Existing watchlist instruments remain available.",
          retryAfterSeconds
        }
      });
    }
    if (error?.code === "YAHOO_REQUEST_FAILED" || isRetryableYahooError(error)) {
      log.warn("market_search_provider_unavailable", { code: error?.code || "YAHOO_REQUEST_FAILED" });
      return res.status(503).json({
        ok: false,
        error: {
          code: "MARKET_SEARCH_PROVIDER_UNAVAILABLE",
          message: "Yahoo Finance instrument lookup is temporarily unavailable. Existing watchlist instruments and stored market data remain available."
        }
      });
    }
    return next(error);
  }
}

export async function updateWatchlist(req, res) {
  try {
    const snapshot = await res.app.locals.marketWatchlistService.update(req.body?.instrumentIds);
    syncMarketTickerConfig(res.app.locals.config, snapshot.selectedSymbols);
    stateManager.setMarketTickers(snapshot.selectedSymbols);
    const shouldRefresh = res.app.locals.config.market.enabled && !res.app.locals.config.runtime?.disableBackgroundRefresh;
    if (shouldRefresh) queueMicrotask(async () => {
      try { await res.app.locals.orchestrator?.runMarketCycle?.("watchlist-update"); }
      catch (error) { log.warn("watchlist_market_refresh_failed", { message: error.message }); }
    });
    return res.json(mapResponse({ ...snapshot, refreshStatus: shouldRefresh ? "scheduled" : "deferred" }));
  } catch (error) {
    return res.status(400).json({ ok: false, error: { code: error.code || "INVALID_WATCHLIST", message: error.message } });
  }
}

function resolveCandlePeriod({ interval, from, to, limit }) {
  const rangeDays = from && to ? Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000)) : null;
  const barsPerDay = { "5min": 78, "15min": 26, "30min": 13, "1h": 7, "1day": 1 }[interval] || 1;
  const estimatedDays = rangeDays || Math.ceil(limit / barsPerDay);
  if (estimatedDays <= 1) return "1d";
  if (estimatedDays <= 5) return "5d";
  if (estimatedDays <= 31) return "1mo";
  if (estimatedDays <= 93) return "3mo";
  if (estimatedDays <= 186) return "6mo";
  if (estimatedDays <= 366) return "1y";
  if (estimatedDays <= 732) return "2y";
  return "5y";
}

export async function getCandles(req, res, next) {
  const instrumentId = String(req.query.instrumentId || "").trim(); const instrument = getInstrumentById(instrumentId);
  if (!instrument || instrument.verificationStatus !== "verified") return res.status(400).json({ ok: false, error: { code: "INVALID_INSTRUMENT", message: "A verified instrumentId is required." } });
  const interval = String(req.query.interval || "1day"); if (!SUPPORTED_CANDLE_INTERVALS.includes(interval)) return res.status(400).json({ ok: false, error: { code: "INVALID_INTERVAL", message: "The candle interval is not supported." } });
  const limit = parsePositiveInt(req.query.limit, 100, { min: 1, max: 500 }); const adjustmentMode = String(req.query.adjusted || "splits");
  if (!["splits", "none"].includes(adjustmentMode)) return res.status(400).json({ ok: false, error: { code: "INVALID_ADJUSTMENT", message: "adjusted must be splits or none." } });
  const yahooBacked = res.app.locals.config.market.provider === "yahoo";
  if (yahooBacked && adjustmentMode !== "splits") return res.status(400).json({ ok: false, error: { code: "UNSUPPORTED_ADJUSTMENT", message: "Yahoo candle data supports adjusted=splits only; adjusted=none is unavailable." } });
  const from = req.query.from ? new Date(req.query.from) : null; const to = req.query.to ? new Date(req.query.to) : null;
  if (Boolean(from) !== Boolean(to) || (from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from >= to)) return res.status(400).json({ ok: false, error: { code: "INVALID_RANGE", message: "from/to must define a valid bounded range." } });
  let marketDataStatus = null;
  let marketDataError = null;
  if (yahooBacked) {
    try {
      const dataset = await res.app.locals.marketDataService.fetchYahooBars(instrument.providerSymbols.yahoo, {
        period: resolveCandlePeriod({ interval, from, to, limit }),
        interval: { "1day": "1d", "1h": "1h", "30min": "30m", "15min": "15m", "5min": "5m" }[interval],
        from,
        to,
        allowStale: true
      });
      marketDataStatus = dataset.stale ? "stale" : dataset.complete === false ? "partial" : "fresh";
      marketDataError = dataset.error || null;
    } catch (error) {
      if (error instanceof MarketDataValidationError) return res.status(400).json({ ok: false, error: { code: error.code, message: error.message, details: error.details || null } });
      const existing = res.app.locals.dailyCandleService.query({ instrumentId, interval, adjustmentMode, from: from?.toISOString(), to: to?.toISOString(), limit });
      if (!existing.length) return next(error);
      marketDataStatus = "stale";
      marketDataError = { code: error.code || "YAHOO_REQUEST_FAILED", message: error.message };
    }
  }
  const candles = res.app.locals.dailyCandleService.query({ instrumentId, interval, adjustmentMode, from: from?.toISOString(), to: to?.toISOString(), limit });
  return res.json(mapResponse({ instrumentId, interval, adjusted: adjustmentMode, from: from?.toISOString() || null, to: to?.toISOString() || null, limit, status: marketDataStatus || (candles.length ? "stored" : "empty"), error: marketDataError, candles }));
}

export function getCandleMetrics(_req, res) { return res.json(mapResponse({ intraday: res.app.locals.intradayCandleService?.getMetrics?.() || null })); }

export function getTechnicalIndicators(req, res) {
  const instrumentId = String(req.query.instrumentId || ""); const instrument = getInstrumentById(instrumentId);
  if (!instrument || instrument.verificationStatus !== "verified") return res.status(404).json({ ok: false, error: { code: "INSTRUMENT_NOT_FOUND", message: "Instrument is not enabled and verified." } });
  const interval = String(req.query.interval || "1day"); if (!SUPPORTED_CANDLE_INTERVALS.includes(interval)) return res.status(400).json({ ok: false, error: { code: "INVALID_INTERVAL", message: "The candle interval is not supported." } });
  const adjustmentMode = String(req.query.adjusted || "splits"); if (!["splits", "none"].includes(adjustmentMode)) return res.status(400).json({ ok: false, error: { code: "INVALID_ADJUSTMENT", message: "adjusted must be splits or none." } });
  return res.json(mapResponse(res.app.locals.technicalIndicatorService.calculate({ instrumentId, interval, adjustmentMode })));
}

export async function backfillCandles(req, res, next) {
  try {
    const instrumentIds = Array.isArray(req.body?.instrumentIds) ? req.body.instrumentIds.map(String) : []; if (!instrumentIds.length || instrumentIds.length > 20) return res.status(400).json({ ok: false, error: { code: "INVALID_INSTRUMENTS", message: "instrumentIds must contain 1-20 entries." } });
    const days = parsePositiveInt(req.body?.days, 30, { min: 1, max: res.app.locals.config.market.dailyCandles.backfillMaxDays }); const adjustmentMode = String(req.body?.adjusted || res.app.locals.config.market.dailyCandles.adjustmentMode);
    if (!["splits", "none"].includes(adjustmentMode)) return res.status(400).json({ ok: false, error: { code: "INVALID_ADJUSTMENT", message: "adjusted must be splits or none." } });
    const result = await res.app.locals.dailyCandleService.backfill({ instrumentIds, days, adjustmentMode }); return res.status(result.creditRejections?.length ? 429 : 200).json(mapResponse(result));
  } catch (error) { return next(error); }
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
  impact.couplingV2 = buildCouplingV2({ req, service: res.app.locals.newsPriceCouplingService, articles: analysisArticles, impact });
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
    signalStrength: sector.signalStrength ?? sector.confidence,
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
      signalStrength: Number(prediction.signalStrength || prediction.predictedConfidence || prediction.confidence || 0),
      predictionScore: Number(prediction.predictionScore || 0),
      changePct: Number(quote.changePct || 0),
      radius: Math.max(
        4,
        Math.min(20, 4 + Math.abs(Number(quote.changePct || 0)) * 1.5 + Math.min(8, Number(impact.impactScore || 0) / 5))
      ),
      dataMode: quote.dataMode || "synthetic",
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
  impact.couplingV2 = buildCouplingV2({ req, service: res.app.locals.newsPriceCouplingService, articles: analysisArticles, impact });
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
      couplingV2: impact.couplingV2 || [],
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
