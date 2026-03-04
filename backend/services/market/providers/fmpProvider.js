import apiQuotaTracker, { parseRateLimitHeaders } from "../../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("backend/services/market/providers/fmpProvider");

function ensureTrailingSlash(baseUrl) {
  return String(baseUrl).endsWith("/") ? String(baseUrl) : `${String(baseUrl)}/`;
}

function buildFmpQuoteUrl({ baseUrl, tickers = [], apiKey }) {
  const url = new URL("quote", ensureTrailingSlash(baseUrl || "https://financialmodelingprep.com/api/v3"));
  url.searchParams.set("symbol", tickers.join(","));
  if (apiKey) {
    url.searchParams.set("apikey", apiKey);
  }
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

function normalizePayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.data)) {
      return payload.data;
    }
    return Object.values(payload);
  }
  return [];
}

function parseQuote(item) {
  const symbol = String(item?.symbol || "").toUpperCase();
  const price = Number.parseFloat(item?.price);
  const rawChange = String(item?.changesPercentage ?? "");
  const normalizedChange = rawChange
    .replace("%", "")
    .replace("(", "")
    .replace(")", "")
    .replace("+", "")
    .trim();
  const changePct = Number.parseFloat(normalizedChange);

  if (!symbol || !Number.isFinite(price) || !Number.isFinite(changePct)) {
    return null;
  }

  return {
    symbol,
    price: Number(price.toFixed(2)),
    changePct: Number(changePct.toFixed(2))
  };
}

export async function fetchFmpQuotes({
  apiKey,
  baseUrl,
  tickers = [],
  timeoutMs = 9_000,
  timestamp = new Date().toISOString()
}) {
  const normalizedTickers = tickers.map((ticker) => String(ticker).toUpperCase());
  if (!apiKey) {
    return {
      provider: "fmp",
      quotes: {},
      missingTickers: normalizedTickers,
      sourceMode: "fallback",
      sourceMeta: {
        provider: "fmp",
        reason: "api-key-missing",
        liveCount: 0,
        totalTickers: normalizedTickers.length,
        errors: normalizedTickers.map((ticker) => ({ ticker, reason: "api-key-missing" }))
      },
      updatedAt: timestamp
    };
  }

  const url = buildFmpQuoteUrl({
    baseUrl: baseUrl || "https://financialmodelingprep.com/api/v3",
    tickers: normalizedTickers,
    apiKey
  });

  try {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(url, { headers: { "User-Agent": "ogid/1.0" } }, timeoutMs);
    const rateLimit = parseRateLimitHeaders(response.headers);

    if (!response.ok) {
      apiQuotaTracker.recordCall("fmp", { status: "error", fallback: true, headers: rateLimit });
      throw new Error(`fmp-upstream-${response.status}`);
    }

    const payload = await response.json();
    const items = normalizePayload(payload);
    const quotes = {};

    for (const item of items) {
      const parsed = parseQuote(item);
      if (!parsed) {
        continue;
      }
      quotes[parsed.symbol] = {
        price: parsed.price,
        changePct: parsed.changePct,
        asOf: timestamp,
        source: "fmp",
        synthetic: false,
        dataMode: "live"
      };
    }

    const liveCount = Object.keys(quotes).length;
    const missingTickers = normalizedTickers.filter((ticker) => !quotes[ticker]);
    apiQuotaTracker.recordCall("fmp", {
      status: liveCount > 0 ? "success" : "empty",
      headers: rateLimit,
      fallback: missingTickers.length > 0
    });

    log.info("market_provider_summary", {
      provider: "fmp",
      liveCount,
      fallbackCount: missingTickers.length,
      totalTickers: normalizedTickers.length,
      durationMs: Date.now() - startedAt
    });

    return {
      provider: "fmp",
      quotes,
      missingTickers,
      sourceMode: liveCount <= 0 ? "fallback" : liveCount >= normalizedTickers.length ? "live" : "mixed",
      sourceMeta: {
        provider: "fmp",
        liveCount,
        totalTickers: normalizedTickers.length,
        errors: [],
        rateLimit
      },
      updatedAt: timestamp
    };
  } catch (error) {
    log.warn("market_provider_failed", {
      provider: "fmp",
      reason: error.message
    });

    return {
      provider: "fmp",
      quotes: {},
      missingTickers: normalizedTickers,
      sourceMode: "fallback",
      sourceMeta: {
        provider: "fmp",
        liveCount: 0,
        totalTickers: normalizedTickers.length,
        errors: [{ reason: error.message }]
      },
      updatedAt: timestamp
    };
  }
}
