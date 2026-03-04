import { createHash } from "node:crypto";
import apiQuotaTracker, { parseRateLimitHeaders } from "../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("backend/services/market/alphaVantageService");

const BASE_PRICES = {
  GD: 285,
  BA: 205,
  NOC: 465,
  LMT: 470,
  RTX: 96,
  XOM: 105,
  CVX: 150,
  COP: 110,
  SPY: 515,
  XLE: 94,
  ITA: 125
};

function hashToFloat(seed, min, max) {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const numeric = Number.parseInt(digest, 16);
  const ratio = numeric / 0xffffffff;
  return min + (max - min) * ratio;
}

function buildFallbackQuote(ticker, timestamp) {
  const basePrice = BASE_PRICES[ticker] ?? 100;
  const changePct = hashToFloat(`${ticker}-${timestamp.slice(0, 16)}`, -2.8, 2.8);
  const price = basePrice * (1 + changePct / 100);

  return {
    price: Number(price.toFixed(2)),
    changePct: Number(changePct.toFixed(2)),
    asOf: timestamp,
    source: "fallback",
    synthetic: true,
    dataMode: "fallback"
  };
}

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

function resolveSourceMode(liveCount, tickerCount) {
  if (liveCount <= 0) {
    return "fallback";
  }
  if (liveCount >= tickerCount) {
    return "live";
  }
  return "mixed";
}

export async function fetchAlphaVantageQuotes({
  apiKey,
  baseUrl,
  tickers = [],
  timeoutMs = 9_000
}) {
  const timestamp = new Date().toISOString();
  const quotes = {};
  const errors = [];
  let liveCount = 0;
  let lastRateLimit = null;

  for (const ticker of tickers) {
    const normalizedTicker = String(ticker).toUpperCase();
    if (!apiKey) {
      quotes[normalizedTicker] = buildFallbackQuote(normalizedTicker, timestamp);
      continue;
    }

    try {
      const startedAt = Date.now();
      const live = await fetchLiveQuote({
        ticker: normalizedTicker,
        apiKey,
        baseUrl,
        timeoutMs
      });
      lastRateLimit = live.rateLimit || lastRateLimit;
      quotes[normalizedTicker] = {
        price: live.price,
        changePct: live.changePct,
        asOf: timestamp,
        source: "alphavantage",
        synthetic: false,
        dataMode: "live"
      };
      liveCount += 1;
      apiQuotaTracker.recordCall("alphavantage", { status: "success", headers: live.rateLimit });
      log.info("market_quote_live_success", {
        ticker: normalizedTicker,
        source: "alphavantage",
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      errors.push({ ticker: normalizedTicker, reason: error.message });
      quotes[normalizedTicker] = buildFallbackQuote(normalizedTicker, timestamp);
      apiQuotaTracker.recordCall("alphavantage", {
        status: "error",
        fallback: true,
        headers: error.rateLimit
      });
      log.warn("market_quote_fallback", { ticker: normalizedTicker, reason: error.message });
    }
  }

  log.info("market_provider_summary", {
    provider: "alphavantage",
    liveCount,
    fallbackCount: tickers.length - liveCount,
    totalTickers: tickers.length
  });

  return {
    provider: "alphavantage",
    sourceMode: resolveSourceMode(liveCount, tickers.length),
    sourceMeta: {
      provider: "alphavantage",
      liveCount,
      totalTickers: tickers.length,
      errors,
      rateLimit: lastRateLimit
    },
    quotes,
    updatedAt: timestamp
  };
}
