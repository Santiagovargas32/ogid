import apiQuotaTracker from "../../admin/apiQuotaTrackerService.js";
import { MarketDataService } from "../../marketData/marketDataService.js";
import { computeProviderScore, normalizeRequestedTickers, summarizeAttempt } from "./providerUtils.js";
import { sanitizeSensitiveData } from "../../../utils/sanitize.js";

let defaultMarketDataService = null;

function publicErrorCode(value) {
  const code = String(value || "");
  return /^(?:[A-Z][A-Z0-9_]{1,63}|[1-5][0-9]{2})$/.test(code) ? code : "yahoo-request-failed";
}

function getMarketDataService(service) {
  if (service) return service;
  if (!defaultMarketDataService) defaultMarketDataService = new MarketDataService();
  return defaultMarketDataService;
}

function publicProviderError(error, { ticker = null, scope = "provider" } = {}) {
  const code = publicErrorCode(error?.code);
  return {
    provider: "yahoo",
    scope,
    code,
    reason: code,
    message: sanitizeSensitiveData(String(error?.message || "Yahoo Finance request failed.")),
    ticker: ticker || undefined,
    retryable: error?.details?.retryable ?? null,
  };
}

function mapQuote(quote, { durationMs, score, timestamp, session }) {
  const previousClose = Number.isFinite(quote.previousClose) ? quote.previousClose : null;
  const changePct = Number.isFinite(quote.changePercent)
    ? Number(quote.changePercent.toFixed(2))
    : previousClose > 0
      ? Number((((quote.price - previousClose) / previousClose) * 100).toFixed(2))
      : 0;
  return {
    price: quote.price,
    previousClose,
    changePct,
    high: quote.high,
    low: quote.low,
    volume: quote.volume,
    marketState: String(quote.marketState || (session?.open ? "REGULAR" : "CLOSED")).toUpperCase(),
    asOf: quote.timestamp || timestamp,
    source: "yahoo",
    sourceDetail: "yahoo-finance2",
    synthetic: false,
    dataMode: "observed",
    providerDataMode: "web-delayed",
    providerLatencyMs: durationMs,
    providerScore: score,
    providerMetadata: {
      exchange: quote.exchange,
      currency: quote.currency,
      timezone: quote.timezone,
    },
  };
}

export async function fetchYahooQuotes({
  tickers = [],
  timestamp = new Date().toISOString(),
  session = null,
  marketDataService = null,
} = {}) {
  const requestedTickers = normalizeRequestedTickers(tickers);
  if (requestedTickers.length === 0) {
    return summarizeAttempt({
      provider: "yahoo",
      transport: "server-library",
      requestMode: "standby",
      requestedTickers,
      returnedTickers: [],
      missingTickers: [],
      quotaSnapshot: null,
      quotes: {},
    });
  }

  const startedAt = Date.now();
  const errors = [];
  let normalizedQuotes = [];
  try {
    normalizedQuotes = await getMarketDataService(marketDataService).fetchQuotes(requestedTickers);
    apiQuotaTracker.recordCall("yahoo", {
      status: normalizedQuotes.length ? "success" : "empty",
      fallback: false,
      timestamp,
      units: 1,
    });
  } catch (error) {
    errors.push(publicProviderError(error));
    apiQuotaTracker.recordCall("yahoo", { status: "error", fallback: true, timestamp, units: 1 });
  }

  const durationMs = Date.now() - startedAt;
  const availableBySymbol = new Map(normalizedQuotes.map((quote) => [quote.symbol, quote]));
  const returnedTickers = requestedTickers.filter((ticker) => availableBySymbol.has(ticker));
  const missingTickers = requestedTickers.filter((ticker) => !availableBySymbol.has(ticker));
  for (const ticker of missingTickers) {
    errors.push({
      provider: "yahoo",
      scope: "symbol",
      code: "yahoo-quote-missing",
      reason: "yahoo-quote-missing",
      message: `Yahoo Finance returned no usable quote for ${ticker}.`,
      ticker,
    });
  }
  const score = computeProviderScore({
    returnedCount: returnedTickers.length,
    totalTickers: requestedTickers.length,
    durationMs,
    errorCount: errors.length,
    marketOpen: Boolean(session?.open),
    transport: "api",
  });
  const quotes = Object.fromEntries(returnedTickers.map((ticker) => [
    ticker,
    mapQuote(availableBySymbol.get(ticker), { durationMs, score, timestamp, session }),
  ]));

  return summarizeAttempt({
    provider: "yahoo",
    transport: "server-library",
    requestMode: "yahoo-finance2-quote",
    durationMs,
    requestUrls: [],
    requestedTickers,
    returnedTickers,
    missingTickers,
    lastAttemptAt: timestamp,
    lastSuccessAt: returnedTickers.length ? timestamp : null,
    quotaSnapshot: null,
    score,
    errors,
    quotes,
  });
}

const INTERVAL_TO_YAHOO = Object.freeze({
  "1day": "1d",
  "1d": "1d",
  "1h": "1h",
  "30min": "30m",
  "15min": "15m",
  "5min": "5m",
  "1wk": "1wk",
  "1mo": "1mo",
});

function periodForOutputSize(outputsize, interval) {
  const rows = Math.max(1, Number.parseInt(String(outputsize ?? 365), 10) || 365);
  if (["5m", "15m", "30m"].includes(interval)) return rows <= 500 ? "5d" : "1mo";
  if (interval === "1h") {
    if (rows <= 24) return "5d";
    if (rows <= 168) return "1mo";
    if (rows <= 520) return "3mo";
    if (rows <= 1_050) return "6mo";
    return "1y";
  }
  if (rows <= 1) return "1d";
  if (rows <= 5) return "5d";
  if (rows <= 31) return "1mo";
  if (rows <= 93) return "3mo";
  if (rows <= 186) return "6mo";
  if (rows <= 366) return "1y";
  if (rows <= 732) return "2y";
  return "5y";
}

export async function fetchYahooDailyCandles({
  symbols = [],
  outputsize = 365,
  interval = "1day",
  period = null,
  marketDataService = null,
  force = false,
  timestamp = new Date().toISOString(),
} = {}) {
  const requestedSymbols = normalizeRequestedTickers(symbols);
  const yahooInterval = INTERVAL_TO_YAHOO[String(interval || "").toLowerCase()];
  if (!yahooInterval) {
    return {
      provider: "yahoo",
      source: "yahoo",
      candlesBySymbol: {},
      requestedSymbols,
      returnedSymbols: [],
      missingSymbols: requestedSymbols,
      errors: [{
        provider: "yahoo",
        scope: "provider",
        code: "INVALID_INTERVAL",
        message: `Yahoo interval is not supported: ${interval}`,
      }],
      requestUrls: [],
      fetchedAt: timestamp,
    };
  }

  const resolvedPeriod = period || periodForOutputSize(outputsize, yahooInterval);
  const ensured = await getMarketDataService(marketDataService).ensureMarketData(requestedSymbols, {
    period: resolvedPeriod,
    interval: yahooInterval,
    force,
    allowStale: true,
  });
  const candlesBySymbol = Object.fromEntries(Object.entries(ensured.data).map(([symbol, dataset]) => [
    symbol,
    {
      meta: { symbol, interval: yahooInterval, source: "yahoo", stale: dataset.stale, cached: dataset.cached },
      values: dataset.bars.map((bar) => ({
        datetime: bar.timestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      })),
    },
  ]));
  const returnedSymbols = requestedSymbols.filter((symbol) => candlesBySymbol[symbol]?.values?.length);
  const persistence = Object.values(ensured.data).reduce((total, dataset) => ({
    inserted: total.inserted + Number(dataset.persistence?.inserted || 0),
    updated: total.updated + Number(dataset.persistence?.updated || 0),
    duplicates: total.duplicates + Number(dataset.persistence?.duplicates || 0),
    rejectedOpen: total.rejectedOpen + Number(dataset.persistence?.rejectedOpen || 0),
  }), { inserted: 0, updated: 0, duplicates: 0, rejectedOpen: 0 });
  return {
    provider: "yahoo",
    source: "yahoo",
    candlesBySymbol,
    requestedSymbols,
    returnedSymbols,
    missingSymbols: requestedSymbols.filter((symbol) => !returnedSymbols.includes(symbol)),
    errors: ensured.errors.map((error) => ({ provider: "yahoo", scope: "symbol", ...error })),
    persistence,
    requestUrls: [],
    fetchedAt: timestamp,
  };
}
