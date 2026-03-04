const MAX_MARKET_POINTS = 120;

export function buildInitialMarketState(tickers = []) {
  return {
    provider: "alphavantage",
    sourceMode: "fallback",
    sourceMeta: {
      provider: "seed",
      reason: "initial-state"
    },
    updatedAt: null,
    quotes: Object.fromEntries(
      tickers.map((ticker) => [
        ticker,
        {
          price: null,
          changePct: 0,
          asOf: null,
          source: "seed",
          synthetic: true,
          dataMode: "fallback"
        }
      ])
    ),
    timeseries: Object.fromEntries(tickers.map((ticker) => [ticker, []]))
  };
}

function appendPoint(series = [], point) {
  return [...series, point].slice(-MAX_MARKET_POINTS);
}

export function mergeMarketState(previousMarketState = {}, marketResult = {}) {
  const nextQuotes = {
    ...(previousMarketState.quotes || {}),
    ...(marketResult.quotes || {})
  };

  const nextTimeseries = { ...(previousMarketState.timeseries || {}) };
  const timestamp = marketResult.updatedAt || new Date().toISOString();

  for (const [ticker, quote] of Object.entries(nextQuotes)) {
    if (!Number.isFinite(quote.price)) {
      continue;
    }

    const point = {
      timestamp,
      price: quote.price,
      changePct: quote.changePct
    };
    nextTimeseries[ticker] = appendPoint(nextTimeseries[ticker] || [], point);
  }

  return {
    provider: marketResult.provider || previousMarketState.provider || "alphavantage",
    sourceMode: marketResult.sourceMode || previousMarketState.sourceMode || "fallback",
    sourceMeta: marketResult.sourceMeta || previousMarketState.sourceMeta || { provider: "unknown" },
    updatedAt: timestamp,
    quotes: nextQuotes,
    timeseries: nextTimeseries
  };
}
