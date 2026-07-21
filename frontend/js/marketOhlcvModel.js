function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
export function normalizeOhlcvCandles(values = []) {
  const byTimestamp = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const openTime = new Date(value?.openTime || value?.timestamp || "");
    const open = finiteNumber(value?.open);
    const high = finiteNumber(value?.high);
    const low = finiteNumber(value?.low);
    const close = finiteNumber(value?.close);
    const volume = finiteNumber(value?.volume);
    if (
      !Number.isFinite(openTime.getTime()) ||
      [open, high, low, close].some((number) => number === null) ||
      high < Math.max(open, low, close) ||
      low > Math.min(open, high, close)
    ) {
      continue;
    }

    const timestamp = openTime.toISOString();
    byTimestamp.set(timestamp, {
      openTime: timestamp,
      open,
      high,
      low,
      close,
      volume,
      currency: String(value?.currency || "").trim().toUpperCase(),
      source: String(value?.source || "unknown").trim(),
      dataMode: String(value?.dataMode || "unknown").trim().toLowerCase()
    });
  }

  return [...byTimestamp.values()].sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime));
}

export function buildOhlcvChartSeries(values = []) {
  const candles = normalizeOhlcvCandles(values);
  return {
    candles,
    labels: candles.map((candle) => candle.openTime),
    closes: candles.map((candle) => candle.close),
    volumes: candles.map((candle) => candle.volume)
  };
}

export function buildOhlcvSummary(values = []) {
  const candles = normalizeOhlcvCandles(values);
  if (!candles.length) {
    return null;
  }

  const first = candles[0];
  const last = candles.at(-1);
  const low = Math.min(...candles.map((candle) => candle.low));
  const high = Math.max(...candles.map((candle) => candle.high));
  const changePct = first.open === 0 ? null : ((last.close - first.open) / first.open) * 100;
  return { open: first.open, close: last.close, low, high, changePct };
}
