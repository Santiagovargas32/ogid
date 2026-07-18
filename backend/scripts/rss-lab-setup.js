import { createRssLabFetchGuard, parseRssLabFeeds, serializeRssLabFeeds } from "./rss-lab.js";

function boundedInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function applyRssLabEnvironment({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const feeds = parseRssLabFeeds(env.NEWS_RSS_FEEDS);
  const port = boundedInteger(env.PORT, 8081, { min: 1, max: 65_535 });
  const timeoutMs = boundedInteger(env.NEWS_TIMEOUT_MS, 8_000, { min: 500, max: 15_000 });

  Object.assign(env, {
    NODE_ENV: "test",
    PORT: String(port),
    ADMIN_API_TOKEN: "",
    ALLOW_LOCAL_ADMIN: "1",
    NEWS_API_KEY: "",
    GNEWS_API_KEY: "",
    MEDIASTACK_API_KEY: "",
    YOUTUBE_API_KEY: "",
    MARKET_TWELVE_API_KEY: "",
    TWELVE_DATA_API_KEY: "",
    TWELVEDATA_API_KEY: "",
    NEWS_PROVIDERS: "rss",
    NEWS_RSS_FEEDS: serializeRssLabFeeds(feeds),
    NEWS_RSS_DISABLED_FEEDS: "",
    NEWS_RSS_PIPELINE_MODE: "legacy",
    NEWS_RSS_AGGREGATE_FEEDS_PER_RUN: String(feeds.length),
    NEWS_RSS_AGGREGATE_MAX_ITEMS: "250",
    NEWS_RSS_AGGREGATE_INTERVAL_MS: "3600000",
    NEWS_RSS_GLOBAL_CONCURRENCY: "2",
    NEWS_RSS_HOST_CONCURRENCY: "1",
    NEWS_TIMEOUT_MS: String(timeoutMs),
    NEWS_INTERVAL_MS: "3600000",
    REFRESH_INTERVAL_MS: "3600000",
    DISABLE_BACKGROUND_REFRESH: "1",
    MANUAL_REFRESH_COOLDOWN_MS: "300000",
    MANUAL_REFRESH_PER_CLIENT_WINDOW_MS: "3600000",
    MANUAL_REFRESH_PER_CLIENT_MAX: "4",
    MARKET_PROVIDER: "",
    MARKET_PROVIDER_FALLBACK: "",
    MARKET_TICKERS: "",
    MARKET_HISTORY_PERSIST: "0",
    MARKET_DAILY_CANDLES_ENABLED: "0",
    MARKET_INTRADAY_CANDLES_ENABLED: "0"
  });

  globalThis.fetch = createRssLabFetchGuard({ feeds, fetchImpl });
  return {
    port,
    timeoutMs,
    feeds: feeds.map((feed) => ({ label: feed.label, hostname: new URL(feed.url).hostname }))
  };
}

const profile = applyRssLabEnvironment();
process.stderr.write(`${JSON.stringify({
  event: "rss_lab_profile_ready",
  port: profile.port,
  feedCount: profile.feeds.length,
  hosts: [...new Set(profile.feeds.map((feed) => feed.hostname))],
  backgroundRefresh: false,
  marketProvider: null
})}\n`);
