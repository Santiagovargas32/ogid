import { fetchAggregatedNews } from "./news/newsAggregatorService.js";

export async function fetchRawNews({
  providers,
  newsApiKey,
  newsApiBaseUrl,
  gnewsApiKey,
  gnewsBaseUrl,
  mediastackApiKey,
  mediastackBaseUrl,
  gdeltBaseUrl,
  rssFeeds,
  query,
  queryPacks,
  marketTickers,
  language,
  pageSize,
  countries,
  sourceAllowlist,
  domainAllowlist,
  timeoutMs = 9_000,
  allowExhaustedProviders = true
}) {
  return fetchAggregatedNews({
    providers,
    newsApiKey,
    newsApiBaseUrl,
    gnewsApiKey,
    gnewsBaseUrl,
    mediastackApiKey,
    mediastackBaseUrl,
    gdeltBaseUrl,
    rssFeeds,
    query,
    queryPacks,
    marketTickers,
    language,
    pageSize,
    countries,
    sourceAllowlist,
    domainAllowlist,
    timeoutMs,
    allowExhaustedProviders
  });
}
