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

function buildBoundedOrQueryPlan(terms = [], maxLength = FINANCIAL_QUERY_MAX_LENGTH) {
  const limit = normalizeFinancialQueryLimit(maxLength);
  const seen = new Set();
  const formatted = terms.map((term) => ({ term, formatted: formatFinancialQueryTerm(term) })).filter(({ formatted: value }) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
  const accepted = [];

  for (const entry of formatted) {
    const candidate = [...accepted.map(({ formatted: value }) => value), entry.formatted].join(" OR ");
    if (candidate.length > limit) {
      continue;
    }
    accepted.push(entry);
  }

  return {
    query: accepted.map(({ formatted: value }) => value).join(" OR "),
    acceptedTerms: accepted.map(({ term }) => term)
  };
}

function buildBoundedOrQuery(terms = [], maxLength = FINANCIAL_QUERY_MAX_LENGTH) {
  return buildBoundedOrQueryPlan(terms, maxLength).query;
}

function normalizeFinancialTickers(tickers = []) {
  return [...new Set((Array.isArray(tickers) ? tickers : [])
    .map((ticker) => String(ticker || "").trim().toUpperCase())
    .filter((ticker) => ticker && /^[A-Z0-9.^=:_-]+$/.test(ticker)))];
}

function rotateFinancialTickers(tickers, offset = 0) {
  if (!tickers.length) return [];
  const parsed = Number.parseInt(String(offset ?? 0), 10);
  const start = Number.isFinite(parsed) ? ((parsed % tickers.length) + tickers.length) % tickers.length : 0;
  return [...tickers.slice(start), ...tickers.slice(0, start)];
}

function buildCorporateWatchlistQueryPlan(tickers, maxLength, tickerOffset = 0) {
  const normalizedTickers = normalizeFinancialTickers(tickers);
  const rotatedTickers = rotateFinancialTickers(normalizedTickers, tickerOffset);
  const tickerBudget = normalizedTickers.length ? Math.max(16, Math.floor(maxLength * 0.3)) : 0;
  const tickerPlan = tickerBudget ? buildBoundedOrQueryPlan(rotatedTickers, tickerBudget) : { query: "", acceptedTerms: [] };
  const tickerQuery = tickerPlan.query;
  const queriedTickers = tickerPlan.acceptedTerms;
  const syntaxBudget = tickerQuery ? "() AND ()".length : 2;
  const corporateQuery = buildBoundedOrQuery(FINANCIAL_QUERY_TERMS.corporate, Math.max(1, maxLength - tickerQuery.length - syntaxBudget));
  if (!corporateQuery) {
    return { query: "", queriedTickers: [], omittedTickers: normalizedTickers, tickerOffset: Number(tickerOffset) || 0 };
  }

  const corporateClause = `(${corporateQuery})`;
  return {
    query: tickerQuery ? `(${tickerQuery}) AND ${corporateClause}` : corporateClause,
    queriedTickers,
    omittedTickers: normalizedTickers.filter((ticker) => !queriedTickers.includes(ticker)),
    tickerOffset: Number(tickerOffset) || 0
  };
}

export function buildFinancialNewsQueryPlan({
  marketTickers = [],
  watchlistTickers = [],
  maxQueryLength = FINANCIAL_QUERY_MAX_LENGTH,
  tickerOffset = 0
} = {}) {
  const boundedLength = normalizeFinancialQueryLimit(maxQueryLength);
  const tickers = Array.isArray(watchlistTickers) && watchlistTickers.length
    ? watchlistTickers
    : marketTickers;
  const corporate = buildCorporateWatchlistQueryPlan(tickers, boundedLength, tickerOffset);

  return {
    packs: {
      macro: buildBoundedOrQuery(FINANCIAL_QUERY_TERMS.macro, boundedLength),
      market: buildBoundedOrQuery(FINANCIAL_QUERY_TERMS.market, boundedLength),
      "corporate-watchlist": corporate.query,
      regulatory: buildBoundedOrQuery(FINANCIAL_QUERY_TERMS.regulatory, boundedLength)
    },
    corporateCoverage: {
      queriedTickers: corporate.queriedTickers,
      omittedTickers: corporate.omittedTickers,
      tickerOffset: corporate.tickerOffset
    }
  };
}

export function buildFinancialNewsQueryPacks(options = {}) {
  return buildFinancialNewsQueryPlan(options).packs;
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
