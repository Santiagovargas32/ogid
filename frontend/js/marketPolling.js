const FOREGROUND_INTERVAL_MS = 45_000;
const BACKGROUND_INTERVAL_MS = 300_000;
const CLOSED_INTERVAL_MS = 600_000;
const STALE_INTERVAL_MS = 30_000;

export function resolveMarketQuotesPollDelayMs({
  hidden = false,
  marketOpen = true,
  dataMode = "live"
} = {}) {
  if (!marketOpen) {
    return CLOSED_INTERVAL_MS;
  }

  if (hidden) {
    return BACKGROUND_INTERVAL_MS;
  }

  if (String(dataMode || "").toLowerCase() === "router-stale") {
    return STALE_INTERVAL_MS;
  }

  return FOREGROUND_INTERVAL_MS;
}

export const MARKET_POLLING_INTERVALS = {
  foreground: FOREGROUND_INTERVAL_MS,
  background: BACKGROUND_INTERVAL_MS,
  closed: CLOSED_INTERVAL_MS,
  stale: STALE_INTERVAL_MS
};
