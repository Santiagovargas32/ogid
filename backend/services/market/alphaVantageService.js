import { fetchAlphaVantageProviderQuotes } from "./providers/alphaVantageProvider.js";
import { buildFallbackQuote } from "./providers/quoteFallback.js";

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
  const providerResult = await fetchAlphaVantageProviderQuotes({
    apiKey,
    baseUrl,
    tickers,
    timeoutMs,
    timestamp
  });

  const quotes = { ...(providerResult.quotes || {}) };
  for (const ticker of tickers.map((item) => String(item).toUpperCase())) {
    if (!quotes[ticker]) {
      quotes[ticker] = buildFallbackQuote(ticker, timestamp);
    }
  }

  const liveCount = Object.values(quotes).filter((quote) => quote.synthetic === false).length;

  return {
    provider: "alphavantage",
    sourceMode: resolveSourceMode(liveCount, tickers.length),
    sourceMeta: {
      ...(providerResult.sourceMeta || {}),
      liveCount,
      totalTickers: tickers.length
    },
    quotes,
    updatedAt: timestamp
  };
}
