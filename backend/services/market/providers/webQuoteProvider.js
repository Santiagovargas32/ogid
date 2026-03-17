import apiQuotaTracker from "../../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../../utils/logger.js";
import { buildProviderDiagnosticRecord } from "../providerDiagnostics.js";
import { isMarketOpenEt } from "../marketSessionService.js";

const log = createLogger("backend/services/market/providers/webQuoteProvider");
const SUPPORTED_WEB_SOURCES = new Set(["yahoo", "twelve", "stooq"]);
const DEFAULT_WEB_SOURCE = "yahoo";
const DEFAULT_WEB_BASE_URL = "https://query1.finance.yahoo.com";
const DEFAULT_TWELVE_BASE_URL = "https://api.twelvedata.com";
const DEFAULT_STOOQ_BASE_URL = "https://stooq.com";
const DEFAULT_WEB_USER_AGENT = "ogid/1.0";

function parsePrice(value) {
  const parsed = Number.parseFloat(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function parsePercent(value) {
  const parsed = Number.parseFloat(
    String(value ?? "")
      .replaceAll("%", "")
      .replaceAll("(", "")
      .replaceAll(")", "")
      .replaceAll("+", "")
      .trim()
  );
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").replaceAll(",", "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function ensureTrailingSlash(baseUrl = DEFAULT_WEB_BASE_URL) {
  return String(baseUrl).endsWith("/") ? String(baseUrl) : `${String(baseUrl)}/`;
}

function parseCsvLine(line = "") {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (character === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  values.push(current);
  return values.map((value) => String(value || "").trim());
}

function parseCsvTable(text = "") {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseCsvLine(line));
}

function normalizeRequestedTickers(tickers = []) {
  return [...new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || "").toUpperCase()).filter(Boolean))];
}

function normalizeSourceTicker(ticker = "", source = DEFAULT_WEB_SOURCE) {
  const normalizedTicker = String(ticker || "").trim().toUpperCase();
  if (!normalizedTicker) {
    return "";
  }

  if (String(source || "").toLowerCase() !== "stooq") {
    return normalizedTicker;
  }

  const lowerTicker = normalizedTicker.toLowerCase();
  if (lowerTicker.endsWith(".us")) {
    return lowerTicker;
  }

  return `${lowerTicker.replaceAll(".", "-")}.us`;
}

function buildYahooBatchQuoteUrl({ baseUrl = DEFAULT_WEB_BASE_URL, symbols = [] } = {}) {
  const url = new URL("v7/finance/quote", ensureTrailingSlash(baseUrl));
  url.searchParams.set("symbols", symbols.join(","));
  return url;
}

function buildTwelveBatchQuoteUrl({ baseUrl = DEFAULT_TWELVE_BASE_URL, symbols = [], apiKey = "" } = {}) {
  const url = new URL("quote", ensureTrailingSlash(baseUrl));
  url.searchParams.set("symbol", symbols.join(","));
  url.searchParams.set("format", "JSON");
  url.searchParams.set("prepost", "true");
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
  }
  return url;
}

export function buildWebBatchQuoteUrl({ source = DEFAULT_WEB_SOURCE, baseUrl = DEFAULT_WEB_BASE_URL, symbols = [], apiKey = "" } = {}) {
  const normalizedSource = String(source || "").toLowerCase();

  if (normalizedSource === "yahoo") {
    return buildYahooBatchQuoteUrl({ baseUrl, symbols });
  }

  if (normalizedSource === "twelve") {
    return buildTwelveBatchQuoteUrl({ baseUrl, symbols, apiKey });
  }

  if (normalizedSource === "stooq") {
    const url = new URL("q/l/", ensureTrailingSlash(baseUrl || DEFAULT_STOOQ_BASE_URL));
    url.searchParams.set("s", symbols.join(","));
    url.searchParams.set("f", "sd2t2ohlcvn");
    url.searchParams.set("e", "csv");
    return url;
  }

  throw new Error(`Unsupported market web source: ${source}`);
}

export function buildWebHistoricalUrl({ source = DEFAULT_WEB_SOURCE, baseUrl = DEFAULT_STOOQ_BASE_URL, symbol = "" } = {}) {
  if (String(source || "").toLowerCase() !== "stooq") {
    throw new Error(`Unsupported market web historical source: ${source}`);
  }

  const url = new URL("q/d/l/", ensureTrailingSlash(baseUrl || DEFAULT_STOOQ_BASE_URL));
  url.searchParams.set("s", symbol);
  url.searchParams.set("i", "d");
  return url;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (Array.isArray(payload.quoteResponse?.result)) {
    return payload.quoteResponse.result;
  }
  if (Array.isArray(payload.result)) {
    return payload.result;
  }
  if (Array.isArray(payload.data)) {
    return payload.data;
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

function toIsoTimestamp(value, fallbackTimestamp) {
  if (value === undefined || value === null || value === "") {
    return fallbackTimestamp;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const numeric = value > 1e12 ? value : value * 1000;
    return new Date(numeric).toISOString();
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallbackTimestamp;
}

function computeChangePct(price, previousClose, fallbackChangePct = null) {
  if (Number.isFinite(fallbackChangePct)) {
    return Number(fallbackChangePct.toFixed(2));
  }

  if (Number.isFinite(previousClose) && previousClose > 0 && Number.isFinite(price)) {
    return Number((((price - previousClose) / previousClose) * 100).toFixed(2));
  }

  return 0;
}

function computeSourceScore({ returnedCount = 0, totalTickers = 0, durationMs = 0, errorCount = 0, marketOpen = true, source = "yahoo", dataMode = "live" } = {}) {
  const coverage = totalTickers > 0 ? returnedCount / totalTickers : 0;
  const freshnessBonus = dataMode === "live" ? 18 : dataMode === "web-delayed" ? 8 : 0;
  const sourceBonus = source === "yahoo" ? 10 : source === "twelve" ? 8 : 4;
  const marketBonus = marketOpen ? 5 : 0;
  const latencyPenalty = Number.isFinite(durationMs) ? Math.min(28, durationMs / 180) : 10;
  const errorPenalty = errorCount * 7;
  return Math.max(0, Math.round(coverage * 60 + freshnessBonus + sourceBonus + marketBonus - latencyPenalty - errorPenalty));
}

function buildProviderError({ scope, code, message, tickers = [], ticker = null, status = null, requestUrl = null, responsePreview = null }) {
  return {
    provider: "web",
    scope,
    code,
    reason: code,
    message,
    status,
    tickers: tickers.length ? tickers : undefined,
    ticker: ticker || undefined,
    requestUrl,
    responsePreview
  };
}

function buildSourceInvalidResult(tickers = [], timestamp = new Date().toISOString(), options = {}) {
  const error = buildProviderError({
    scope: "provider",
    code: "web-source-invalid",
    message: "The configured market web source is not supported.",
    tickers
  });

  return {
    provider: "web",
    quotes: {},
    missingTickers: tickers,
    historicalSeries: {},
    sourceMode: "fallback",
    sourceMeta: {
      provider: "web",
      reason: "web-source-invalid",
      requestMode: "unavailable",
      liveCount: 0,
      totalTickers: tickers.length,
      errors: [error],
      providerDiagnostics: {
        web: buildProviderDiagnosticRecord({
          provider: "web",
          configuredProvider: options.configuredProvider || "web",
          configuredFallbackProvider: options.configuredFallbackProvider || null,
          effectiveProvider: null,
          configuredSource: options.source || DEFAULT_WEB_SOURCE,
          requestMode: "unavailable",
          lastAttemptAt: timestamp,
          requestedTickers: tickers,
          returnedTickers: [],
          missingTickers: tickers,
          errorCode: "web-source-invalid",
          errorMessage: "The configured market web source is not supported."
        })
      }
    },
    updatedAt: timestamp
  };
}

function buildSymbolUnmappedResult(tickers = [], timestamp = new Date().toISOString(), options = {}) {
  const error = buildProviderError({
    scope: "provider",
    code: "web-symbol-unmapped",
    message: "No valid symbols were produced for the configured web source.",
    tickers
  });

  return {
    provider: "web",
    quotes: {},
    missingTickers: tickers,
    historicalSeries: {},
    sourceMode: "fallback",
    sourceMeta: {
      provider: "web",
      reason: "web-symbol-unmapped",
      requestMode: "unavailable",
      liveCount: 0,
      totalTickers: tickers.length,
      errors: [error],
      providerDiagnostics: {
        web: buildProviderDiagnosticRecord({
          provider: "web",
          configuredProvider: options.configuredProvider || "web",
          configuredFallbackProvider: options.configuredFallbackProvider || null,
          effectiveProvider: null,
          configuredSource: options.source || DEFAULT_WEB_SOURCE,
          requestMode: "unavailable",
          lastAttemptAt: timestamp,
          requestedTickers: tickers,
          returnedTickers: [],
          missingTickers: tickers,
          errorCode: "web-symbol-unmapped",
          errorMessage: "No valid symbols were produced for the configured web source."
        })
      }
    },
    updatedAt: timestamp
  };
}

function parseYahooQuote(item = {}, timestamp = new Date().toISOString(), marketSession = {}, providerLatencyMs = null, providerScore = null) {
  const symbol = String(item?.symbol || item?.ticker || "").trim().toUpperCase();
  const price =
    parsePrice(item?.regularMarketPrice) ??
    parsePrice(item?.postMarketPrice) ??
    parsePrice(item?.preMarketPrice) ??
    parsePrice(item?.price);

  if (!symbol || !Number.isFinite(price)) {
    return null;
  }

  const previousClose =
    parsePrice(item?.regularMarketPreviousClose) ??
    parsePrice(item?.postMarketPreviousClose) ??
    parsePrice(item?.preMarketPreviousClose) ??
    parsePrice(item?.previousClose);
  const fallbackChangePct =
    parsePercent(item?.regularMarketChangePercent) ??
    parsePercent(item?.postMarketChangePercent) ??
    parsePercent(item?.preMarketChangePercent) ??
    parsePercent(item?.changePercent);
  const changePct = computeChangePct(price, previousClose, fallbackChangePct);
  const marketState = String(item?.marketState || (marketSession?.open ? "REGULAR" : "CLOSED")).toUpperCase();

  return {
    price,
    changePct,
    high: parsePrice(item?.regularMarketDayHigh) ?? parsePrice(item?.dayHigh) ?? parsePrice(item?.high),
    low: parsePrice(item?.regularMarketDayLow) ?? parsePrice(item?.dayLow) ?? parsePrice(item?.low),
    volume: parseInteger(item?.regularMarketVolume) ?? parseInteger(item?.volume),
    previousClose,
    marketState,
    asOf: toIsoTimestamp(item?.regularMarketTime ?? item?.regularMarketTimestamp ?? item?.postMarketTime ?? item?.preMarketTime, timestamp),
    source: "web",
    sourceDetail: "yahoo",
    synthetic: false,
    dataMode: "live",
    providerLatencyMs,
    providerScore
  };
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
  const marketState = String(item?.market_state || item?.marketState || (marketSession?.open ? "REGULAR" : "CLOSED")).toUpperCase();

  return {
    price,
    changePct,
    high: parsePrice(item?.high) ?? parsePrice(item?.day_high) ?? null,
    low: parsePrice(item?.low) ?? parsePrice(item?.day_low) ?? null,
    volume: parseInteger(item?.volume) ?? parseInteger(item?.turnover) ?? null,
    previousClose,
    marketState,
    asOf: toIsoTimestamp(item?.datetime ?? item?.timestamp ?? item?.date ?? item?.time, timestamp),
    source: "web",
    sourceDetail: "twelve",
    synthetic: false,
    dataMode: "live",
    providerLatencyMs,
    providerScore
  };
}

function parseStooqQuote(row = [], ticker = "", timestamp = new Date().toISOString(), marketSession = {}, providerLatencyMs = null, providerScore = null) {
  const [, date, time, open, high, low, close, volume] = row;
  const price = parsePrice(close);
  if (!ticker || !Number.isFinite(price)) {
    return null;
  }

  const openPrice = parsePrice(open);
  const changePct = Number.isFinite(openPrice) && openPrice > 0 ? Number((((price - openPrice) / openPrice) * 100).toFixed(2)) : 0;
  const asOf = date && time ? toIsoTimestamp(`${date}T${time}.000Z`, timestamp) : toIsoTimestamp(date || time, timestamp);

  return {
    price,
    changePct,
    high: parsePrice(high),
    low: parsePrice(low),
    volume: parseInteger(volume),
    previousClose: null,
    marketState: marketSession?.open ? "REGULAR" : "CLOSED",
    asOf,
    source: "web",
    sourceDetail: "stooq",
    synthetic: false,
    dataMode: "web-delayed",
    providerLatencyMs,
    providerScore
  };
}

function parseYahooBatchResponse(text, requestedTickers, timestamp, marketSession, providerLatencyMs) {
  const payload = JSON.parse(text);
  const rows = normalizeCollection(payload);
  const quotes = {};

  for (const item of rows) {
    const parsed = parseYahooQuote(item, timestamp, marketSession, providerLatencyMs, null);
    if (!parsed) {
      continue;
    }
    const symbol = String(item?.symbol || item?.ticker || "").trim().toUpperCase();
    if (symbol && !quotes[symbol]) {
      quotes[symbol] = parsed;
    }
  }

  return quotes;
}

function parseTwelveBatchResponse(text, requestedTickers, timestamp, marketSession, providerLatencyMs) {
  const payload = JSON.parse(text);
  const rows = normalizeCollection(payload);
  const quotes = {};

  for (const item of rows) {
    const parsed = parseTwelveQuote(item, timestamp, marketSession, providerLatencyMs, null);
    if (!parsed) {
      continue;
    }
    const symbol = String(item?.symbol || item?.ticker || "").trim().toUpperCase();
    if (symbol && !quotes[symbol]) {
      quotes[symbol] = parsed;
    }
  }

  return quotes;
}

function parseStooqBatchResponse(text, requestedTickers, timestamp, marketSession, providerLatencyMs) {
  const table = parseCsvTable(text);
  const tickerBySymbol = new Map(
    requestedTickers.map((ticker) => [normalizeSourceTicker(ticker, "stooq"), ticker])
  );
  const quotes = {};

  for (const row of table.slice(1)) {
    const symbol = String(row?.[0] || "").trim().toLowerCase();
    const ticker = tickerBySymbol.get(symbol);
    if (!ticker) {
      continue;
    }

    const parsed = parseStooqQuote(row, ticker, timestamp, marketSession, providerLatencyMs, null);
    if (!parsed) {
      continue;
    }
    quotes[ticker] = parsed;
  }

  const error =
    table.length <= 1
      ? buildProviderError({
          scope: "batch",
          tickers: requestedTickers,
          code: "web-csv-empty",
          message: "Market web batch CSV returned no quote rows.",
          responsePreview: text
        })
      : Object.keys(quotes).length > 0
        ? null
        : buildProviderError({
            scope: "batch",
            tickers: requestedTickers,
            code: "web-symbol-unmapped",
            message: "Market web batch CSV did not contain usable symbols for the requested tickers.",
            responsePreview: text
          });

  return { quotes, error };
}

function resolveWebSourceOrder(source = DEFAULT_WEB_SOURCE) {
  const normalized = String(source || "").toLowerCase();
  if (!SUPPORTED_WEB_SOURCES.has(normalized)) {
    return [];
  }

  if (normalized === "yahoo") {
    return ["yahoo", "twelve", "stooq"];
  }
  if (normalized === "twelve") {
    return ["twelve", "yahoo", "stooq"];
  }
  return ["stooq", "yahoo", "twelve"];
}

function resolveWebBaseUrl(source, primarySource, config = {}) {
  const normalizedSource = String(source || "").toLowerCase();
  const normalizedPrimary = String(primarySource || DEFAULT_WEB_SOURCE).toLowerCase();

  if (normalizedSource === "yahoo") {
    return config.yahooBaseUrl || (normalizedSource === normalizedPrimary && config.baseUrl ? config.baseUrl : DEFAULT_WEB_BASE_URL);
  }
  if (normalizedSource === "twelve") {
    return config.twelveBaseUrl || DEFAULT_TWELVE_BASE_URL;
  }
  if (normalizedSource === "stooq") {
    return config.stooqBaseUrl || DEFAULT_STOOQ_BASE_URL;
  }
  if (normalizedSource === normalizedPrimary && config.baseUrl) {
    return config.baseUrl;
  }
  return config.baseUrl || DEFAULT_WEB_BASE_URL;
}

async function requestWebSourceQuotes({
  source,
  baseUrl,
  apiKey = "",
  tickers = [],
  timeoutMs = 9_000,
  timestamp = new Date().toISOString(),
  userAgent = DEFAULT_WEB_USER_AGENT,
  marketSession = { open: false }
}) {
  const normalizedSource = String(source || "").toLowerCase();
  const requestedTickers = normalizeRequestedTickers(tickers);
  const symbols = requestedTickers.map((ticker) => normalizeSourceTicker(ticker, normalizedSource)).filter(Boolean);
  const startedAt = Date.now();
  const requestUrls = [];

  if (!SUPPORTED_WEB_SOURCES.has(normalizedSource)) {
    return {
      source: normalizedSource,
      quotes: {},
      missingTickers: requestedTickers,
      requestUrls,
      errors: [
        buildProviderError({
          scope: "provider",
          tickers: requestedTickers,
          code: "web-source-invalid",
          message: "The configured market web source is not supported."
        })
      ],
      requestMode: "unavailable",
      providerScore: 0,
      durationMs: 0,
      httpStatus: null,
      responsePreview: null,
      effectiveSource: null,
      returnedTickers: [],
      lastSuccessAt: null,
      lastAttemptAt: timestamp
    };
  }

  if (!symbols.length) {
    return {
      source: normalizedSource,
      quotes: {},
      missingTickers: requestedTickers,
      requestUrls,
      errors: [
        buildProviderError({
          scope: "provider",
          tickers: requestedTickers,
          code: "web-symbol-unmapped",
          message: "No valid symbols were produced for the configured web source."
        })
      ],
      requestMode: "unavailable",
      providerScore: 0,
      durationMs: 0,
      httpStatus: null,
      responsePreview: null,
      effectiveSource: null,
      returnedTickers: [],
      lastSuccessAt: null,
      lastAttemptAt: timestamp
    };
  }

  if (normalizedSource === "twelve" && !apiKey) {
    return {
      source: normalizedSource,
      quotes: {},
      missingTickers: requestedTickers,
      requestUrls,
      errors: [
        buildProviderError({
          scope: "provider",
          tickers: requestedTickers,
          code: "api-key-missing",
          message: "Twelve Data API key is missing."
        })
      ],
      requestMode: "unavailable",
      providerScore: 0,
      durationMs: 0,
      httpStatus: null,
      responsePreview: null,
      effectiveSource: null,
      returnedTickers: [],
      lastSuccessAt: null,
      lastAttemptAt: timestamp
    };
  }

  const requestUrl = buildWebBatchQuoteUrl({
    source: normalizedSource,
    baseUrl,
    symbols,
    apiKey
  });
  requestUrls.push(requestUrl.toString());

  try {
    const response = await fetchWithTimeout(
      requestUrl,
      {
        headers: {
          "User-Agent": userAgent || DEFAULT_WEB_USER_AGENT,
          Accept: normalizedSource === "stooq" ? "text/csv" : "application/json"
        }
      },
      timeoutMs
    );
    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    let quotes = {};
    let parseError = null;

    try {
      quotes =
        normalizedSource === "yahoo"
          ? parseYahooBatchResponse(text, requestedTickers, timestamp, marketSession, durationMs)
          : normalizedSource === "twelve"
            ? parseTwelveBatchResponse(text, requestedTickers, timestamp, marketSession, durationMs)
            : parseStooqBatchResponse(text, requestedTickers, timestamp, marketSession, durationMs).quotes;
    } catch (error) {
      parseError =
        error.providerError ||
        buildProviderError({
          scope: "batch",
          tickers: requestedTickers,
          code: "web-parse-failed",
          message: `${normalizedSource} batch payload could not be parsed.`,
          requestUrl: requestUrl.toString(),
          responsePreview: text
        });
    }

    if (!response.ok) {
      const providerError = buildProviderError({
        scope: "batch",
        tickers: requestedTickers,
        code: "web-upstream-status",
        message: `Market web source returned HTTP ${response.status}.`,
        status: response.status,
        requestUrl: requestUrl.toString(),
        responsePreview: text
      });
      return {
        source: normalizedSource,
        quotes,
        missingTickers: requestedTickers.filter((ticker) => !quotes[ticker]),
        requestUrls,
        errors: [parseError, providerError].filter(Boolean),
        requestMode: normalizedSource === "stooq" ? "web-delayed" : "live-batch",
        providerScore: computeSourceScore({
          returnedCount: Object.keys(quotes).length,
          totalTickers: requestedTickers.length,
          durationMs,
          errorCount: 1,
          marketOpen: Boolean(marketSession?.open),
          source: normalizedSource,
          dataMode: normalizedSource === "stooq" ? "web-delayed" : "live"
        }),
        durationMs,
        httpStatus: response.status,
        responsePreview: text,
        effectiveSource: Object.keys(quotes).length ? normalizedSource : null,
        returnedTickers: Object.keys(quotes),
        lastSuccessAt: Object.keys(quotes).length ? new Date().toISOString() : null,
        lastAttemptAt: timestamp
      };
    }

    if (!Object.keys(quotes).length) {
      const emptyError =
        parseError ||
        (normalizedSource === "stooq"
          ? parseStooqBatchResponse(text, requestedTickers, timestamp, marketSession, durationMs).error
          : buildProviderError({
              scope: "batch",
              tickers: requestedTickers,
              code: "web-symbol-unmapped",
              message: "Market web source did not contain usable symbols for the requested tickers.",
            requestUrl: requestUrl.toString(),
            responsePreview: text
          }));
      return {
        source: normalizedSource,
        quotes: {},
        missingTickers: requestedTickers,
        requestUrls,
        errors: [emptyError].filter(Boolean),
        requestMode: normalizedSource === "stooq" ? "web-delayed" : "live-batch",
        providerScore: computeSourceScore({
          returnedCount: 0,
          totalTickers: requestedTickers.length,
          durationMs,
          errorCount: 1,
          marketOpen: Boolean(marketSession?.open),
          source: normalizedSource,
          dataMode: normalizedSource === "stooq" ? "web-delayed" : "live"
        }),
        durationMs,
        httpStatus: response.status,
        responsePreview: text,
        effectiveSource: null,
        returnedTickers: [],
        lastSuccessAt: null,
        lastAttemptAt: timestamp
      };
    }

    const missingTickers = requestedTickers.filter((ticker) => !quotes[ticker]);
    const providerScore = computeSourceScore({
      returnedCount: Object.keys(quotes).length,
      totalTickers: requestedTickers.length,
      durationMs,
      errorCount: 0,
      marketOpen: Boolean(marketSession?.open),
      source: normalizedSource,
      dataMode: normalizedSource === "stooq" ? "web-delayed" : "live"
    });

    for (const [ticker, quote] of Object.entries(quotes)) {
      quotes[ticker] = {
        ...quote,
        providerLatencyMs: durationMs,
        providerScore
      };
    }

    return {
      source: normalizedSource,
      quotes,
      missingTickers,
      requestUrls,
      errors: [parseError].filter(Boolean),
      requestMode: normalizedSource === "stooq" ? "web-delayed" : "live-batch",
      providerScore,
      durationMs,
      httpStatus: response.status,
      responsePreview: text,
      effectiveSource: normalizedSource,
      returnedTickers: Object.keys(quotes),
      lastSuccessAt: new Date().toISOString(),
      lastAttemptAt: timestamp
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    return {
      source: normalizedSource,
      quotes: {},
      missingTickers: requestedTickers,
      requestUrls,
      errors: [
        error.providerError ||
          buildProviderError({
            scope: "batch",
            tickers: requestedTickers,
            code: error?.name === "AbortError" ? "web-timeout" : "request-failed",
            message:
              error?.name === "AbortError"
                ? "Market web batch request timed out."
                : error?.message || "Market web batch request failed.",
            requestUrl: requestUrl.toString()
          })
      ],
      requestMode: normalizedSource === "stooq" ? "web-delayed" : "live-batch",
      providerScore: computeSourceScore({
        returnedCount: 0,
        totalTickers: requestedTickers.length,
        durationMs,
        errorCount: 1,
        marketOpen: Boolean(marketSession?.open),
        source: normalizedSource,
        dataMode: normalizedSource === "stooq" ? "web-delayed" : "live"
      }),
      durationMs,
      httpStatus: null,
      responsePreview: null,
      effectiveSource: null,
      returnedTickers: [],
      lastSuccessAt: null,
      lastAttemptAt: timestamp
    };
  }
}

export async function fetchWebQuotes({
  source = DEFAULT_WEB_SOURCE,
  baseUrl = DEFAULT_WEB_BASE_URL,
  tickers = [],
  timeoutMs = 9_000,
  timestamp = new Date().toISOString(),
  userAgent = DEFAULT_WEB_USER_AGENT,
  configuredProvider = "web",
  configuredFallbackProvider = null,
  yahooBaseUrl = DEFAULT_WEB_BASE_URL,
  stooqBaseUrl = DEFAULT_STOOQ_BASE_URL,
  twelveApiKey = "",
  twelveBaseUrl = DEFAULT_TWELVE_BASE_URL,
  session = null
}) {
  const requestedTickers = normalizeRequestedTickers(tickers);
  const primarySource = String(source || DEFAULT_WEB_SOURCE).toLowerCase();

  if (!SUPPORTED_WEB_SOURCES.has(primarySource)) {
    return buildSourceInvalidResult(requestedTickers, timestamp, {
      configuredProvider,
      configuredFallbackProvider,
      source: primarySource
    });
  }

  if (!requestedTickers.length) {
    return buildSymbolUnmappedResult(requestedTickers, timestamp, {
      configuredProvider,
      configuredFallbackProvider,
      source: primarySource
    });
  }

  const marketSession =
    session || {
      open: isMarketOpenEt(new Date(timestamp)),
      state: isMarketOpenEt(new Date(timestamp)) ? "open" : "closed",
      checkedAt: timestamp
    };
  const sourceOrder = resolveWebSourceOrder(primarySource);
  const sourceAttempts = [];
  const quotes = {};
  const errors = [];
  const requestUrls = [];
  let lastSuccessAt = null;
  const startedAt = Date.now();
  let unresolved = [...requestedTickers];

  for (const currentSource of sourceOrder) {
    if (!unresolved.length) {
      break;
    }

    const attempt = await requestWebSourceQuotes({
      source: currentSource,
      baseUrl: resolveWebBaseUrl(currentSource, primarySource, {
        baseUrl,
        yahooBaseUrl,
        stooqBaseUrl,
        twelveBaseUrl
      }),
      apiKey: currentSource === "twelve" ? twelveApiKey : "",
      tickers: unresolved,
      timeoutMs,
      timestamp,
      userAgent,
      marketSession
    });

    sourceAttempts.push(attempt);
    requestUrls.push(...(attempt.requestUrls || []));
    errors.push(...(attempt.errors || []));

    for (const [ticker, quote] of Object.entries(attempt.quotes || {})) {
      quotes[ticker] = quote;
    }

    unresolved = unresolved.filter((ticker) => !attempt.quotes?.[ticker]);
    if (Object.keys(attempt.quotes || {}).length > 0) {
      lastSuccessAt = attempt.lastSuccessAt || new Date().toISOString();
    }
  }

  const durationMs = Date.now() - startedAt;
  const liveCount = Object.values(quotes).filter((quote) => quote?.dataMode === "live").length;
  const delayedCount = Object.values(quotes).filter((quote) => quote?.dataMode === "web-delayed").length;
  const requestMode = [...new Set(sourceAttempts.map((attempt) => attempt.requestMode).filter(Boolean))].join("+") || "unavailable";
  const providerScores = Object.fromEntries(sourceAttempts.map((attempt) => [attempt.source, attempt.providerScore ?? 0]));
  const effectiveSource =
    sourceAttempts
      .filter((attempt) => Object.keys(attempt.quotes || {}).length > 0)
      .sort((left, right) => {
        if ((right.providerScore ?? 0) !== (left.providerScore ?? 0)) {
          return (right.providerScore ?? 0) - (left.providerScore ?? 0);
        }
        if ((left.durationMs ?? 0) !== (right.durationMs ?? 0)) {
          return (left.durationMs ?? 0) - (right.durationMs ?? 0);
        }
        return (left.errors?.length ?? 0) - (right.errors?.length ?? 0);
      })[0]?.source || null;
  const providerScore = effectiveSource ? providerScores[effectiveSource] ?? 0 : 0;
  const providerErrors = errors.map((error) => ({
    ...error,
    code: error.code || error.reason || "unknown-error",
    reason: error.reason || error.code || "unknown-error"
  }));
  const fallbackCount = requestedTickers.filter((ticker) => !quotes[ticker]).length;
  const sourceMode = Object.keys(quotes).length <= 0 ? "fallback" : Object.keys(quotes).length >= requestedTickers.length ? "live" : "mixed";
  const latestAttempt = sourceAttempts.at(-1) || {};
  const latestSuccess = [...sourceAttempts].reverse().find((attempt) => Object.keys(attempt.quotes || {}).length > 0) || null;
  const requestUrlsUnique = [...new Set(requestUrls.filter(Boolean))];

  apiQuotaTracker.recordCall("web", {
    status: Object.keys(quotes).length > 0 ? "success" : "error",
    fallback: fallbackCount > 0,
    timestamp
  });

  const finalError = providerErrors.at(-1) || null;
  const providerDiagnostics = buildProviderDiagnosticRecord({
    provider: "web",
    configuredProvider,
    configuredFallbackProvider,
    effectiveProvider: Object.keys(quotes).length ? "web" : null,
    configuredSource: primarySource,
    requestMode,
    lastAttemptAt: latestAttempt.lastAttemptAt || timestamp,
    lastSuccessAt: latestSuccess?.lastSuccessAt || lastSuccessAt,
    durationMs,
    requestUrl: requestUrlsUnique[0] || null,
    requestUrls: requestUrlsUnique,
    requestedTickers,
    returnedTickers: Object.keys(quotes),
    missingTickers: requestedTickers.filter((ticker) => !quotes[ticker]),
    httpStatus: latestAttempt.httpStatus || null,
    responsePreview: latestAttempt.responsePreview || null,
    errorCode: finalError?.code || null,
    errorMessage: finalError?.message || null,
    extras: {
      marketSession,
      effectiveSource,
      providerScore,
      providerScores,
      liveCount,
      delayedCount,
      sourceOrder,
      sourceAttempts: sourceAttempts.map((attempt) => ({
        source: attempt.source,
        requestMode: attempt.requestMode,
        providerScore: attempt.providerScore,
        durationMs: attempt.durationMs,
        returnedTickers: attempt.returnedTickers,
        missingTickers: attempt.missingTickers,
        httpStatus: attempt.httpStatus,
        lastAttemptAt: attempt.lastAttemptAt,
        lastSuccessAt: attempt.lastSuccessAt,
        errors: (attempt.errors || []).map((error) => ({
          code: error.code || error.reason || "unknown-error",
          message: error.message || null,
          scope: error.scope || null
        }))
      }))
    }
  });

  log.info("market_provider_summary", {
    provider: "web",
    source: primarySource,
    effectiveSource,
    liveCount,
    delayedCount,
    fallbackCount,
    totalTickers: requestedTickers.length,
    durationMs,
    providerScore
  });

  return {
    provider: "web",
    quotes,
    missingTickers: requestedTickers.filter((ticker) => !quotes[ticker]),
    historicalSeries: {},
    sourceMode,
    sourceMeta: {
      provider: "web",
      requestMode,
      liveCount,
      delayedCount,
      totalTickers: requestedTickers.length,
      sourceOrder,
      effectiveSource,
      providerScore,
      providerScores,
      marketSession,
      requestUrls: requestUrlsUnique,
      errors: providerErrors,
      providerDiagnostics: {
        web: providerDiagnostics
      },
      lastUpstreamError: finalError?.code || finalError?.reason || null,
      requestedTickers,
      returnedTickers: Object.keys(quotes),
      missingTickers: requestedTickers.filter((ticker) => !quotes[ticker]),
      fallbackCount
    },
    updatedAt: timestamp
  };
}

export { DEFAULT_WEB_BASE_URL, DEFAULT_WEB_SOURCE, DEFAULT_WEB_USER_AGENT };
