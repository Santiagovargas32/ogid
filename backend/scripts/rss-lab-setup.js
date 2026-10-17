import { createRssLabFetchGuard, parseRssLabFeeds } from "./rss-lab.js";

function boundedInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function applyRssLabEnvironment({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const feeds = parseRssLabFeeds(env.NEWS_RSS_FEEDS);
  const port = boundedInteger(env.PORT, 8081, { min: 1, max: 65_535 });
  const timeoutMs = 8_000;
  Object.assign(env, {
    NODE_ENV:"test",PORT:String(port),NEWS_PROVIDERS:"rss",MARKET_PROVIDER:"",MARKET_PROVIDER_FALLBACK:"",
    NEWS_API_KEY:"",GNEWS_API_KEY:"",MEDIASTACK_API_KEY:"",YOUTUBE_API_KEY:"",MARKET_TWELVE_API_KEY:"",
    AI_PROVIDER:"none",AI_MODE:"off",AWARENESS_MODE:"off"
  });

  globalThis.fetch = createRssLabFetchGuard({ feeds, fetchImpl });
  return {
    port,
    timeoutMs,
    options:{
      port,disableBackgroundRefresh:true,
      news:{providers:["rss"],rssFeeds:feeds,rssDisabledFeeds:[],rssPipelineMode:"legacy",timeoutMs,
        intervalMs:3600000,rssAggregateIntervalMs:3600000,rssAggregateFeedsPerRun:feeds.length,rssAggregateMaxItems:250,rssGlobalConcurrency:2,rssHostConcurrency:1},
      market:{enabled:false,provider:"",fallbackProvider:"",historyPersist:false,dailyCandles:{enabled:false},intradayCandles:{enabled:false}},
      ai:{provider:"none",mode:"off"},awareness:{mode:"off"},
      manualRefresh:{cooldownMs:300000,perClientWindowMs:3600000,perClientMax:4}
    },
    feeds: feeds.map((feed) => ({ label: feed.label, hostname: new URL(feed.url).hostname }))
  };
}

export const profile = applyRssLabEnvironment();
process.stderr.write(`${JSON.stringify({
  event: "rss_lab_profile_ready",
  port: profile.port,
  feedCount: profile.feeds.length,
  hosts: [...new Set(profile.feeds.map((feed) => feed.hostname))],
  backgroundRefresh: false,
  marketProvider: null
})}\n`);
