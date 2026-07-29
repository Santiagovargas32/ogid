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

export const FINANCIAL_QUERY_MAX_LENGTH = 500;

const FINANCIAL_QUERY_TERMS = Object.freeze({
  macro: Object.freeze([
    "Federal Reserve",
    "FOMC",
    "interest rate decision",
    "monetary policy",
    "central bank",
    "rate hike",
    "rate cut",
    "inflation",
    "consumer price index",
    "producer price index",
    "PCE inflation",
    "nonfarm payrolls",
    "unemployment rate",
    "gross domestic product",
    "economic outlook"
  ]),
  market: Object.freeze([
    "stock market",
    "shares",
    "equities",
    "bond market",
    "Treasury yields",
    "foreign exchange",
    "commodities",
    "oil prices",
    "gold prices",
    "Bitcoin",
    "cryptocurrency",
    "futures",
    "volatility",
    "premarket",
    "after hours",
    "selloff",
    "rally"
  ]),
  corporate: Object.freeze([
    "earnings",
    "quarterly results",
    "revenue",
    "profit warning",
    "guidance",
    "merger",
    "acquisition",
    "initial public offering",
    "share buyback",
    "dividend",
    "bankruptcy",
    "credit rating",
    "analyst upgrade",
    "analyst downgrade",
    "price target"
  ]),
  regulatory: Object.freeze([
    "Securities and Exchange Commission",
    "SEC enforcement",
    "Commodity Futures Trading Commission",
    "CFTC",
    "financial regulator",
    "antitrust",
    "enforcement action",
    "regulatory approval",
    "regulatory filing",
    "market manipulation",
    "insider trading",
    "trading halt",
    "compliance rule"
  ])
});

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

function normalizeFinancialQueryLimit(value) {
  const parsed = Number.parseInt(String(value ?? FINANCIAL_QUERY_MAX_LENGTH), 10);
  return Math.max(1, Math.min(FINANCIAL_QUERY_MAX_LENGTH, Number.isFinite(parsed) ? parsed : FINANCIAL_QUERY_MAX_LENGTH));
}

function formatFinancialQueryTerm(value) {
  const normalized = String(value || "")
    .replace(/["()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  return /[^A-Za-z0-9]/.test(normalized) ? `"${normalized}"` : normalized;
}

function buildBoundedOrQuery(terms = [], maxLength = FINANCIAL_QUERY_MAX_LENGTH) {
  const limit = normalizeFinancialQueryLimit(maxLength);
  const formatted = [...new Set(terms.map(formatFinancialQueryTerm).filter(Boolean))];
  const accepted = [];

  for (const term of formatted) {
    const candidate = [...accepted, term].join(" OR ");
    if (candidate.length > limit) {
      continue;
    }
    accepted.push(term);
  }

  return accepted.join(" OR ");
}

function normalizeFinancialTickers(tickers = []) {
  return [...new Set((Array.isArray(tickers) ? tickers : [])
    .map((ticker) => String(ticker || "").trim().toUpperCase())
    .filter((ticker) => ticker && /^[A-Z0-9.^=:_-]+$/.test(ticker)))];
}

function buildCorporateWatchlistQuery(tickers, maxLength) {
  const normalizedTickers = normalizeFinancialTickers(tickers);
  const tickerBudget = normalizedTickers.length ? Math.max(16, Math.floor(maxLength * 0.3)) : 0;
  const tickerQuery = tickerBudget ? buildBoundedOrQuery(normalizedTickers, tickerBudget) : "";
  const syntaxBudget = tickerQuery ? "() AND ()".length : 2;
  const corporateQuery = buildBoundedOrQuery(FINANCIAL_QUERY_TERMS.corporate, Math.max(1, maxLength - tickerQuery.length - syntaxBudget));
  if (!corporateQuery) {
    return "";
  }

  const corporateClause = `(${corporateQuery})`;
  return tickerQuery ? `(${tickerQuery}) AND ${corporateClause}` : corporateClause;
}

export function buildFinancialNewsQueryPacks(
  { marketTickers = [], watchlistTickers = [], maxQueryLength = FINANCIAL_QUERY_MAX_LENGTH } = {}
) {
  const boundedLength = normalizeFinancialQueryLimit(maxQueryLength);
  const tickers = Array.isArray(watchlistTickers) && watchlistTickers.length
    ? watchlistTickers
    : marketTickers;

  return {
    macro: buildBoundedOrQuery(FINANCIAL_QUERY_TERMS.macro, boundedLength),
    market: buildBoundedOrQuery(FINANCIAL_QUERY_TERMS.market, boundedLength),
    "corporate-watchlist": buildCorporateWatchlistQuery(tickers, boundedLength),
    regulatory: buildBoundedOrQuery(FINANCIAL_QUERY_TERMS.regulatory, boundedLength)
  };
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
