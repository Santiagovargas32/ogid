import {
  DEFAULT_MARKET_DATA_INTERVAL,
  DEFAULT_MARKET_DATA_PERIOD,
  MarketDataValidationError,
  normalizeSearchQuery,
  normalizeYahooChart,
  normalizeYahooInstrument,
  normalizeYahooQuote,
  normalizeYahooSearchResults,
  normalizeYahooSymbol,
  resolveMarketDataRange,
} from "./normalizer.js";
import { isRetryableYahooError, isYahooRateLimitError, yahooRetryAfterMs } from "./rateLimit.js";
import { MarketDataStoreAdapter } from "./marketDataStore.js";
import { YahooClient } from "./yahooClient.js";
import { BoundedCache } from "../shared/boundedCache.js";
import { getInstrumentByProviderSymbol, listVerifiedInstruments, serializeInstrument } from "../market/instrumentRegistry.js";
import { sanitizeSensitiveData } from "../../utils/sanitize.js";

const DEFAULT_TTL_BY_INTERVAL = Object.freeze({ "5m": 15 * 60_000, "15m": 15 * 60_000, "30m": 30 * 60_000, "1h": 60 * 60_000, "1d": 6 * 60 * 60_000, "1wk": 12 * 60 * 60_000, "1mo": 24 * 60 * 60_000 });
const RANGE_TOLERANCE_BY_INTERVAL = Object.freeze({ "5m": 2 * 86_400_000, "15m": 2 * 86_400_000, "30m": 2 * 86_400_000, "1h": 2 * 86_400_000, "1d": 7 * 86_400_000, "1wk": 14 * 86_400_000, "1mo": 45 * 86_400_000 });
const INTERVAL_MS = Object.freeze({ "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "1d": 86_400_000, "1wk": 7 * 86_400_000, "1mo": 30 * 86_400_000 });
const MAX_GAP_MS_BY_INTERVAL = Object.freeze({ "5m": 5 * 86_400_000, "15m": 5 * 86_400_000, "30m": 5 * 86_400_000, "1h": 5 * 86_400_000, "1d": 10 * 86_400_000, "1wk": 21 * 86_400_000, "1mo": 95 * 86_400_000 });
const SUPPORTED_SEARCH_ASSET_TYPES = Object.freeze(["equity", "etf", "fund", "index", "currency", "crypto", "future"]);

function boundedLimit(value, fallback = 10) {
  return Math.min(25, Math.max(1, Math.trunc(Number(value) || fallback)));
}

function publicErrorCode(value, fallback = "YAHOO_REQUEST_FAILED") {
  const code = String(value || "");
  return /^(?:[A-Z][A-Z0-9_]{1,63}|[1-5][0-9]{2})$/.test(code) ? code : fallback;
}

function publicError(error) {
  const status = [error?.status, error?.statusCode, error?.response?.status, error?.code]
    .map(Number)
    .find((value) => Number.isInteger(value) && value >= 100 && value <= 599) || null;
  return {
    code: publicErrorCode(error?.code || status),
    status,
    message: sanitizeSensitiveData(String(error?.message || "Yahoo request failed")),
    retryable: isRetryableYahooError(error),
    retryAfterMs: yahooRetryAfterMs(error) || null,
  };
}

function exactYahooSymbol(value) {
  const candidate = String(value || "").trim();
  if (!candidate || /\s/.test(candidate)) return null;
  const hasSymbolSyntax = /[.^=_-]/.test(candidate);
  if (!hasSymbolSyntax && candidate !== candidate.toUpperCase()) return null;
  try { return normalizeYahooSymbol(candidate); } catch { return null; }
}

function instrumentSearchResult(instrument, source = "registry") {
  const serialized = serializeInstrument(instrument);
  return serialized ? {
    ...serialized,
    symbol: serialized.canonicalSymbol,
    name: serialized.displayName,
    source,
  } : null;
}

function localInstrumentMatches(query, limit, { exactOnly = false } = {}) {
  const needle = String(query || "").trim().toUpperCase();
  if (!needle) return [];
  return listVerifiedInstruments()
    .map((instrument) => {
      const symbols = [
        instrument.canonicalSymbol,
        instrument.providerSymbols?.yahoo,
        ...(instrument.aliases || []),
      ].map((value) => String(value || "").trim().toUpperCase()).filter(Boolean);
      const name = String(instrument.displayName || "").toUpperCase();
      const exact = symbols.includes(needle);
      if (exactOnly && !exact) return null;
      if (!exact && !symbols.some((symbol) => symbol.includes(needle)) && !name.includes(needle)) return null;
      const score = exact ? 0 : symbols.some((symbol) => symbol.startsWith(needle)) ? 1 : name.startsWith(needle) ? 2 : 3;
      return { instrument, score };
    })
    .filter(Boolean)
    .sort((left, right) => left.score - right.score || left.instrument.canonicalSymbol.localeCompare(right.instrument.canonicalSymbol))
    .slice(0, limit)
    .map(({ instrument }) => instrumentSearchResult(instrument))
    .filter(Boolean);
}

function tagSearchResults(results, meta) {
  const values = Array.isArray(results) ? results : [];
  Object.defineProperty(values, "searchMeta", {
    configurable: true,
    enumerable: false,
    value: { ...meta },
  });
  return values;
}

function coversRequestedRange(stored, range, symbol) {
  if (!stored?.bars?.length || !stored.from || !stored.to) return false;
  const intervalMs = INTERVAL_MS[range.interval];
  const durationMs = range.period2.getTime() - range.period1.getTime();
  const instrument = getInstrumentByProviderSymbol("yahoo", symbol);
  const continuousSession = instrument?.sessionPolicy === "24x7";
  let expectedSlots = intervalMs ? durationMs / intervalMs : 0;
  if (["5m", "15m", "30m", "1h"].includes(range.interval) && !continuousSession) expectedSlots *= (5 / 7) * (6.5 / 24);
  else if (range.interval === "1d" && !continuousSession) expectedSlots *= 5 / 7;
  const minimumCoverageRatio = continuousSession ? 0.65 : 0.75;
  const minimumBars = expectedSlots <= 1.5 ? 1 : Math.max(2, Math.ceil(expectedSlots * minimumCoverageRatio));
  if (stored.bars.length < minimumBars) return false;
  const timestamps = stored.bars.map((bar) => Date.parse(bar.timestamp)).filter(Number.isFinite).sort((left, right) => left - right);
  const maxGapMs = MAX_GAP_MS_BY_INTERVAL[range.interval] || Infinity;
  if (timestamps.some((timestamp, index) => index > 0 && timestamp - timestamps[index - 1] > maxGapMs)) return false;
  const tolerance = RANGE_TOLERANCE_BY_INTERVAL[range.interval] || 0;
  const fromMs = Date.parse(stored.from);
  const toMs = Date.parse(stored.to);
  return Number.isFinite(fromMs) && Number.isFinite(toMs)
    && fromMs <= range.period1.getTime() + tolerance
    && toMs >= range.period2.getTime() - tolerance;
}

export class MarketDataError extends Error {
  constructor(code, message, { cause = null, details = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "MarketDataError";
    this.code = code;
    this.details = details;
  }
}

export class MarketDataService {
  constructor({
    yahooClient = null,
    store = null,
    now = () => new Date(),
    ttlByInterval = {},
    searchTtlMs = 5 * 60_000,
  } = {}) {
    this.yahooClient = yahooClient || new YahooClient();
    this.store = store || new MarketDataStoreAdapter({ now });
    this.now = now;
    this.ttlByInterval = { ...DEFAULT_TTL_BY_INTERVAL, ...ttlByInterval };
    this.searchTtlMs = Math.max(1, Number(searchTtlMs) || 5 * 60_000);
    this.searchCache = new BoundedCache({ maxEntries: 100, defaultTtlMs: this.searchTtlMs });
    this.lastSearch = null;
  }

  async fetchYahooBars(symbol, {
    period = DEFAULT_MARKET_DATA_PERIOD,
    interval = DEFAULT_MARKET_DATA_INTERVAL,
    from = null,
    to = null,
    force = false,
    allowStale = true,
  } = {}) {
    const normalizedSymbol = normalizeYahooSymbol(symbol);
    const range = resolveMarketDataRange({ period, interval, from, to, now: this.now() });
    const ttlMs = this.ttlByInterval[range.interval];
    const stored = this.store.getBars({
      symbol: normalizedSymbol,
      period: range.period,
      interval: range.interval,
      from: range.period1,
      to: range.period2,
      ttlMs,
      range,
    });
    if (!force && stored.cached && !stored.stale && coversRequestedRange(stored, range, normalizedSymbol)) {
      return this.#dataset(normalizedSymbol, range, stored.bars, { cached: true, stale: false, fetchedAt: stored.storedAt });
    }

    try {
      const raw = await this.yahooClient.chart(normalizedSymbol, {
        period1: range.period1,
        period2: range.period2,
        interval: range.interval,
        includePrePost: false,
        events: "div|split",
      });
      const bars = normalizeYahooChart(raw, { symbol: normalizedSymbol });
      const fromMs = range.period1.getTime();
      const toMs = range.period2.getTime();
      const requestedBars = bars.filter((bar) => {
        const timestamp = Date.parse(bar.timestamp);
        return timestamp >= fromMs && timestamp <= toMs;
      });
      if (requestedBars.length === 0) throw new MarketDataError("YAHOO_NO_DATA", `Yahoo returned no OHLCV data for ${normalizedSymbol} in the requested range`);
      const complete = coversRequestedRange({
        bars: requestedBars,
        from: requestedBars[0]?.timestamp,
        to: requestedBars.at(-1)?.timestamp,
      }, range, normalizedSymbol);
      const upsert = await this.store.upsertBars(requestedBars, {
        symbol: normalizedSymbol,
        period: range.period,
        interval: range.interval,
        ttlMs,
        range,
        complete,
      });
      const inRange = upsert.bars.filter((bar) => {
        const timestamp = Date.parse(bar.timestamp);
        return timestamp >= fromMs && timestamp <= toMs;
      });
      const completenessError = complete ? null : {
        code: "YAHOO_INCOMPLETE_DATA",
        message: `Yahoo returned partial OHLCV coverage for ${normalizedSymbol}`,
        retryable: true,
      };
      return this.#dataset(normalizedSymbol, range, complete ? inRange : requestedBars, {
        cached: false,
        stale: false,
        complete,
        fetchedAt: new Date(this.now()).toISOString(),
        error: completenessError,
        persistence: upsert.persistence,
      });
    } catch (error) {
      if (error instanceof MarketDataValidationError) throw error;
      if (allowStale && stored.bars.length > 0) {
        return this.#dataset(normalizedSymbol, range, stored.bars, { cached: true, stale: true, complete: coversRequestedRange(stored, range, normalizedSymbol), fetchedAt: stored.storedAt, error: publicError(error) });
      }
      if (error instanceof MarketDataError) throw error;
      throw new MarketDataError("YAHOO_REQUEST_FAILED", `Unable to fetch Yahoo OHLCV data for ${normalizedSymbol}`, { cause: error, details: publicError(error) });
    }
  }

  getStoredMarketData(symbol, {
    period = DEFAULT_MARKET_DATA_PERIOD,
    interval = DEFAULT_MARKET_DATA_INTERVAL,
    from = null,
    to = null,
  } = {}) {
    const normalizedSymbol = normalizeYahooSymbol(symbol);
    const range = resolveMarketDataRange({ period, interval, from, to, now: this.now() });
    const stored = this.store.getBars({
      symbol: normalizedSymbol,
      period: range.period,
      interval: range.interval,
      from: range.period1,
      to: range.period2,
      ttlMs: this.ttlByInterval[range.interval],
      range,
    });
    return this.#dataset(normalizedSymbol, range, stored.bars, { cached: stored.cached, stale: stored.stale, complete: coversRequestedRange(stored, range, normalizedSymbol), fetchedAt: stored.storedAt });
  }

  async ensureMarketData(symbols, options = {}) {
    const values = Array.isArray(symbols) ? symbols : [symbols];
    const unique = [];
    const errors = [];
    for (const value of values) {
      try {
        const symbol = normalizeYahooSymbol(value);
        if (!unique.includes(symbol)) unique.push(symbol);
      } catch (error) {
        errors.push({ symbol: String(value || ""), ...publicError(error) });
      }
    }
    const settled = await Promise.allSettled(unique.map((symbol) => this.fetchYahooBars(symbol, options)));
    const data = {};
    settled.forEach((result, index) => {
      const symbol = unique[index];
      if (result.status === "fulfilled") {
        data[symbol] = result.value;
        if (result.value.error) errors.push({ symbol, ...result.value.error, stale: Boolean(result.value.stale), complete: Boolean(result.value.complete) });
      }
      else errors.push({ symbol, ...publicError(result.reason) });
    });
    return { data, errors };
  }

  async searchSymbols(query, { limit = 10, force = false } = {}) {
    const normalizedQuery = normalizeSearchQuery(query);
    const bounded = boundedLimit(limit);
    const key = `${normalizedQuery.toLowerCase()}|${bounded}`;
    const nowMs = new Date(this.now()).getTime();
    const cached = this.searchCache.get(key, nowMs);
    if (!force && cached) {
      const results = tagSearchResults([...cached.value], { ...(cached.value.searchMeta || {}), cacheHit: true });
      this.lastSearch = { ...results.searchMeta, query: normalizedQuery, resultCount: results.length, completedAt: new Date(this.now()).toISOString() };
      return results;
    }

    const exactSymbol = exactYahooSymbol(normalizedQuery);
    if (exactSymbol) {
      const local = localInstrumentMatches(exactSymbol, 1, { exactOnly: true });
      if (local.length) {
        const results = tagSearchResults(local, { source: "verified-registry", degraded: false, cacheHit: false, exactSymbol: true });
        this.searchCache.set(key, results, this.searchTtlMs, nowMs);
        this.lastSearch = { ...results.searchMeta, query: normalizedQuery, resultCount: results.length, completedAt: new Date(this.now()).toISOString() };
        return results;
      }

    }

    try {
      const raw = await this.yahooClient.search(normalizedQuery, { quotesCount: bounded, newsCount: 0 });
      const normalizedResults = normalizeYahooSearchResults(raw, { limit: bounded });
      if (exactSymbol) normalizedResults.sort((left, right) => Number(right.symbol === exactSymbol) - Number(left.symbol === exactSymbol));
      const results = tagSearchResults(normalizedResults.map((result) => {
        const known = getInstrumentByProviderSymbol("yahoo", result.symbol);
        return {
          ...result,
          ...(known ? serializeInstrument(known) : normalizeYahooInstrument(result)),
          name: result.name,
          symbol: known?.canonicalSymbol || result.symbol,
        };
      }), { source: "yahoo-search", degraded: false, cacheHit: false, exactSymbol: Boolean(exactSymbol) });
      this.searchCache.set(key, results, this.searchTtlMs, nowMs);
      this.lastSearch = { ...results.searchMeta, query: normalizedQuery, resultCount: results.length, completedAt: new Date(this.now()).toISOString() };
      return results;
    } catch (error) {
      const local = localInstrumentMatches(normalizedQuery, bounded);
      if (isYahooRateLimitError(error) && local.length) {
        const results = tagSearchResults(local, {
          source: "verified-registry",
          degraded: true,
          cacheHit: false,
          exactSymbol: Boolean(exactSymbol),
          providerError: publicError(error),
        });
        this.lastSearch = { ...results.searchMeta, query: normalizedQuery, resultCount: results.length, completedAt: new Date(this.now()).toISOString() };
        return results;
      }
      this.lastSearch = { query: normalizedQuery, source: "yahoo-search", degraded: true, exactSymbol: Boolean(exactSymbol), resultCount: 0, completedAt: new Date(this.now()).toISOString(), error: publicError(error) };
      throw error;
    }
  }

  async fetchQuotes(symbols) {
    const values = [...new Set((Array.isArray(symbols) ? symbols : [symbols]).map(normalizeYahooSymbol))];
    if (values.length === 0) return [];
    const raw = await this.yahooClient.quote(values);
    const candidates = Array.isArray(raw) ? raw : Object.values(raw || {});
    return candidates.map((value) => normalizeYahooQuote(value, { now: this.now() })).filter(Boolean);
  }

  async resolveInstrument(symbol) {
    const normalizedSymbol = normalizeYahooSymbol(symbol);
    const quote = (await this.fetchQuotes([normalizedSymbol])).find((value) => value.symbol === normalizedSymbol);
    if (!quote) throw new MarketDataError("YAHOO_SYMBOL_NOT_FOUND", `Yahoo symbol was not found: ${normalizedSymbol}`);
    return normalizeYahooInstrument(quote);
  }

  getDiagnostics() {
    return {
      provider: "yahoo-finance2",
      transport: "server-library",
      serverSide: true,
      supportedAssetTypes: [...SUPPORTED_SEARCH_ASSET_TYPES],
      symbolPolicy: {
        maxLength: 40,
        discovery: "verified-registry-then-yahoo-search",
        verification: "yahoo-quote-on-watchlist-save",
      },
      search: {
        cacheTtlMs: this.searchTtlMs,
        cacheEntries: this.searchCache.entries(new Date(this.now()).getTime()).length,
        last: this.lastSearch ? structuredClone(this.lastSearch) : null,
      },
      client: this.yahooClient?.snapshot?.() || null,
      generatedAt: new Date(this.now()).toISOString(),
    };
  }

  #dataset(symbol, range, bars, { cached, stale, complete = true, fetchedAt, error = null, persistence = null }) {
    return {
      symbol,
      source: "yahoo",
      period: range.period,
      interval: range.interval,
      bars,
      stale: Boolean(stale),
      cached: Boolean(cached),
      complete: Boolean(complete),
      fetchedAt: fetchedAt || null,
      error,
      persistence,
    };
  }
}

export { DEFAULT_TTL_BY_INTERVAL };
