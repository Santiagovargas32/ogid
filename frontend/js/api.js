function buildPath(path, params = {}) {
  const url = new URL(path, window.location.origin);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      url.searchParams.set(key, value.join(","));
      continue;
    }
    url.searchParams.set(key, value);
  }

  return `${url.pathname}${url.search}`;
}

async function request(path, params = {}, options = {}) {
  const method = options.method || "GET";
  const headers = {
    Accept: "application/json",
    ...(options.headers || {})
  };

  if (options.body !== undefined && !("Content-Type" in headers)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(buildPath(path, params), {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || `Request failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload?.error?.code || null;
    error.details = payload?.error?.details || null;
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") || "", 10);
    error.retryAfterSec = Number.isFinite(retryAfter) ? retryAfter : null;
    throw error;
  }

  return payload?.data;
}

export const api = {
  getHealth: () => request("/api/health"),
  getMapConfig: () => request("/api/map/config"),
  getMapLayers: (params = {}) => request("/api/map/layers", params),
  getMapPresets: () => request("/api/map/presets"),
  getMapThemes: () => request("/api/map/themes"),
  getSnapshot: (params = {}) => request("/api/intel/snapshot", params),
  refreshIntel: (payload = {}) => request("/api/intel/refresh", {}, { method: "POST", body: payload }),
  getHotspots: (params = {}) => request("/api/intel/hotspots", params),
  getHotspotsV2: (params = {}) => request("/api/intel/hotspots-v2", params),
  getRisks: (params = {}) => request("/api/intel/risks", params),
  getNews: (params = {}) => request("/api/intel/news", params),
  getAggregateNews: (params = {}) => request("/api/news/aggregate", params),
  getMediaStreams: (params = {}) => request("/api/media/streams", params),
  getInsights: (params = {}) => request("/api/intel/insights", params),
  getCountryInstability: (params = {}) => request("/api/country-instability", params),
  getIntelAnomalies: (params = {}) => request("/api/intel/anomalies", params),
  getMarketQuotes: (params = {}) => request("/api/market/quotes", params),
  getMarketImpact: (params = {}) => request("/api/market/impact", params),
  getMarketAnalytics: (params = {}) => request("/api/market/analytics", params),
  getApiLimits: () => request("/api/admin/api-limits"),
  getPipelineStatus: () => request("/api/admin/pipeline-status"),
  getAdminNewsRaw: (params = {}) => request("/api/admin/news-raw", params)
};
