import apiQuotaTracker from "../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../utils/logger.js";
import { fetchAlphaVantageProviderQuotes } from "./providers/alphaVantageProvider.js";
import { fetchFmpQuotes } from "./providers/fmpProvider.js";
import { buildFallbackQuote } from "./providers/quoteFallback.js";

const log = createLogger("backend/services/market/marketProviderRouter");

const PROVIDER_MAP = {
  fmp: fetchFmpQuotes,
  alphavantage: fetchAlphaVantageProviderQuotes
};

function normalizeProvider(value, fallback) {
  const normalized = String(value || "").toLowerCase();
  return normalized in PROVIDER_MAP ? normalized : fallback;
}

function resolveSourceMode(liveCount, totalCount) {
  if (liveCount <= 0) {
    return "fallback";
  }
  if (liveCount >= totalCount) {
    return "live";
  }
  return "mixed";
}

function buildProviderConfig(provider, config) {
  if (provider === "fmp") {
    return {
      apiKey: config.fmpApiKey || "",
      baseUrl: config.fmpBaseUrl || "https://financialmodelingprep.com/api/v3"
    };
  }

  return {
    apiKey: config.apiKey || config.alphaVantageApiKey || "",
    baseUrl: config.baseUrl || config.alphaVantageBaseUrl || "https://www.alphavantage.co/query"
  };
}

export async function fetchMarketQuotes(config = {}) {
  const tickers = (config.tickers || []).map((ticker) => String(ticker).toUpperCase());
  const timestamp = new Date().toISOString();
  const primaryProvider = normalizeProvider(config.provider || "fmp", "fmp");
  const fallbackProvider = normalizeProvider(
    config.fallbackProvider || (primaryProvider === "fmp" ? "alphavantage" : "fmp"),
    primaryProvider === "fmp" ? "alphavantage" : "fmp"
  );

  const primaryFetcher = PROVIDER_MAP[primaryProvider];
  const fallbackFetcher = PROVIDER_MAP[fallbackProvider];

  const primaryResult = await primaryFetcher({
    ...buildProviderConfig(primaryProvider, config),
    tickers,
    timeoutMs: config.timeoutMs,
    timestamp
  });

  const mergedQuotes = { ...(primaryResult.quotes || {}) };
  const providersUsed = [primaryProvider];
  const errors = [...(primaryResult.sourceMeta?.errors || [])];
  let unresolved = [...(primaryResult.missingTickers || [])];

  if (fallbackFetcher && fallbackProvider !== primaryProvider && unresolved.length) {
    const fallbackResult = await fallbackFetcher({
      ...buildProviderConfig(fallbackProvider, config),
      tickers: unresolved,
      timeoutMs: config.timeoutMs,
      timestamp
    });

    providersUsed.push(fallbackProvider);
    Object.assign(mergedQuotes, fallbackResult.quotes || {});
    errors.push(...(fallbackResult.sourceMeta?.errors || []));
    unresolved = unresolved.filter((ticker) => !fallbackResult.quotes?.[ticker]);
  }

  if (unresolved.length) {
    for (const ticker of unresolved) {
      mergedQuotes[ticker] = buildFallbackQuote(ticker, timestamp);
    }
    apiQuotaTracker.markFallback(primaryProvider);
    if (fallbackProvider !== primaryProvider) {
      apiQuotaTracker.markFallback(fallbackProvider);
    }
  }

  const liveCount = Object.values(mergedQuotes).filter((quote) => quote && quote.synthetic === false).length;
  const totalTickers = tickers.length;
  const sourceMode = resolveSourceMode(liveCount, totalTickers);

  log.info("market_router_completed", {
    primaryProvider,
    fallbackProvider,
    providersUsed,
    liveCount,
    fallbackCount: totalTickers - liveCount,
    totalTickers,
    sourceMode
  });

  return {
    provider: providersUsed.join("+"),
    sourceMode,
    sourceMeta: {
      provider: providersUsed.join("+"),
      providersUsed,
      liveCount,
      totalTickers,
      fallbackCount: totalTickers - liveCount,
      unresolvedTickers: unresolved,
      errors
    },
    quotes: mergedQuotes,
    updatedAt: timestamp
  };
}
