import apiQuotaTracker, { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("backend/services/market/providers/alphaVantageProvider");

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
    const error = new Error(`alphavantage-upstream-${response.status}`);
    error.rateLimit = rateLimit;
    throw error;
  }

  const payload = await response.json();
  const parsed = parseGlobalQuote(payload);
  if (!parsed) {
    const error = new Error(payload?.Note || payload?.Information ? "alphavantage-rate-limited" : "alphavantage-invalid-payload");
    error.rateLimit = rateLimit;
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
  timestamp = new Date().toISOString()
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
        liveCount: 0,
        totalTickers: normalizedTickers.length,
        errors: normalizedTickers.map((ticker) => ({ ticker, reason: "api-key-missing" }))
      },
      updatedAt: timestamp
    };
  }

  const quotes = {};
  const errors = [];
  let lastRateLimit = null;

  for (const ticker of normalizedTickers) {
    try {
      const startedAt = Date.now();
      const live = await fetchLiveQuote({
        ticker,
        apiKey,
        baseUrl,
        timeoutMs
      });
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
      log.info("market_quote_live_success", {
        ticker,
        source: "alphavantage",
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      errors.push({ ticker, reason: error.message });
      apiQuotaTracker.recordCall("alphavantage", {
        status: "error",
        fallback: true,
        headers: error.rateLimit
      });
      log.warn("market_quote_fallback", { ticker, reason: error.message });
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
      liveCount,
      totalTickers: normalizedTickers.length,
      errors,
      rateLimit: lastRateLimit
    },
    updatedAt: timestamp
  };
}
