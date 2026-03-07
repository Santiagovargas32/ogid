import apiQuotaTracker, { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("backend/services/market/providers/fmpProvider");
const DEFAULT_FMP_STABLE_BASE_URL = "https://financialmodelingprep.com/stable";
const ENTITLEMENT_STATUS_CODES = new Set([402]);

function ensureTrailingSlash(baseUrl) {
  return String(baseUrl).endsWith("/") ? String(baseUrl) : `${String(baseUrl)}/`;
}

export function toStableFmpBaseUrl(baseUrl = DEFAULT_FMP_STABLE_BASE_URL) {
  try {
    const url = new URL(String(baseUrl || DEFAULT_FMP_STABLE_BASE_URL));
    const normalizedPath = url.pathname.replace(/\/+$/, "");

    if (!normalizedPath || normalizedPath === "/") {
      url.pathname = "/stable";
      return url.toString();
    }

    if (normalizedPath.endsWith("/api/v3")) {
      url.pathname = normalizedPath.replace(/\/api\/v3$/, "/stable");
      return url.toString();
    }

    if (normalizedPath.endsWith("/stable")) {
      url.pathname = normalizedPath;
      return url.toString();
    }

    url.pathname = `${normalizedPath}/stable`;
    return url.toString();
  } catch {
    return DEFAULT_FMP_STABLE_BASE_URL;
  }
}

export function buildFmpBatchQuoteUrl({ baseUrl, tickers = [], apiKey }) {
  const url = new URL("batch-quote", ensureTrailingSlash(toStableFmpBaseUrl(baseUrl)));
  url.searchParams.set("symbols", tickers.join(","));
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
  }
  return url;
}

export function buildFmpHistoricalEodUrl({ baseUrl, ticker, apiKey }) {
  const url = new URL("historical-price-eod/full", ensureTrailingSlash(toStableFmpBaseUrl(baseUrl)));
  url.searchParams.set("symbol", String(ticker || "").toUpperCase());
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
  }
  return url;
}

function chunkTickers(tickers = [], chunkSize = 25) {
  const normalizedSize = Math.max(1, Number.parseInt(String(chunkSize ?? ""), 10) || 25);
  const chunks = [];

  for (let index = 0; index < tickers.length; index += normalizedSize) {
    chunks.push(tickers.slice(index, index + normalizedSize));
  }

  return chunks;
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

function normalizePayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.data)) {
      return payload.data;
    }
    if (Array.isArray(payload.historical)) {
      return payload.historical;
    }
    if (Array.isArray(payload.quotes)) {
      return payload.quotes;
    }
    return Object.values(payload).flatMap((value) => (Array.isArray(value) ? value : []));
  }
  return [];
}

function parsePercent(value) {
  const normalized = String(value ?? "")
    .replace("%", "")
    .replace("(", "")
    .replace(")", "")
    .replace("+", "")
    .trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePrice(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function parseBatchQuote(item) {
  const symbol = String(item?.symbol || item?.ticker || "").toUpperCase();
  const price =
    parsePrice(item?.price) ??
    parsePrice(item?.lastSalePrice) ??
    parsePrice(item?.close) ??
    parsePrice(item?.previousClose);
  const changePct =
    parsePercent(item?.changesPercentage) ??
    parsePercent(item?.changePercentage) ??
    parsePercent(item?.changePercent);

  if (!symbol || !Number.isFinite(price) || !Number.isFinite(changePct)) {
    return null;
  }

  return {
    symbol,
    price,
    changePct: Number(changePct.toFixed(2))
  };
}

function parseHistoricalPoint(item) {
  const timestamp = item?.date || item?.datetime || item?.timestamp || null;
  const price = parsePrice(item?.close) ?? parsePrice(item?.adjClose) ?? parsePrice(item?.price);

  if (!timestamp || !Number.isFinite(price)) {
    return null;
  }

  return {
    timestamp: new Date(timestamp).toISOString(),
    price
  };
}

function buildHistoricalSeries(payload) {
  const rawPoints = normalizePayload(payload)
    .map(parseHistoricalPoint)
    .filter(Boolean)
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());

  const series = [];
  let previousPrice = null;

  for (const point of rawPoints) {
    const changePct =
      Number.isFinite(previousPrice) && previousPrice > 0
        ? Number((((point.price - previousPrice) / previousPrice) * 100).toFixed(2))
        : 0;

    series.push({
      timestamp: point.timestamp,
      price: point.price,
      changePct
    });
    previousPrice = point.price;
  }

  return series;
}

function buildMissingApiKeyResult(tickers, timestamp) {
  return {
    provider: "fmp",
    quotes: {},
    missingTickers: tickers,
    historicalSeries: {},
    sourceMode: "fallback",
    sourceMeta: {
      provider: "fmp",
      reason: "api-key-missing",
      requestMode: "unavailable",
      liveCount: 0,
      totalTickers: tickers.length,
      batchRequests: 0,
      historicalRequests: 0,
      historicalDerivedQuotes: 0,
      errors: tickers.map((ticker) => ({
        provider: "fmp",
        scope: "provider",
        ticker,
        code: "api-key-missing",
        reason: "api-key-missing",
        message: "FMP API key is missing."
      }))
    },
    updatedAt: timestamp
  };
}

function buildProviderError({ scope, code, message, tickers = [], ticker = null, status = null, rateLimit = null }) {
  return {
    provider: "fmp",
    scope,
    status,
    tickers: tickers.length ? tickers : undefined,
    ticker: ticker || undefined,
    code,
    reason: code,
    message,
    rateLimit
  };
}

function classifyUpstreamError(status, scope, context = {}) {
  if (ENTITLEMENT_STATUS_CODES.has(status)) {
    return buildProviderError({
      scope,
      code: "provider-not-entitled",
      message: `FMP returned HTTP ${status} for the configured endpoint/plan.`,
      status,
      ...context
    });
  }

  if (status === 429) {
    return buildProviderError({
      scope,
      code: "rate-limited",
      message: `FMP returned HTTP ${status}.`,
      status,
      ...context
    });
  }

  return buildProviderError({
    scope,
    code: `fmp-upstream-${status}`,
    message: `FMP returned HTTP ${status}.`,
    status,
    ...context
  });
}

async function fetchBatchQuotes({ baseUrl, apiKey, tickers, timeoutMs, batchChunkSize }) {
  const quotes = {};
  const errors = [];
  let lastRateLimit = null;
  let requests = 0;
  let terminalError = null;

  for (const chunk of chunkTickers(tickers, batchChunkSize)) {
    if (!chunk.length) {
      continue;
    }

    const url = buildFmpBatchQuoteUrl({
      baseUrl,
      tickers: chunk,
      apiKey
    });

    try {
      const response = await fetchWithTimeout(url, { headers: { "User-Agent": "ogid/1.0" } }, timeoutMs);
      const rateLimit = parseRateLimitHeaders(response.headers);
      lastRateLimit = rateLimit || lastRateLimit;
      requests += 1;

      if (!response.ok) {
        const providerError = classifyUpstreamError(response.status, "batch", {
          tickers: chunk,
          rateLimit
        });
        const error = new Error(providerError.message);
        error.rateLimit = rateLimit;
        error.providerError = providerError;
        throw error;
      }

      const payload = await response.json();
      const items = normalizePayload(payload);
      const chunkQuotes = {};

      for (const item of items) {
        const parsed = parseBatchQuote(item);
        if (!parsed) {
          continue;
        }
        chunkQuotes[parsed.symbol] = {
          price: parsed.price,
          changePct: parsed.changePct,
          source: "fmp",
          synthetic: false,
          dataMode: "live"
        };
      }

      const missingChunkTickers = chunk.filter((ticker) => !chunkQuotes[ticker]);
      apiQuotaTracker.recordCall("fmp", {
        status: Object.keys(chunkQuotes).length > 0 ? "success" : "empty",
        headers: rateLimit,
        fallback: missingChunkTickers.length > 0
      });
      Object.assign(quotes, chunkQuotes);
    } catch (error) {
      apiQuotaTracker.recordCall("fmp", { status: "error", fallback: true, headers: error.rateLimit });
      const providerError =
        error.providerError ||
        buildProviderError({
          scope: "batch",
          code: error.message || "request-failed",
          message: error.message || "FMP batch request failed.",
          tickers: chunk,
          rateLimit: error.rateLimit
        });
      errors.push(providerError);
      if (providerError.code === "provider-not-entitled") {
        terminalError = providerError;
        break;
      }
    }
  }

  return {
    quotes,
    errors,
    lastRateLimit,
    requests,
    terminalError
  };
}

async function fetchHistoricalSeries({
  baseUrl,
  apiKey,
  tickers = [],
  timeoutMs,
  timestamp
}) {
  const historicalSeries = {};
  const historicalQuotes = {};
  const errors = [];
  let lastRateLimit = null;
  let requests = 0;
  let terminalError = null;

  for (const ticker of tickers) {
    const url = buildFmpHistoricalEodUrl({
      baseUrl,
      ticker,
      apiKey
    });

    try {
      const response = await fetchWithTimeout(url, { headers: { "User-Agent": "ogid/1.0" } }, timeoutMs);
      const rateLimit = parseRateLimitHeaders(response.headers);
      lastRateLimit = rateLimit || lastRateLimit;
      requests += 1;

      if (!response.ok) {
        const providerError = classifyUpstreamError(response.status, "historical", {
          ticker,
          rateLimit
        });
        const error = new Error(providerError.message);
        error.rateLimit = rateLimit;
        error.providerError = providerError;
        throw error;
      }

      const payload = await response.json();
      const series = buildHistoricalSeries(payload);
      apiQuotaTracker.recordCall("fmp", {
        status: series.length > 0 ? "success" : "empty",
        headers: rateLimit
      });

      if (!series.length) {
        continue;
      }

      historicalSeries[ticker] = series;
      const latestPoint = series.at(-1);
      historicalQuotes[ticker] = {
        price: latestPoint.price,
        changePct: latestPoint.changePct,
        asOf: latestPoint.timestamp || timestamp,
        source: "fmp",
        synthetic: false,
        dataMode: "historical-eod"
      };
    } catch (error) {
      apiQuotaTracker.recordCall("fmp", { status: "error", headers: error.rateLimit });
      const providerError =
        error.providerError ||
        buildProviderError({
          scope: "historical",
          code: error.message || "request-failed",
          message: error.message || "FMP historical request failed.",
          ticker,
          rateLimit: error.rateLimit
        });
      errors.push(providerError);
      if (providerError.code === "provider-not-entitled") {
        terminalError = providerError;
        break;
      }
    }
  }

  return {
    historicalSeries,
    historicalQuotes,
    errors,
    lastRateLimit,
    requests,
    terminalError
  };
}

export async function fetchFmpQuotes({
  apiKey,
  baseUrl,
  tickers = [],
  timeoutMs = 9_000,
  timestamp = new Date().toISOString(),
  batchChunkSize = 25,
  historicalBackfillTickers = [],
  enableHistoricalBackfill = false
}) {
  const normalizedTickers = tickers.map((ticker) => String(ticker).toUpperCase());
  if (!apiKey) {
    return buildMissingApiKeyResult(normalizedTickers, timestamp);
  }

  const startedAt = Date.now();
  const batchResult = await fetchBatchQuotes({
    baseUrl,
    apiKey,
    tickers: normalizedTickers,
    timeoutMs,
    batchChunkSize
  });

  const quotes = Object.fromEntries(
    Object.entries(batchResult.quotes).map(([ticker, quote]) => [
      ticker,
      {
        ...quote,
        asOf: timestamp
      }
    ])
  );

  const normalizedHistoricalTickers = [...new Set(historicalBackfillTickers.map((ticker) => String(ticker).toUpperCase()))];
  let historicalResult = {
    historicalSeries: {},
    historicalQuotes: {},
    errors: [],
    lastRateLimit: null,
    requests: 0,
    terminalError: null
  };

  if (enableHistoricalBackfill && normalizedHistoricalTickers.length && !batchResult.terminalError) {
    historicalResult = await fetchHistoricalSeries({
      baseUrl,
      apiKey,
      tickers: normalizedHistoricalTickers,
      timeoutMs,
      timestamp
    });

    for (const [ticker, historicalQuote] of Object.entries(historicalResult.historicalQuotes)) {
      if (!quotes[ticker]) {
        quotes[ticker] = historicalQuote;
      }
    }
  }

  const missingTickers = normalizedTickers.filter((ticker) => !quotes[ticker]);
  const liveCount = Object.values(quotes).filter((quote) => quote?.dataMode === "live").length;
  const requestModeParts = [];

  if (batchResult.requests > 0) {
    requestModeParts.push("batch");
  }
  if (historicalResult.requests > 0) {
    requestModeParts.push("eod");
  }

  const rateLimit = historicalResult.lastRateLimit || batchResult.lastRateLimit || null;
  const errors = [...batchResult.errors, ...historicalResult.errors];
  const historicalDerivedQuotes = Object.keys(historicalResult.historicalQuotes).filter(
    (ticker) => quotes[ticker]?.dataMode === "historical-eod"
  ).length;
  const providerDisabledReason = batchResult.terminalError?.code || historicalResult.terminalError?.code || null;

  log.info("market_provider_summary", {
    provider: "fmp",
    liveCount,
    fallbackCount: missingTickers.length,
    historicalSeedCount: Object.keys(historicalResult.historicalSeries).length,
    totalTickers: normalizedTickers.length,
    durationMs: Date.now() - startedAt
  });

  return {
    provider: "fmp",
    quotes,
    missingTickers,
    historicalSeries: historicalResult.historicalSeries,
    sourceMode: liveCount <= 0 ? "fallback" : liveCount >= normalizedTickers.length ? "live" : "mixed",
    sourceMeta: {
      provider: "fmp",
      requestMode: requestModeParts.join("+") || "unavailable",
      liveCount,
      totalTickers: normalizedTickers.length,
      batchRequests: batchResult.requests,
      historicalRequests: historicalResult.requests,
      historicalDerivedQuotes,
      providerDisabledReason,
      errors,
      rateLimit
    },
    updatedAt: timestamp
  };
}
