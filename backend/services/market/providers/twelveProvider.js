import apiQuotaTracker from "../../admin/apiQuotaTrackerService.js";
import {
  buildProviderError,
  computeChangePct,
  computeProviderScore,
  ensureTrailingSlash,
  fetchWithTimeout,
  normalizeRequestedTickers,
  parseInteger,
  parsePercent,
  parsePrice,
  summarizeAttempt,
  toIsoTimestamp
} from "./providerUtils.js";
import { decorateCanonicalQuote, getInstrumentByProviderSymbol } from "../instrumentRegistry.js";

export const DEFAULT_TWELVE_BASE_URL = "https://api.twelvedata.com";

function normalizeCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }
  if (Array.isArray(payload.result)) {
    return payload.result;
  }
  if (Array.isArray(payload.quotes)) {
    return payload.quotes;
  }
  if (payload.symbol || payload.ticker) {
    return [payload];
  }

  return Object.values(payload).flatMap((value) => {
    if (Array.isArray(value)) {
      return value;
    }
    if (value && typeof value === "object" && (value.symbol || value.ticker)) {
      return [value];
    }
    return [];
  });
}

function buildTwelveBatchQuoteUrl({ baseUrl = DEFAULT_TWELVE_BASE_URL, symbols = [], apiKey = "", enablePrepost = false } = {}) {
  const url = new URL("quote", ensureTrailingSlash(baseUrl));
  url.searchParams.set("symbol", symbols.join(","));
  url.searchParams.set("format", "JSON");
  if (enablePrepost) {
    url.searchParams.set("prepost", "true");
  }
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
  }
  return url;
}

function parseTwelveQuote(item = {}, timestamp = new Date().toISOString(), marketSession = {}, providerLatencyMs = null, providerScore = null) {
  const symbol = String(item?.symbol || item?.ticker || item?.instrument?.symbol || "").trim().toUpperCase();
  const price =
    parsePrice(item?.close) ??
    parsePrice(item?.price) ??
    parsePrice(item?.latestPrice) ??
    parsePrice(item?.last) ??
    parsePrice(item?.close_price);

  if (!symbol || !Number.isFinite(price)) {
    return null;
  }

  const previousClose =
    parsePrice(item?.previous_close) ??
    parsePrice(item?.previousClose) ??
    parsePrice(item?.previous_close_price) ??
    parsePrice(item?.prev_close);
  const fallbackChangePct =
    parsePercent(item?.percent_change) ??
    parsePercent(item?.change_percent) ??
    parsePercent(item?.change_pct) ??
    parsePercent(item?.changePercent);
  const changePct = computeChangePct(price, previousClose, fallbackChangePct);

  return {
    price,
    changePct,
    high: parsePrice(item?.high) ?? parsePrice(item?.day_high) ?? null,
    low: parsePrice(item?.low) ?? parsePrice(item?.day_low) ?? null,
    volume: parseInteger(item?.volume) ?? parseInteger(item?.turnover) ?? null,
    previousClose,
    marketState: String(
      item?.market_state || item?.marketState || (marketSession?.open ? "REGULAR" : "CLOSED")
    ).toUpperCase(),
    asOf: toIsoTimestamp(item?.datetime ?? item?.timestamp ?? item?.date ?? item?.time, timestamp),
    source: "twelve",
    sourceDetail: "twelve",
    synthetic: false,
    dataMode: "observed",
    providerDataMode: "live",
    providerLatencyMs,
    providerScore,
    providerMetadata: {
      exchange: item?.exchange || null,
      mic: item?.mic_code || item?.mic || null,
      currency: item?.currency || null,
      timezone: item?.timezone || null
    }
  };
}

function buildUnavailableResult(requestedTickers = [], timestamp = new Date().toISOString(), options = {}) {
  const error = options.code
    ? [
      buildProviderError({
        provider: "twelve",
        scope: "provider",
        code: options.code,
        message: options.message,
        tickers: requestedTickers
      })
    ]
    : [];

  return {
    provider: "twelve",
    transport: "api",
    configuredBaseUrl: options.configuredBaseUrl || DEFAULT_TWELVE_BASE_URL,
    quotes: {},
    missingTickers: requestedTickers,
    historicalSeries: {},
    requestMode: options.requestMode || "unavailable",
    durationMs: 0,
    requestUrls: [],
    httpStatus: null,
    lastAttemptAt: options.code ? timestamp : null,
    lastSuccessAt: null,
    quotaSnapshot: apiQuotaTracker.getProviderSnapshot("twelve"),
    score: 0,
    requestedTickers,
    returnedTickers: [],
    errors: error,
    responsePreview: null
  };
}

export async function fetchTwelveQuotes({
  baseUrl = DEFAULT_TWELVE_BASE_URL,
  apiKey = "",
  tickers = [],
  timeoutMs = 10_000,
  timestamp = new Date().toISOString(),
  enablePrepost = false,
  session = null
} = {}) {
  const requestedTickers = normalizeRequestedTickers(tickers);
  const configuredBaseUrl = baseUrl || DEFAULT_TWELVE_BASE_URL;
  const marketSession = session || { open: false, state: "closed", checkedAt: timestamp };

  if (!requestedTickers.length) {
    return buildUnavailableResult([], timestamp, {
      configuredBaseUrl,
      requestMode: "standby"
    });
  }

  if (!apiKey) {
    return buildUnavailableResult(requestedTickers, timestamp, {
      configuredBaseUrl,
      code: "api-key-missing",
      message: "Twelve Data API key is missing."
    });
  }

  const requestUrl = buildTwelveBatchQuoteUrl({
    baseUrl: configuredBaseUrl,
    symbols: requestedTickers,
    apiKey,
    enablePrepost
  });
  const requestUnits = requestedTickers.length;
  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(
      requestUrl,
      {
        retries: 0,
        headers: {
          Accept: "application/json"
        }
      },
      timeoutMs
    );
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    const durationMs = Date.now() - startedAt;
    const retryAfterValue = response.headers.get("retry-after");
    const retryAfterSeconds = Number(retryAfterValue);
    const retryAfterDate = Date.parse(String(retryAfterValue || ""));
    const retryAfterMs = retryAfterValue == null ? null : Number.isFinite(retryAfterSeconds)
      ? Math.max(0, retryAfterSeconds * 1_000)
      : Number.isFinite(retryAfterDate) ? Math.max(0, retryAfterDate - Date.now()) : null;
    const errors = [];
    const rawStatus = String(payload?.status || "").trim().toLowerCase();

    if (!response.ok) {
      errors.push(
        buildProviderError({
          provider: "twelve",
          scope: "batch",
          code: "twelve-upstream-status",
          message: `Twelve Data returned HTTP ${response.status}.`,
          status: response.status,
          tickers: requestedTickers,
          requestUrl: requestUrl.toString(),
          responsePreview: text
        })
      );
    }

    if (rawStatus === "error" || (!Array.isArray(payload?.data) && payload?.message && payload?.code)) {
      errors.push(
        buildProviderError({
          provider: "twelve",
          scope: "batch",
          code: typeof payload?.code === "string" ? String(payload.code).trim().toLowerCase() : "twelve-logical-error",
          message: payload?.message || "Twelve Data returned a logical error payload.",
          status: response.status,
          tickers: requestedTickers,
          requestUrl: requestUrl.toString(),
          responsePreview: text
        })
      );
    }

    const quotes = {};
    for (const item of normalizeCollection(payload)) {
      const parsed = parseTwelveQuote(item, timestamp, marketSession, durationMs, null);
      if (!parsed) {
        continue;
      }
      const symbol = String(item?.symbol || item?.ticker || item?.instrument?.symbol || "").trim().toUpperCase();
      const instrument = getInstrumentByProviderSymbol("twelve", symbol);
      if (symbol && instrument && requestedTickers.includes(symbol) && !quotes[symbol]) {
        quotes[symbol] = decorateCanonicalQuote(parsed, instrument, {
          providerId: "twelve", providerSymbol: symbol, fetchedAt: timestamp, session: marketSession?.state || null
        });
      }
    }

    const missingTickers = requestedTickers.filter((ticker) => !quotes[ticker]);
    if (!Object.keys(quotes).length && !errors.length) {
      errors.push(
        buildProviderError({
          provider: "twelve",
          scope: "batch",
          code: "twelve-symbol-unmapped",
          message: "Twelve Data did not return usable quotes for the requested tickers.",
          tickers: requestedTickers,
          requestUrl: requestUrl.toString(),
          responsePreview: text
        })
      );
    }

    const callStatus =
      !response.ok || errors.length
        ? "error"
        : Object.keys(quotes).length
          ? missingTickers.length
            ? "success"
            : "success"
          : "empty";
    const quotaSnapshot = apiQuotaTracker.recordCall("twelve", {
      status: callStatus,
      fallback: missingTickers.length > 0,
      headers: response.headers,
      timestamp,
      units: requestUnits
    });
    const score = computeProviderScore({
      returnedCount: Object.keys(quotes).length,
      totalTickers: requestedTickers.length,
      durationMs,
      errorCount: errors.length,
      marketOpen: Boolean(marketSession?.open),
      transport: "api"
    });

    for (const quote of Object.values(quotes)) {
      quote.providerLatencyMs = durationMs;
      quote.providerScore = score;
    }

    return summarizeAttempt({
      provider: "twelve",
      transport: "api",
      configuredBaseUrl,
      requestMode: "live-batch",
      durationMs,
      requestUrls: [requestUrl.toString()],
      requestedTickers,
      returnedTickers: Object.keys(quotes),
      missingTickers,
      estimatedUnits: requestUnits,
      httpStatus: response.status,
      lastAttemptAt: timestamp,
      lastSuccessAt: Object.keys(quotes).length ? timestamp : null,
      quotaSnapshot,
      score,
      errors,
      responsePreview: text,
      quotes,
      extras: { retryAfterMs }
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const quotaSnapshot = apiQuotaTracker.recordCall("twelve", {
      status: "error",
      fallback: true,
      timestamp,
      units: requestUnits
    });
    const requestError = buildProviderError({
      provider: "twelve",
      scope: "batch",
      code: error?.name === "AbortError" ? "twelve-timeout" : "twelve-request-failed",
      message:
        error?.name === "AbortError"
          ? "Twelve Data batch request timed out."
          : error?.message || "Twelve Data batch request failed.",
      tickers: requestedTickers,
      requestUrl: requestUrl.toString()
    });
    const score = computeProviderScore({
      returnedCount: 0,
      totalTickers: requestedTickers.length,
      durationMs,
      errorCount: 1,
      marketOpen: Boolean(marketSession?.open),
      transport: "api"
    });

    return summarizeAttempt({
      provider: "twelve",
      transport: "api",
      configuredBaseUrl,
      requestMode: "live-batch",
      durationMs,
      requestUrls: [requestUrl.toString()],
      requestedTickers,
      returnedTickers: [],
      missingTickers: requestedTickers,
      estimatedUnits: requestUnits,
      httpStatus: null,
      lastAttemptAt: timestamp,
      lastSuccessAt: null,
      quotaSnapshot,
      score,
      errors: [requestError],
      responsePreview: null,
      quotes: {}
    });
  }
}

function buildTwelveDailyUrl({ baseUrl = DEFAULT_TWELVE_BASE_URL, symbols = [], apiKey = "", outputsize = 5, adjustmentMode = "splits", interval = "1day" } = {}) {
  const url = new URL("time_series", ensureTrailingSlash(baseUrl));
  url.searchParams.set("symbol", symbols.join(",")); url.searchParams.set("interval", interval); url.searchParams.set("outputsize", String(outputsize)); url.searchParams.set("adjust", adjustmentMode); url.searchParams.set("format", "JSON");
  if (apiKey) url.searchParams.set("apikey", apiKey);
  return url;
}

function extractDailySeries(payload, requestedSymbols = []) {
  if (payload?.meta && Array.isArray(payload?.values)) return [{ symbol: payload.meta.symbol || requestedSymbols[0], meta: payload.meta, values: payload.values }];
  return requestedSymbols.map((symbol) => { const item = payload?.[symbol] || payload?.data?.[symbol]; return item?.meta && Array.isArray(item?.values) ? { symbol, meta: item.meta, values: item.values } : null; }).filter(Boolean);
}

export async function fetchTwelveDailyCandles({ baseUrl = DEFAULT_TWELVE_BASE_URL, apiKey = "", symbols = [], outputsize = 5, adjustmentMode = "splits", interval = "1day", timeoutMs = 10_000, timestamp = new Date().toISOString() } = {}) {
  const requestedSymbols = normalizeRequestedTickers(symbols); const configuredBaseUrl = baseUrl || DEFAULT_TWELVE_BASE_URL;
  if (!requestedSymbols.length) return { provider: "twelve", candlesBySymbol: {}, errors: [], requestedSymbols, returnedSymbols: [], quotaSnapshot: apiQuotaTracker.getProviderSnapshot("twelve"), requestUrls: [] };
  if (!apiKey) return { provider: "twelve", candlesBySymbol: {}, errors: [buildProviderError({ provider: "twelve", scope: "provider", code: "api-key-missing", message: "Twelve Data API key is missing.", tickers: requestedSymbols })], requestedSymbols, returnedSymbols: [], quotaSnapshot: apiQuotaTracker.getProviderSnapshot("twelve"), requestUrls: [] };
  const requestUrl = buildTwelveDailyUrl({ baseUrl: configuredBaseUrl, symbols: requestedSymbols, apiKey, outputsize: Math.min(5000, Math.max(1, Number(outputsize) || 5)), adjustmentMode, interval }); const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(requestUrl, { retries: 0, headers: { Accept: "application/json" } }, timeoutMs); const text = await response.text(); const payload = text ? JSON.parse(text) : {}; const errors = [];
    if (!response.ok || payload?.status === "error") errors.push(buildProviderError({ provider: "twelve", scope: "batch", code: response.status === 429 ? "rate-limited" : "twelve-time-series-error", message: payload?.message || `Twelve Data returned HTTP ${response.status}.`, status: response.status, tickers: requestedSymbols, requestUrl: requestUrl.toString(), responsePreview: text }));
    const candlesBySymbol = Object.fromEntries(extractDailySeries(payload, requestedSymbols).map((series) => [String(series.symbol).toUpperCase(), { meta: series.meta, values: series.values }]));
    const quotaSnapshot = apiQuotaTracker.recordCall("twelve", { status: errors.length ? "error" : "success", fallback: Object.keys(candlesBySymbol).length < requestedSymbols.length, headers: response.headers, timestamp, units: requestedSymbols.length });
    const retryAfter = response.headers.get("retry-after"); const retryAfterMs = retryAfter == null ? null : Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    return { provider: "twelve", candlesBySymbol, errors, requestedSymbols, returnedSymbols: Object.keys(candlesBySymbol), missingSymbols: requestedSymbols.filter((symbol) => !candlesBySymbol[symbol]), quotaSnapshot, retryAfterMs, httpStatus: response.status, durationMs: Date.now() - startedAt, requestUrls: [requestUrl.toString()] };
  } catch (error) {
    return { provider: "twelve", candlesBySymbol: {}, errors: [buildProviderError({ provider: "twelve", scope: "batch", code: error?.name === "AbortError" ? "twelve-timeout" : "twelve-time-series-failed", message: error?.message || "Twelve Data time series request failed.", tickers: requestedSymbols, requestUrl: requestUrl.toString() })], requestedSymbols, returnedSymbols: [], missingSymbols: requestedSymbols, quotaSnapshot: apiQuotaTracker.recordCall("twelve", { status: "error", fallback: true, timestamp, units: requestedSymbols.length }), httpStatus: null, durationMs: Date.now() - startedAt, requestUrls: [requestUrl.toString()] };
  }
}
