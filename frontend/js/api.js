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

const pageController = new AbortController();
window.addEventListener("pagehide", () => pageController.abort(), { once: true });

export async function request(path, params = {}, options = {}) {
  const method = options.method || "GET";
  const headers = {
    Accept: "application/json",
    ...(options.headers || {})
  };

  if (options.body !== undefined && !("Content-Type" in headers)) {
    headers["Content-Type"] = "application/json";
  }

  const signal = AbortSignal.any([pageController.signal, options.signal || new AbortController().signal, AbortSignal.timeout(options.timeoutMs ?? 12_000)]);
  try {
  const response = await fetch(buildPath(path, params), {
    method,
    headers,
    cache: options.cache || "default",
    signal,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json().catch(error => {
    if (signal.aborted) throw error;
    throw Object.assign(new Error("Respuesta JSON inválida."), { status: response.status, code: "INVALID_RESPONSE", cause: error });
  });
  if (!response.ok) {
    const message = [401, 403].includes(response.status)
      ? "Acceso administrativo no autorizado. Usa una ruta LAN autorizada o el proxy autenticado configurado por el operador."
      : payload?.error?.message || `Request failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload?.error?.code || null;
    error.details = payload?.error?.details || null;
    const retryHeader = response.headers.get("Retry-After");
    const retryAfter = /^\d+$/.test(retryHeader || "") ? Number(retryHeader) : Math.max(0, (Date.parse(retryHeader) - Date.now()) / 1000);
    error.retryAfterSec = Number.isFinite(retryAfter) ? retryAfter : null;
    throw error;
  }

  return payload?.data;
  } catch (error) {
    if (signal.aborted) {
      const timedOut = signal.reason?.name === "TimeoutError";
      throw Object.assign(new Error(timedOut ? "La petición excedió su tiempo de espera." : "Petición cancelada."), { code: timedOut ? "REQUEST_TIMEOUT" : "REQUEST_CANCELLED", cause: error });
    }
    throw error;
  }
}

export const api = {
  getHealth: (options = {}) => request("/api/health", {}, options),
  getSnapshot: (params = {}, options = {}) => request("/api/intel/snapshot", params, options),
  getAdvancedIntelligenceSnapshot: (params = {}, options = {}) => request("/api/intel/advanced-snapshot", params, { ...options, cache: "no-store" }),
  getAwarenessSnapshot: () => request("/api/intel/awareness-snapshot", {}, { cache: "no-store" }),
  refreshIntel: (payload = {}) => request("/api/intel/refresh", {}, { method: "POST", body: payload }),
  getHotspotsV2: (params = {}, options = {}) => request("/api/intel/hotspots-v2", params, options),
  getNews: (params = {}, options = {}) => request("/api/intel/news", params, options),
  getAggregateNews: (params = {}, options = {}) => request("/api/news/aggregate", params, options),
  getMediaStreams: (params = {}, options = {}) => request("/api/media/streams", params, options),
  getCountryInstability: (params = {}, options = {}) => request("/api/country-instability", params, options),
  getIntelAnomalies: (params = {}, options = {}) => request("/api/intel/anomalies", params, options),
  getMarketQuotes: (params = {}, options = {}) => request("/api/market/quotes", params, options),
  getMarketProviderStatus: () => request("/api/market/provider-status"),
  getMarketInstrumentSearch: (params = {}, options = {}) => request("/api/market/instruments/search", params, options),
  getMarketWatchlist: () => request("/api/market/watchlist"),
  updateMarketWatchlist: (instrumentIds) => request("/api/market/watchlist", {}, { method: "PUT", body: { instrumentIds } }),
  getMarketCandles: (params = {}, options = {}) => request("/api/market/candles", params, { ...options, cache: "no-store" }),
  getMarketConditions: (params = {}, options = {}) => request("/api/market/conditions", params, { ...options, cache: "no-store" }),
  getMarketAnalytics: (params = {}, options = {}) => request("/api/market/analytics", params, options),
  getApiLimits: (options = {}) => request("/api/admin/api-limits", {}, options),
  getPipelineStatus: (options = {}) => request("/api/admin/pipeline-status", {}, options),
  getAdminNewsRaw: (params = {}, options = {}) => request("/api/admin/news-raw", params, options),
  getAdminAiEnrichments: (params = {}, options = {}) => request("/api/admin/ai-enrichments", params, options),
  refreshMediaStreams: (payload = {}) => request("/api/media/streams/refresh", {}, { method: "POST", body: payload }),
  getMediaStreamsHealth: (options = {}) => request("/api/media/streams/health", {}, options)
};
