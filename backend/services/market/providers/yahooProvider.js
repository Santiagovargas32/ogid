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

export const DEFAULT_YAHOO_BASE_URL = "https://finance.yahoo.com";
export const DEFAULT_YAHOO_USER_AGENT = "ogid/1.0";

function buildYahooQuotePageUrl({ baseUrl = DEFAULT_YAHOO_BASE_URL, ticker }) {
  return new URL(`quote/${String(ticker || "").trim().toUpperCase()}`, ensureTrailingSlash(baseUrl));
}

function extractBalancedJson(text = "", startIndex = -1) {
  if (startIndex < 0 || startIndex >= text.length || text[startIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function extractJsonByMarker(html = "", marker = "") {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const jsonStart = html.indexOf("{", markerIndex + marker.length);
  if (jsonStart < 0) {
    return null;
  }

  const raw = extractBalancedJson(html, jsonStart);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractScriptPayload(html = "", scriptId = "") {
  const pattern = new RegExp(`<script[^>]*id=["']${scriptId}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i");
  const match = html.match(pattern);
  if (!match?.[1]) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function readRawValue(value) {
  if (value && typeof value === "object" && "raw" in value) {
    return value.raw;
  }
  return value;
}

function buildCandidateFromQuoteSummaryStore(store = {}, ticker = "") {
  const price = store?.price || {};
  const summary = store?.summaryDetail || {};
  const quoteType = store?.quoteType || {};
  const symbol = String(price?.symbol || quoteType?.symbol || store?.symbol || ticker || "")
    .trim()
    .toUpperCase();

  return {
    symbol,
    regularMarketPrice: readRawValue(price?.regularMarketPrice ?? store?.regularMarketPrice),
    regularMarketChangePercent: readRawValue(
      price?.regularMarketChangePercent ?? store?.regularMarketChangePercent ?? summary?.regularMarketChangePercent
    ),
    regularMarketPreviousClose: readRawValue(
      summary?.regularMarketPreviousClose ?? price?.regularMarketPreviousClose ?? store?.regularMarketPreviousClose
    ),
    regularMarketDayHigh: readRawValue(summary?.regularMarketDayHigh ?? store?.regularMarketDayHigh),
    regularMarketDayLow: readRawValue(summary?.regularMarketDayLow ?? store?.regularMarketDayLow),
    regularMarketVolume: readRawValue(
      summary?.regularMarketVolume ?? price?.regularMarketVolume ?? store?.regularMarketVolume
    ),
    regularMarketTime: readRawValue(price?.regularMarketTime ?? store?.regularMarketTime),
    marketState: price?.marketState || store?.marketState || summary?.marketState || null
  };
}

function buildCandidateFromGenericObject(candidate = {}, ticker = "") {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const nestedPrice = candidate?.price && typeof candidate.price === "object" ? candidate.price : {};
  const nestedSummary = candidate?.summaryDetail && typeof candidate.summaryDetail === "object" ? candidate.summaryDetail : {};
  const symbol = String(
    candidate?.symbol ||
      candidate?.ticker ||
      nestedPrice?.symbol ||
      candidate?.quoteType?.symbol ||
      ticker ||
      ""
  )
    .trim()
    .toUpperCase();

  return {
    symbol,
    regularMarketPrice: readRawValue(
      candidate?.regularMarketPrice ??
        nestedPrice?.regularMarketPrice ??
        candidate?.price ??
        candidate?.close ??
        candidate?.lastPrice
    ),
    regularMarketChangePercent: readRawValue(
      candidate?.regularMarketChangePercent ??
        nestedPrice?.regularMarketChangePercent ??
        candidate?.changePercent ??
        candidate?.percent_change
    ),
    regularMarketPreviousClose: readRawValue(
      candidate?.regularMarketPreviousClose ??
        nestedSummary?.regularMarketPreviousClose ??
        nestedPrice?.regularMarketPreviousClose ??
        candidate?.previousClose
    ),
    regularMarketDayHigh: readRawValue(candidate?.regularMarketDayHigh ?? nestedSummary?.regularMarketDayHigh ?? candidate?.dayHigh),
    regularMarketDayLow: readRawValue(candidate?.regularMarketDayLow ?? nestedSummary?.regularMarketDayLow ?? candidate?.dayLow),
    regularMarketVolume: readRawValue(
      candidate?.regularMarketVolume ?? nestedSummary?.regularMarketVolume ?? candidate?.volume
    ),
    regularMarketTime: readRawValue(candidate?.regularMarketTime ?? nestedPrice?.regularMarketTime ?? candidate?.time),
    marketState: candidate?.marketState || nestedPrice?.marketState || null
  };
}

function scoreCandidate(candidate = {}, ticker = "") {
  const symbol = String(candidate?.symbol || "").trim().toUpperCase();
  const hasPrice = Number.isFinite(parsePrice(candidate?.regularMarketPrice));
  if (!hasPrice) {
    return -1;
  }

  let score = 0;
  if (symbol === String(ticker || "").trim().toUpperCase()) {
    score += 20;
  }
  if (Number.isFinite(parsePrice(candidate?.regularMarketPreviousClose))) {
    score += 4;
  }
  if (Number.isFinite(parsePercent(candidate?.regularMarketChangePercent))) {
    score += 4;
  }
  if (Number.isFinite(parseInteger(candidate?.regularMarketVolume))) {
    score += 2;
  }
  if (candidate?.regularMarketTime) {
    score += 1;
  }
  return score;
}

function findBestGenericCandidate(payload = {}, ticker = "") {
  const visited = new Set();
  let best = null;
  let bestScore = -1;

  function visit(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 12 || visited.has(value)) {
      return;
    }
    visited.add(value);

    const candidate = buildCandidateFromGenericObject(value, ticker);
    const candidateScore = scoreCandidate(candidate, ticker);
    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      best = candidate;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }

    for (const child of Object.values(value)) {
      visit(child, depth + 1);
    }
  }

  visit(payload);
  return best;
}

function extractQuoteCandidate(payload = {}, ticker = "") {
  const stores =
    payload?.context?.dispatcher?.stores ||
    payload?.context?.stores ||
    payload?.stores ||
    payload?.props?.stores ||
    null;

  if (stores?.QuoteSummaryStore) {
    const candidate = buildCandidateFromQuoteSummaryStore(stores.QuoteSummaryStore, ticker);
    if (scoreCandidate(candidate, ticker) >= 0) {
      return candidate;
    }
  }

  const streamQuote =
    stores?.StreamDataStore?.quoteData?.[ticker] ||
    stores?.StreamDataStore?.quoteData?.[String(ticker || "").toUpperCase()] ||
    stores?.StreamDataStore?.quotes?.[ticker] ||
    null;
  if (streamQuote) {
    const candidate = buildCandidateFromGenericObject(streamQuote, ticker);
    if (scoreCandidate(candidate, ticker) >= 0) {
      return candidate;
    }
  }

  return findBestGenericCandidate(payload, ticker);
}

function extractEmbeddedPayloads(html = "") {
  const payloads = [];
  const candidates = [
    extractJsonByMarker(html, "root.App.main ="),
    extractJsonByMarker(html, "window.__PRELOADED_STATE__ ="),
    extractJsonByMarker(html, "window.__INITIAL_STATE__ ="),
    extractScriptPayload(html, "__NEXT_DATA__")
  ].filter(Boolean);

  payloads.push(...candidates);
  return payloads;
}

function parseYahooScrapedQuote(candidate = {}, ticker = "", timestamp = new Date().toISOString(), marketSession = {}, providerLatencyMs = null, providerScore = null) {
  const symbol = String(candidate?.symbol || ticker || "").trim().toUpperCase();
  const price =
    parsePrice(candidate?.regularMarketPrice) ??
    parsePrice(candidate?.postMarketPrice) ??
    parsePrice(candidate?.preMarketPrice) ??
    parsePrice(candidate?.price);

  if (!symbol || !Number.isFinite(price)) {
    return null;
  }

  const previousClose =
    parsePrice(candidate?.regularMarketPreviousClose) ??
    parsePrice(candidate?.postMarketPreviousClose) ??
    parsePrice(candidate?.preMarketPreviousClose) ??
    parsePrice(candidate?.previousClose);
  const fallbackChangePct =
    parsePercent(candidate?.regularMarketChangePercent) ??
    parsePercent(candidate?.postMarketChangePercent) ??
    parsePercent(candidate?.preMarketChangePercent) ??
    parsePercent(candidate?.changePercent);
  const changePct = computeChangePct(price, previousClose, fallbackChangePct);

  return {
    price,
    changePct,
    high: parsePrice(candidate?.regularMarketDayHigh) ?? parsePrice(candidate?.dayHigh) ?? null,
    low: parsePrice(candidate?.regularMarketDayLow) ?? parsePrice(candidate?.dayLow) ?? null,
    volume: parseInteger(candidate?.regularMarketVolume) ?? parseInteger(candidate?.volume),
    previousClose,
    marketState: String(candidate?.marketState || (marketSession?.open ? "REGULAR" : "CLOSED")).toUpperCase(),
    asOf: toIsoTimestamp(candidate?.regularMarketTime ?? candidate?.regularMarketTimestamp, timestamp),
    source: "yahoo",
    sourceDetail: "yahoo",
    synthetic: false,
    dataMode: "live",
    providerLatencyMs,
    providerScore
  };
}

function createPageAttemptSummary({
  ticker,
  requestUrl,
  status,
  httpStatus,
  quote = null,
  error = null,
  responsePreview = null,
  lastAttemptAt = null,
  lastSuccessAt = null
}) {
  return {
    ticker,
    status,
    requestUrl,
    httpStatus,
    quote,
    error,
    responsePreview,
    lastAttemptAt,
    lastSuccessAt
  };
}

async function mapWithConcurrency(items = [], limit = 3, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

export async function fetchYahooQuotes({
  baseUrl = DEFAULT_YAHOO_BASE_URL,
  userAgent = DEFAULT_YAHOO_USER_AGENT,
  tickers = [],
  timeoutMs = 10_000,
  timestamp = new Date().toISOString(),
  session = null
} = {}) {
  const requestedTickers = normalizeRequestedTickers(tickers);
  const configuredBaseUrl = baseUrl || DEFAULT_YAHOO_BASE_URL;
  const marketSession = session || { open: false, state: "closed", checkedAt: timestamp };

  if (!requestedTickers.length) {
    return summarizeAttempt({
      provider: "yahoo",
      transport: "web",
      configuredBaseUrl,
      requestMode: "standby",
      durationMs: 0,
      requestUrls: [],
      requestedTickers: [],
      returnedTickers: [],
      missingTickers: [],
      quotaSnapshot: apiQuotaTracker.getProviderSnapshot("yahoo"),
      quotes: {}
    });
  }

  const startedAt = Date.now();
  const pageAttempts = await mapWithConcurrency(requestedTickers, 3, async (ticker) => {
    const requestUrl = buildYahooQuotePageUrl({
      baseUrl: configuredBaseUrl,
      ticker
    });

    try {
      const response = await fetchWithTimeout(
        requestUrl,
        {
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent": userAgent || DEFAULT_YAHOO_USER_AGENT
          }
        },
        timeoutMs
      );
      const text = await response.text();

      if (!response.ok) {
        const error = buildProviderError({
          provider: "yahoo",
          scope: "page",
          code: "yahoo-upstream-status",
          message: `Yahoo Finance returned HTTP ${response.status}.`,
          ticker,
          status: response.status,
          requestUrl: requestUrl.toString(),
          responsePreview: text
        });
        apiQuotaTracker.recordCall("yahoo", {
          status: "error",
          fallback: true,
          headers: response.headers,
          timestamp,
          units: 1
        });
        return createPageAttemptSummary({
          ticker,
          requestUrl: requestUrl.toString(),
          status: "error",
          httpStatus: response.status,
          error,
          responsePreview: text,
          lastAttemptAt: timestamp,
          lastSuccessAt: null
        });
      }

      const payloads = extractEmbeddedPayloads(text);
      let candidate = null;
      for (const payload of payloads) {
        candidate = extractQuoteCandidate(payload, ticker);
        if (candidate) {
          break;
        }
      }

      if (!candidate) {
        const error = buildProviderError({
          provider: "yahoo",
          scope: "page",
          code: "yahoo-embedded-json-missing",
          message: "Yahoo Finance page did not expose a parseable embedded quote payload.",
          ticker,
          requestUrl: requestUrl.toString(),
          responsePreview: text
        });
        apiQuotaTracker.recordCall("yahoo", {
          status: "error",
          fallback: true,
          headers: response.headers,
          timestamp,
          units: 1
        });
        return createPageAttemptSummary({
          ticker,
          requestUrl: requestUrl.toString(),
          status: "error",
          httpStatus: response.status,
          error,
          responsePreview: text,
          lastAttemptAt: timestamp,
          lastSuccessAt: null
        });
      }

      const quote = parseYahooScrapedQuote(candidate, ticker, timestamp, marketSession, null, null);
      if (!quote) {
        const error = buildProviderError({
          provider: "yahoo",
          scope: "page",
          code: "yahoo-quote-missing",
          message: "Yahoo Finance embedded payload did not contain a usable quote.",
          ticker,
          requestUrl: requestUrl.toString(),
          responsePreview: text
        });
        apiQuotaTracker.recordCall("yahoo", {
          status: "empty",
          fallback: true,
          headers: response.headers,
          timestamp,
          units: 1
        });
        return createPageAttemptSummary({
          ticker,
          requestUrl: requestUrl.toString(),
          status: "empty",
          httpStatus: response.status,
          error,
          responsePreview: text,
          lastAttemptAt: timestamp,
          lastSuccessAt: null
        });
      }

      apiQuotaTracker.recordCall("yahoo", {
        status: "success",
        fallback: false,
        headers: response.headers,
        timestamp,
        units: 1
      });
      return createPageAttemptSummary({
        ticker,
        requestUrl: requestUrl.toString(),
        status: "ok",
        httpStatus: response.status,
        quote,
        responsePreview: null,
        lastAttemptAt: timestamp,
        lastSuccessAt: timestamp
      });
    } catch (error) {
      const providerError = buildProviderError({
        provider: "yahoo",
        scope: "page",
        code: error?.name === "AbortError" ? "yahoo-timeout" : "yahoo-request-failed",
        message:
          error?.name === "AbortError"
            ? "Yahoo Finance page request timed out."
            : error?.message || "Yahoo Finance page request failed.",
        ticker,
        requestUrl: requestUrl.toString()
      });
      apiQuotaTracker.recordCall("yahoo", {
        status: "error",
        fallback: true,
        timestamp,
        units: 1
      });
      return createPageAttemptSummary({
        ticker,
        requestUrl: requestUrl.toString(),
        status: "error",
        httpStatus: null,
        error: providerError,
        responsePreview: null,
        lastAttemptAt: timestamp,
        lastSuccessAt: null
      });
    }
  });

  const durationMs = Date.now() - startedAt;
  const quotes = {};
  const requestUrls = [];
  const errors = [];
  const httpStatuses = [];

  for (const attempt of pageAttempts) {
    requestUrls.push(attempt.requestUrl);
    if (Number.isFinite(Number(attempt.httpStatus))) {
      httpStatuses.push(Number(attempt.httpStatus));
    }
    if (attempt.quote) {
      quotes[attempt.ticker] = attempt.quote;
    }
    if (attempt.error) {
      errors.push(attempt.error);
    }
  }

  const missingTickers = requestedTickers.filter((ticker) => !quotes[ticker]);
  const quotaSnapshot = apiQuotaTracker.getProviderSnapshot("yahoo");
  const score = computeProviderScore({
    returnedCount: Object.keys(quotes).length,
    totalTickers: requestedTickers.length,
    durationMs,
    errorCount: errors.length,
    marketOpen: Boolean(marketSession?.open),
    transport: "web"
  });
  for (const quote of Object.values(quotes)) {
    quote.providerLatencyMs = durationMs;
    quote.providerScore = score;
  }

  return summarizeAttempt({
    provider: "yahoo",
    transport: "web",
    configuredBaseUrl,
    requestMode: "live-page-scrape",
    durationMs,
    requestUrls,
    requestedTickers,
    returnedTickers: Object.keys(quotes),
    missingTickers,
    httpStatus: httpStatuses.find((status) => status >= 400) || httpStatuses.at(-1) || null,
    lastAttemptAt: pageAttempts.at(-1)?.lastAttemptAt || timestamp,
    lastSuccessAt: pageAttempts.findLast((attempt) => attempt.quote)?.lastSuccessAt || null,
    quotaSnapshot,
    score,
    errors,
    responsePreview: errors.at(-1)?.responsePreview || null,
    quotes,
    extras: {
      pageAttempts: pageAttempts.map((attempt) => ({
        ticker: attempt.ticker,
        status: attempt.status,
        requestUrl: attempt.requestUrl,
        httpStatus: attempt.httpStatus,
        lastAttemptAt: attempt.lastAttemptAt,
        lastSuccessAt: attempt.lastSuccessAt,
        errorCode: attempt.error?.code || null
      }))
    }
  });
}
