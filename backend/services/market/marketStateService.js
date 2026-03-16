const MAX_MARKET_POINTS = 120;

function buildDisabledCoverageByMode() {
  return {
    live: 0,
    webDelayed: 0,
    historicalEod: 0,
    routerStale: 0,
    syntheticFallback: 0
  };
}

export function buildInitialMarketState(tickers = [], { enabled = true, disabledReason = null } = {}) {
  const normalizedTickers = Array.isArray(tickers) ? tickers : [];
  const marketDisabled = enabled === false;

  return {
    provider: marketDisabled ? "disabled" : "market-router",
    sourceMode: marketDisabled ? "disabled" : "fallback",
    sourceMeta: marketDisabled
      ? {
          provider: "disabled",
          reason: disabledReason || "market-provider-empty",
          enabled: false,
          requestMode: "disabled",
          disabledReason: disabledReason || "market-provider-empty",
          coverageByMode: buildDisabledCoverageByMode(),
          providerErrors: []
        }
      : {
          provider: "seed",
          reason: "initial-state",
          enabled: true
        },
    updatedAt: null,
    quotes: Object.fromEntries(
      normalizedTickers.map((ticker) => [
        ticker,
        {
          price: null,
          changePct: 0,
          asOf: null,
          source: marketDisabled ? "disabled" : "seed",
          synthetic: true,
          dataMode: "synthetic-fallback"
        }
      ])
    ),
    timeseries: Object.fromEntries(normalizedTickers.map((ticker) => [ticker, []]))
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
    provider: marketResult.provider || previousMarketState.provider || "market-router",
    sourceMode: marketResult.sourceMode || previousMarketState.sourceMode || "fallback",
    sourceMeta: marketResult.sourceMeta || previousMarketState.sourceMeta || { provider: "unknown" },
    updatedAt: timestamp,
    quotes: nextQuotes,
    timeseries: nextTimeseries
  };
}
