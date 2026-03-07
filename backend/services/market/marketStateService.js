const MAX_MARKET_POINTS = 120;

export function buildInitialMarketState(tickers = []) {
  return {
    provider: "market-router",
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
          dataMode: "synthetic-fallback"
        }
      ])
    ),
    timeseries: Object.fromEntries(tickers.map((ticker) => [ticker, []]))
  };
}

function appendPoint(series = [], point) {
  const lastPoint = series.at(-1);
  if (
    lastPoint &&
    lastPoint.timestamp === point.timestamp &&
    Number(lastPoint.price) === Number(point.price) &&
    Number(lastPoint.changePct) === Number(point.changePct)
  ) {
    return series.slice(-MAX_MARKET_POINTS);
  }

  return [...series, point].slice(-MAX_MARKET_POINTS);
}

function seedHistoricalSeries(existingSeries = [], seededSeries = []) {
  if (existingSeries.length || !seededSeries.length) {
    return existingSeries;
  }

  return seededSeries
    .filter((point) => Number.isFinite(point?.price) && point?.timestamp)
    .slice(-MAX_MARKET_POINTS)
    .map((point) => ({
      timestamp: point.timestamp,
      price: point.price,
      changePct: point.changePct
    }));
}

export function mergeMarketState(previousMarketState = {}, marketResult = {}) {
  const nextQuotes = {
    ...(previousMarketState.quotes || {}),
    ...(marketResult.quotes || {})
  };

  const nextTimeseries = { ...(previousMarketState.timeseries || {}) };
  const timestamp = marketResult.updatedAt || new Date().toISOString();

  for (const [ticker, seededSeries] of Object.entries(marketResult.historicalSeries || {})) {
    nextTimeseries[ticker] = seedHistoricalSeries(nextTimeseries[ticker] || [], seededSeries);
  }

  for (const [ticker, quote] of Object.entries(nextQuotes)) {
    if (!Number.isFinite(quote.price)) {
      continue;
    }

    const point = {
      timestamp: quote.asOf || timestamp,
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
