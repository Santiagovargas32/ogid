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

async function request(path, params = {}) {
  const response = await fetch(buildPath(path, params), {
    headers: {
      Accept: "application/json"
    }
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return payload?.data;
}

export const api = {
  getHealth: () => request("/api/health"),
  getSnapshot: (params = {}) => request("/api/intel/snapshot", params),
  getHotspots: (params = {}) => request("/api/intel/hotspots", params),
  getRisks: (params = {}) => request("/api/intel/risks", params),
  getNews: (params = {}) => request("/api/intel/news", params),
  getInsights: (params = {}) => request("/api/intel/insights", params),
  getMarketQuotes: (params = {}) => request("/api/market/quotes", params),
  getMarketImpact: (params = {}) => request("/api/market/impact", params),
  getMarketAnalytics: (params = {}) => request("/api/market/analytics", params),
  getApiLimits: () => request("/api/admin/api-limits")
};
