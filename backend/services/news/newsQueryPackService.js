const DEFAULT_MARKET_PRICE_ACTION_QUERY = [
  "shares",
  "stock",
  "stocks",
  "equity",
  "equities",
  "premarket",
  "\"after hours\"",
  "\"price target\"",
  "upgrade",
  "downgrade",
  "guidance",
  "earnings",
  "selloff",
  "rally"
].join(" OR ");

function clone(value) {
  return structuredClone(value);
}

function sanitizePackMap(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [String(key || "").trim(), String(entry || "").trim()])
      .filter(([key, entry]) => key && entry)
  );
}

function buildTickerQuery(tickers = []) {
  const normalized = [...new Set((Array.isArray(tickers) ? tickers : []).map((ticker) => String(ticker || "").trim().toUpperCase()).filter(Boolean))];
  return normalized.join(" OR ");
}

function deriveLegacyEditorialPacks(rawValue = {}) {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return {};
  }

  return sanitizePackMap(
    Object.fromEntries(
      Object.entries(rawValue).filter(([key]) => !["editorial", "marketsignals"].includes(String(key || "").toLowerCase()))
    )
  );
}

export function normalizeNewsQueryPacks(
  rawValue = {},
  { marketTickers = [], defaultEditorialPacks = {} } = {}
) {
  const normalizedDefaults = sanitizePackMap(defaultEditorialPacks);
  const normalizedTickerQuery = buildTickerQuery(marketTickers);
  const marketSignalDefaults = {
    tickers: normalizedTickerQuery,
    priceAction: DEFAULT_MARKET_PRICE_ACTION_QUERY
  };

  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    const editorial = clone(normalizedDefaults);
    const marketSignals = sanitizePackMap(marketSignalDefaults);
    return {
      editorial,
      marketSignals,
      flattened: {
        ...editorial,
        ...marketSignals
      }
    };
  }

  const legacyEditorial = deriveLegacyEditorialPacks(rawValue);
  const hasNestedGroups =
    rawValue.editorial && typeof rawValue.editorial === "object" && !Array.isArray(rawValue.editorial) ||
    rawValue.marketSignals && typeof rawValue.marketSignals === "object" && !Array.isArray(rawValue.marketSignals);

  const editorial = hasNestedGroups
    ? {
        ...normalizedDefaults,
        ...legacyEditorial,
        ...sanitizePackMap(rawValue.editorial)
      }
    : {
        ...normalizedDefaults,
        ...legacyEditorial
      };

  const marketSignals = {
    ...marketSignalDefaults,
    ...(hasNestedGroups ? sanitizePackMap(rawValue.marketSignals) : {})
  };

  if (!marketSignals.tickers) {
    marketSignals.tickers = normalizedTickerQuery;
  }
  if (!marketSignals.priceAction) {
    marketSignals.priceAction = DEFAULT_MARKET_PRICE_ACTION_QUERY;
  }

  const sanitizedEditorial = sanitizePackMap(editorial);
  const sanitizedMarketSignals = sanitizePackMap(marketSignals);

  return {
    editorial: sanitizedEditorial,
    marketSignals: sanitizedMarketSignals,
    flattened: {
      ...sanitizedEditorial,
      ...sanitizedMarketSignals
    }
  };
}

export { DEFAULT_MARKET_PRICE_ACTION_QUERY };
