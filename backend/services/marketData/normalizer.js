export const SUPPORTED_MARKET_DATA_PERIODS = Object.freeze(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"]);
export const SUPPORTED_MARKET_DATA_INTERVALS = Object.freeze(["1d", "1h", "30m", "15m", "5m", "1wk", "1mo"]);
export const DEFAULT_MARKET_DATA_PERIOD = "1y";
export const DEFAULT_MARKET_DATA_INTERVAL = "1d";

const DAY_MS = 86_400_000;
const MAX_RANGE_MS_BY_INTERVAL = Object.freeze({
  "5m": 31 * DAY_MS,
  "15m": 31 * DAY_MS,
  "30m": 31 * DAY_MS,
  "1h": 366 * DAY_MS,
  "1d": 5 * 366 * DAY_MS,
  "1wk": 5 * 366 * DAY_MS,
  "1mo": 5 * 366 * DAY_MS,
});

const SUPPORTED_SEARCH_TYPES = new Set(["EQUITY", "ETF", "MUTUALFUND", "INDEX", "CURRENCY", "CRYPTOCURRENCY", "FUTURE"]);
const ASSET_TYPES = Object.freeze({ EQUITY: "equity", ETF: "etf", MUTUALFUND: "fund", INDEX: "index", CURRENCY: "currency", CRYPTOCURRENCY: "crypto", FUTURE: "future" });

export class MarketDataValidationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "MarketDataValidationError";
    this.code = code;
    this.details = details;
  }
}

function finite(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value) {
  let candidate = value;
  if (typeof candidate === "number" && Number.isFinite(candidate) && Math.abs(candidate) < 10_000_000_000) candidate *= 1_000;
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function subtractUtcMonths(value, months) {
  const result = new Date(value);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function subtractUtcYears(value, years) {
  const result = new Date(value);
  const month = result.getUTCMonth();
  result.setUTCFullYear(result.getUTCFullYear() - years);
  if (result.getUTCMonth() !== month) result.setUTCDate(0);
  return result;
}

function optionalBoundary(value, name) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MarketDataValidationError("INVALID_RANGE", `${name} must be a valid date`, { boundary: name });
  }
  return date;
}

function validateRangeDuration(period1, period2, interval) {
  const durationMs = period2.getTime() - period1.getTime();
  if (durationMs <= 0) {
    throw new MarketDataValidationError("INVALID_RANGE", "Market data from must be earlier than to");
  }
  const maximumMs = MAX_RANGE_MS_BY_INTERVAL[interval];
  if (maximumMs && durationMs > maximumMs) {
    throw new MarketDataValidationError("INVALID_RANGE", `Interval ${interval} is not allowed for the requested date range`, {
      maximumRangeDays: Math.trunc(maximumMs / DAY_MS),
    });
  }
}

export function normalizeYahooSymbol(value) {
  const symbol = String(value || "").trim().toUpperCase();
  if (!symbol || symbol.length > 40 || !/^[A-Z0-9^][A-Z0-9.^=_-]*$/.test(symbol)) {
    throw new MarketDataValidationError("INVALID_SYMBOL", "Yahoo symbol is invalid", { symbol: String(value || "") });
  }
  return symbol;
}

export function normalizeSearchQuery(value) {
  const query = String(value || "").trim().replace(/\s+/g, " ");
  if (query.length < 1 || query.length > 80 || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new MarketDataValidationError("INVALID_SEARCH_QUERY", "Search query must contain 1 to 80 printable characters");
  }
  return query;
}

export function resolveMarketDataRange({
  period = DEFAULT_MARKET_DATA_PERIOD,
  interval = DEFAULT_MARKET_DATA_INTERVAL,
  from = null,
  to = null,
  now = new Date(),
} = {}) {
  const normalizedPeriod = String(period || DEFAULT_MARKET_DATA_PERIOD).toLowerCase();
  const normalizedInterval = String(interval || DEFAULT_MARKET_DATA_INTERVAL).toLowerCase();
  if (!SUPPORTED_MARKET_DATA_PERIODS.includes(normalizedPeriod)) {
    throw new MarketDataValidationError("INVALID_PERIOD", `Unsupported market data period: ${period}`, { supported: SUPPORTED_MARKET_DATA_PERIODS });
  }
  if (!SUPPORTED_MARKET_DATA_INTERVALS.includes(normalizedInterval)) {
    throw new MarketDataValidationError("INVALID_INTERVAL", `Unsupported market data interval: ${interval}`, { supported: SUPPORTED_MARKET_DATA_INTERVALS });
  }
  const explicitFrom = optionalBoundary(from, "from");
  const explicitTo = optionalBoundary(to, "to");
  if (Boolean(explicitFrom) !== Boolean(explicitTo)) {
    throw new MarketDataValidationError("INVALID_RANGE", "from and to must be provided together");
  }
  const hasExplicitBoundary = Boolean(explicitFrom || explicitTo);
  if (!hasExplicitBoundary && normalizedInterval === "1h" && ["2y", "5y"].includes(normalizedPeriod)) {
    throw new MarketDataValidationError("INVALID_RANGE", `Interval 1h is not allowed for period ${normalizedPeriod}`, { maximumIntradayPeriod: "1y" });
  }
  if (!hasExplicitBoundary && ["5m", "15m", "30m"].includes(normalizedInterval) && !["1d", "5d", "1mo"].includes(normalizedPeriod)) {
    throw new MarketDataValidationError("INVALID_RANGE", `Interval ${normalizedInterval} is not allowed for period ${normalizedPeriod}`, { maximumIntradayPeriod: "1mo" });
  }
  const period2 = explicitTo || (now instanceof Date ? new Date(now) : new Date(now));
  if (!Number.isFinite(period2.getTime())) throw new MarketDataValidationError("INVALID_NOW", "Market data clock is invalid");
  let period1 = explicitFrom || new Date(period2);
  if (!explicitFrom && normalizedPeriod === "1d") period1.setUTCDate(period1.getUTCDate() - 1);
  else if (!explicitFrom && normalizedPeriod === "5d") period1.setUTCDate(period1.getUTCDate() - 5);
  else if (!explicitFrom && normalizedPeriod === "1mo") period1 = subtractUtcMonths(period1, 1);
  else if (!explicitFrom && normalizedPeriod === "3mo") period1 = subtractUtcMonths(period1, 3);
  else if (!explicitFrom && normalizedPeriod === "6mo") period1 = subtractUtcMonths(period1, 6);
  else if (!explicitFrom && normalizedPeriod === "1y") period1 = subtractUtcYears(period1, 1);
  else if (!explicitFrom && normalizedPeriod === "2y") period1 = subtractUtcYears(period1, 2);
  else if (!explicitFrom) period1 = subtractUtcYears(period1, 5);
  if (!hasExplicitBoundary && ["1d", "1wk", "1mo"].includes(normalizedInterval)) period1.setUTCHours(0, 0, 0, 0);
  validateRangeDuration(period1, period2, normalizedInterval);
  return { period: normalizedPeriod, interval: normalizedInterval, period1, period2, explicit: hasExplicitBoundary };
}

export function normalizeYahooBar(raw = {}, { symbol } = {}) {
  const normalizedSymbol = normalizeYahooSymbol(symbol || raw.symbol);
  const timestamp = isoTimestamp(raw.date ?? raw.timestamp);
  const open = finite(raw.open);
  const high = finite(raw.high);
  const low = finite(raw.low);
  const close = finite(raw.close);
  const volume = finite(raw.volume);
  if (!timestamp || [open, high, low, close].some((value) => value == null)) return null;
  if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) return null;
  if (volume != null && volume < 0) return null;
  return { symbol: normalizedSymbol, source: "yahoo", timestamp, open, high, low, close, volume };
}

export function normalizeYahooChart(result, { symbol } = {}) {
  const quotes = Array.isArray(result) ? result : result?.quotes;
  if (!Array.isArray(quotes)) return [];
  const byTimestamp = new Map();
  for (const quote of quotes) {
    const bar = normalizeYahooBar(quote, { symbol });
    if (bar) byTimestamp.set(bar.timestamp, bar);
  }
  return [...byTimestamp.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export function normalizeYahooQuote(raw = {}, { now = new Date() } = {}) {
  let symbol;
  try { symbol = normalizeYahooSymbol(raw.symbol); } catch { return null; }
  const price = finite(raw.regularMarketPrice);
  if (price == null) return null;
  return {
    symbol,
    source: "yahoo",
    timestamp: isoTimestamp(raw.regularMarketTime) || isoTimestamp(now),
    price,
    change: finite(raw.regularMarketChange),
    changePercent: finite(raw.regularMarketChangePercent),
    open: finite(raw.regularMarketOpen),
    high: finite(raw.regularMarketDayHigh),
    low: finite(raw.regularMarketDayLow),
    previousClose: finite(raw.regularMarketPreviousClose),
    volume: finite(raw.regularMarketVolume),
    currency: raw.currency || null,
    exchange: raw.fullExchangeName || raw.exchange || null,
    timezone: raw.exchangeTimezoneName || null,
    marketState: raw.marketState || null,
    name: raw.longName || raw.shortName || raw.displayName || symbol,
    shortName: raw.shortName || null,
    longName: raw.longName || null,
    assetType: ASSET_TYPES[String(raw.quoteType || "").toUpperCase()] || String(raw.quoteType || "unknown").toLowerCase(),
  };
}

export function normalizeYahooSearchResults(result, { limit = 10 } = {}) {
  const boundedLimit = Math.min(25, Math.max(1, Number(limit) || 10));
  const values = Array.isArray(result) ? result : result?.quotes;
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const normalized = [];
  for (const raw of values) {
    const quoteType = String(raw?.quoteType || "").toUpperCase();
    if (raw?.isYahooFinance === false || !SUPPORTED_SEARCH_TYPES.has(quoteType)) continue;
    let symbol;
    try { symbol = normalizeYahooSymbol(raw?.symbol); } catch { continue; }
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    normalized.push({
      symbol,
      source: "yahoo",
      name: raw.longname || raw.shortname || symbol,
      shortName: raw.shortname || null,
      longName: raw.longname || null,
      exchange: raw.exchDisp || raw.exchange || null,
      assetType: ASSET_TYPES[quoteType],
      quoteType,
      sector: raw.sector || raw.sectorDisp || null,
      industry: raw.industry || raw.industryDisp || null,
    });
    if (normalized.length >= boundedLimit) break;
  }
  return normalized;
}

function stableSymbolHash(symbol) {
  let hash = 2166136261;
  for (const char of symbol) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function yahooInstrumentId(symbol) {
  const normalized = normalizeYahooSymbol(symbol);
  const readable = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "symbol";
  return `yahoo-${readable}-${stableSymbolHash(normalized)}`;
}

export function normalizeYahooInstrument(value = {}) {
  const symbol = normalizeYahooSymbol(value.symbol);
  const assetType = value.assetType || ASSET_TYPES[String(value.quoteType || "").toUpperCase()] || "unknown";
  const continuous = assetType === "crypto" || assetType === "currency";
  return {
    instrumentId: yahooInstrumentId(symbol),
    canonicalSymbol: symbol,
    displayName: value.name || value.longName || value.shortName || symbol,
    assetType,
    exchange: value.exchange || null,
    currency: value.currency || null,
    timezone: value.timezone || (continuous ? "UTC" : null),
    sessionPolicy: continuous ? "24x7" : "exchange-hours",
    sector: value.sector || null,
    industry: value.industry || null,
    providerSymbols: { yahoo: symbol },
    aliases: [symbol],
    verificationStatus: "verified",
    enabled: true,
    source: "yahoo",
  };
}
