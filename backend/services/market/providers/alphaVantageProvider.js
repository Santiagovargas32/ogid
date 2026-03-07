import apiQuotaTracker, { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("backend/services/market/providers/alphaVantageProvider");
const ALPHAVANTAGE_MIN_BACKOFF_MS = 60_000;
const ALPHAVANTAGE_MAX_BACKOFF_MS = 15 * 60_000;
const ALPHAVANTAGE_DEFAULT_MAX_REQUESTS_PER_RUN = 5;

let nextAllowedAtMs = 0;
let currentBackoffMs = ALPHAVANTAGE_MIN_BACKOFF_MS;

function parseGlobalQuote(payload) {
  const quote = payload?.["Global Quote"];
  if (!quote) {
    return null;
  }

  const price = Number.parseFloat(quote["05. price"]);
  const changePercentRaw = String(quote["10. change percent"] || "").replace("%", "");
  const changePct = Number.parseFloat(changePercentRaw);

  if (!Number.isFinite(price) || !Number.isFinite(changePct)) {
    return null;
  }

  return {
    price: Number(price.toFixed(2)),
    changePct: Number(changePct.toFixed(2))
  };
}

function buildProviderError({ ticker, code, message, rateLimit = null }) {
  return {
    provider: "alphavantage",
    scope: "quote",
    ticker,
    code,
    reason: code,
    message,
    rateLimit
  };
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

async function fetchLiveQuote({ ticker, apiKey, baseUrl, timeoutMs }) {
  const url = new URL(baseUrl || "https://www.alphavantage.co/query");
  url.searchParams.set("function", "GLOBAL_QUOTE");
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("apikey", apiKey);

  const response = await fetchWithTimeout(url, { headers: { "User-Agent": "ogid/1.0" } }, timeoutMs);
  const rateLimit = parseRateLimitHeaders(response.headers);
  if (!response.ok) {
    const providerError = buildProviderError({
      ticker,
      code: `alphavantage-upstream-${response.status}`,
      message: `Alpha Vantage returned HTTP ${response.status}.`,
      rateLimit
    });
    const error = new Error(providerError.message);
    error.rateLimit = rateLimit;
    error.providerError = providerError;
    throw error;
  }

  const payload = await response.json();
  const parsed = parseGlobalQuote(payload);
  if (!parsed) {
    const providerError = buildProviderError({
      ticker,
      code: payload?.Note || payload?.Information ? "rate-limited" : "invalid-payload",
      message: payload?.Note || payload?.Information || "Alpha Vantage returned an invalid payload.",
      rateLimit
    });
    const error = new Error(providerError.message);
    error.rateLimit = rateLimit;
    error.providerError = providerError;
    throw error;
  }

  return {
    ...parsed,
    rateLimit
  };
}

export async function fetchAlphaVantageProviderQuotes({
  apiKey,
  baseUrl,
  tickers = [],
  timeoutMs = 9_000,
  timestamp = new Date().toISOString(),
  maxRequestsPerRun = ALPHAVANTAGE_DEFAULT_MAX_REQUESTS_PER_RUN
}) {
  const normalizedTickers = tickers.map((ticker) => String(ticker).toUpperCase());
  if (!apiKey) {
    return {
      provider: "alphavantage",
      quotes: {},
      missingTickers: normalizedTickers,
      sourceMode: "fallback",
      sourceMeta: {
        provider: "alphavantage",
        reason: "api-key-missing",
        requestMode: "unavailable",
        liveCount: 0,
        totalTickers: normalizedTickers.length,
        errors: normalizedTickers.map((ticker) =>
          buildProviderError({
            ticker,
            code: "api-key-missing",
            message: "Alpha Vantage API key is missing."
          })
        )
      },
      updatedAt: timestamp
    };
  }

  if (Date.now() < nextAllowedAtMs) {
    return {
      provider: "alphavantage",
      quotes: {},
      missingTickers: normalizedTickers,
      sourceMode: "fallback",
      sourceMeta: {
        provider: "alphavantage",
        reason: "cooldown",
        requestMode: "single",
        liveCount: 0,
        totalTickers: normalizedTickers.length,
        nextAllowedAt: new Date(nextAllowedAtMs).toISOString(),
        errors: []
      },
      updatedAt: timestamp
    };
  }

  const quotes = {};
  const errors = [];
  let lastRateLimit = null;
  let requests = 0;
  const requestLimit = Math.max(
    1,
    Number.parseInt(String(maxRequestsPerRun ?? ""), 10) || ALPHAVANTAGE_DEFAULT_MAX_REQUESTS_PER_RUN
  );

  for (const ticker of normalizedTickers) {
    if (requests >= requestLimit) {
      break;
    }

    try {
      const startedAt = Date.now();
      const live = await fetchLiveQuote({
        ticker,
        apiKey,
        baseUrl,
        timeoutMs
      });
      requests += 1;
      lastRateLimit = live.rateLimit || lastRateLimit;
      quotes[ticker] = {
        price: live.price,
        changePct: live.changePct,
        asOf: timestamp,
        source: "alphavantage",
        synthetic: false,
        dataMode: "live"
      };
      apiQuotaTracker.recordCall("alphavantage", { status: "success", headers: live.rateLimit });
      log.info("market_quote_live_success", { ticker, source: "alphavantage", durationMs: Date.now() - startedAt });
      currentBackoffMs = ALPHAVANTAGE_MIN_BACKOFF_MS;
      nextAllowedAtMs = 0;
    } catch (error) {
      requests += 1;
      const providerError =
        error.providerError ||
        buildProviderError({
          ticker,
          code: error.message || "request-failed",
          message: error.message || "Alpha Vantage request failed.",
          rateLimit: error.rateLimit
        });
      errors.push(providerError);
      apiQuotaTracker.recordCall("alphavantage", {
        status: "error",
        fallback: true,
        headers: error.rateLimit
      });
      log.warn("market_quote_fallback", {
        ticker,
        reason: providerError.code,
        message: providerError.message
      });
      if (providerError.code === "rate-limited") {
        nextAllowedAtMs = Date.now() + currentBackoffMs;
        currentBackoffMs = Math.min(currentBackoffMs * 2, ALPHAVANTAGE_MAX_BACKOFF_MS);
        break;
      }
    }
  }

  const liveCount = Object.keys(quotes).length;
  const missingTickers = normalizedTickers.filter((ticker) => !quotes[ticker]);

  log.info("market_provider_summary", {
    provider: "alphavantage",
    liveCount,
    fallbackCount: missingTickers.length,
    totalTickers: normalizedTickers.length
  });

  return {
    provider: "alphavantage",
    quotes,
    missingTickers,
    sourceMode: liveCount <= 0 ? "fallback" : liveCount >= normalizedTickers.length ? "live" : "mixed",
    sourceMeta: {
      provider: "alphavantage",
      requestMode: "single",
      liveCount,
      totalTickers: normalizedTickers.length,
      requestCount: requests,
      nextAllowedAt: nextAllowedAtMs > Date.now() ? new Date(nextAllowedAtMs).toISOString() : null,
      errors,
      rateLimit: lastRateLimit
    },
    updatedAt: timestamp
  };
}

export function resetAlphaVantageThrottleForTests() {
  nextAllowedAtMs = 0;
  currentBackoffMs = ALPHAVANTAGE_MIN_BACKOFF_MS;
}
