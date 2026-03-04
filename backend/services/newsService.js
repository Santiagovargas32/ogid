import { fetchAggregatedNews } from "./news/newsAggregatorService.js";

export async function fetchRawNews({
  providers,
  newsApiKey,
  newsApiBaseUrl,
  gnewsApiKey,
  gnewsBaseUrl,
  mediastackApiKey,
  mediastackBaseUrl,
  query,
  language,
  pageSize,
  countries,
  timeoutMs = 9_000
}) {
  return fetchAggregatedNews({
    providers,
    newsApiKey,
    newsApiBaseUrl,
    gnewsApiKey,
    gnewsBaseUrl,
    mediastackApiKey,
    mediastackBaseUrl,
    query,
    language,
    pageSize,
    countries,
    timeoutMs
  });
}
