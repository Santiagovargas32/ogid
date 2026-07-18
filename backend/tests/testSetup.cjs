const APPLICATION_ENV_PREFIXES = ["NEWS_", "NEWSAPI_", "GNEWS_", "MEDIA_", "MEDIASTACK_", "GDELT_", "MARKET_", "TWELVE_", "TWELVEDATA_", "YOUTUBE_", "WATCHLIST_", "REFRESH_", "MANUAL_", "WS_", "IMPACT_", "ADMIN_"];
const APPLICATION_ENV_KEYS = new Set(["PORT", "LOG_LEVEL", "ALLOW_LOCAL_ADMIN", "DISABLE_BACKGROUND_REFRESH"]);

for (const key of Object.keys(process.env)) {
  if (APPLICATION_ENV_KEYS.has(key) || APPLICATION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key];
}
process.env.NODE_ENV = "test";
process.env.DISABLE_BACKGROUND_REFRESH = "1";

const testMetadataSource = { provider: "test-fixture", verifiedAt: "2026-07-16" };
const testEquity = (instrumentId, symbol, displayName, {
  rolloutBatch = 1,
  refreshTier = "hot",
  minRefreshIntervalMs = 300_000,
  exchange = "New York Stock Exchange",
  mic = "XNYS"
} = {}) => ({
  instrumentId,
  canonicalSymbol: symbol,
  displayName,
  assetType: "equity",
  exchange,
  mic,
  currency: "USD",
  timezone: "America/New_York",
  country: "US",
  enabled: true,
  rolloutBatch,
  refreshTier,
  minRefreshIntervalMs,
  verificationStatus: "verified",
  sessionPolicy: "nyse-equities",
  providerSymbols: { twelve: symbol, yahoo: symbol },
  aliases: [symbol],
  metadataSource: testMetadataSource,
  dynamic: false
});

globalThis.__OGID_TEST_MARKET_INSTRUMENTS__ = [
  testEquity("us-equity-general-dynamics", "GD", "General Dynamics Corporation"),
  testEquity("us-equity-boeing", "BA", "The Boeing Company"),
  testEquity("us-equity-northrop-grumman", "NOC", "Northrop Grumman Corporation"),
  testEquity("us-equity-lockheed-martin", "LMT", "Lockheed Martin Corporation"),
  testEquity("us-equity-rtx", "RTX", "RTX Corporation"),
  testEquity("us-equity-exxon-mobil", "XOM", "Exxon Mobil Corporation"),
  testEquity("us-equity-chevron", "CVX", "Chevron Corporation"),
  testEquity("us-equity-leidos", "LDOS", "Leidos Holdings, Inc.", { rolloutBatch: 2, refreshTier: "background", minRefreshIntervalMs: 3_600_000 }),
  testEquity("us-equity-huntington-ingalls", "HII", "Huntington Ingalls Industries, Inc.", { rolloutBatch: 2, refreshTier: "background", minRefreshIntervalMs: 3_600_000 }),
  testEquity("us-equity-nvidia", "NVDA", "NVIDIA Corporation", { rolloutBatch: 3, refreshTier: "background", minRefreshIntervalMs: 23_400_000, exchange: "Nasdaq Stock Market", mic: "XNAS" }),
  testEquity("us-equity-apple", "AAPL", "Apple Inc.", { rolloutBatch: 3, refreshTier: "background", minRefreshIntervalMs: 23_400_000, exchange: "Nasdaq Stock Market", mic: "XNAS" }),
  testEquity("us-equity-advanced-micro-devices", "AMD", "Advanced Micro Devices, Inc.", { rolloutBatch: 3, refreshTier: "background", minRefreshIntervalMs: 23_400_000, exchange: "Nasdaq Stock Market", mic: "XNAS" }),
  testEquity("us-equity-oracle", "ORCL", "Oracle Corporation", { rolloutBatch: 3, refreshTier: "background", minRefreshIntervalMs: 23_400_000 }),
  testEquity("us-equity-alphabet-class-a", "GOOGL", "Alphabet Inc. Class A", { rolloutBatch: 3, refreshTier: "background", minRefreshIntervalMs: 23_400_000, exchange: "Nasdaq Stock Market", mic: "XNAS" }),
  testEquity("us-equity-microsoft", "MSFT", "Microsoft Corporation", { rolloutBatch: 3, refreshTier: "background", minRefreshIntervalMs: 23_400_000, exchange: "Nasdaq Stock Market", mic: "XNAS" }),
  {
    ...testEquity("us-etf-invesco-qqq", "QQQ", "Invesco QQQ Trust", { rolloutBatch: 3, refreshTier: "background", minRefreshIntervalMs: 23_400_000, exchange: "Nasdaq Stock Market", mic: "XNAS" }),
    assetType: "etf"
  },
  {
    ...testEquity("us-etf-energy-select-sector-spdr", "XLE", "Energy Select Sector SPDR Fund", { rolloutBatch: 3, refreshTier: "background", minRefreshIntervalMs: 3_600_000, exchange: "NYSE Arca", mic: "ARCX" }),
    assetType: "etf"
  },
  {
    instrumentId: "crypto-bitcoin-us-dollar",
    canonicalSymbol: "BTC/USD",
    displayName: "Bitcoin / US Dollar",
    assetType: "crypto",
    exchange: "Multiple cryptocurrency venues",
    mic: null,
    currency: "USD",
    timezone: "UTC",
    country: "GLOBAL",
    enabled: true,
    rolloutBatch: 3,
    refreshTier: "background",
    minRefreshIntervalMs: 14_400_000,
    verificationStatus: "verified",
    sessionPolicy: "24x7",
    providerSymbols: { twelve: "BTC/USD", yahoo: "BTC-USD" },
    aliases: ["BTC/USD", "BTC-USD"],
    metadataSource: testMetadataSource,
    dynamic: false
  }
];

const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const target = new URL(url instanceof Request ? url.url : String(url));
  if (["127.0.0.1", "localhost", "::1"].includes(target.hostname)) return nativeFetch(url, options);
  throw new Error(`external-http-disabled-in-tests:${target.hostname}`);
};
