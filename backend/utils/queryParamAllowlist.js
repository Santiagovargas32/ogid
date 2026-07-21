const ROUTE_QUERY_PARAMS = new Map(
  Object.entries({
    "GET /api/health": [],
    "GET /api/country-instability": ["countries", "force", "windowHours", "maxEvents", "activeWindowHours", "baselineDays"],

    "GET /api/admin/api-limits": [],
    "GET /api/admin/news-raw": ["dataset", "page", "pageSize"],
    "GET /api/admin/pipeline-status": [],
    "GET /api/admin/ai-enrichments": ["status", "kind", "page", "pageSize"],

    "GET /api/intel/snapshot": ["countries", "sources", "limit"],
    "POST /api/intel/refresh": ["countries"],
    "GET /api/intel/hotspots": ["countries", "sources", "limit"],
    "GET /api/intel/risks": ["countries", "sources", "limit"],
    "GET /api/intel/news": ["countries", "sources", "limit"],
    "GET /api/intel/insights": ["countries", "sources", "limit"],
    "GET /api/intel/advanced-snapshot": ["countries", "force", "windowHours", "activeWindowHours", "baselineDays"],
    "GET /api/intel/country-instability": ["countries", "force", "windowHours", "maxEvents", "activeWindowHours", "baselineDays"],
    "GET /api/intel/hotspots-v2": ["countries", "force", "windowHours", "maxEvents", "activeWindowHours", "baselineDays"],
    "GET /api/intel/anomalies": ["countries", "windowHours", "maxEvents", "activeWindowHours", "baselineDays"],

    "GET /api/map/config": [],
    "GET /api/map/layers": ["layers", "timeWindow", "countries", "bbox", "limit", "preset", "force"],
    "GET /api/map/presets": [],
    "GET /api/map/themes": [],

    "GET /api/market/quotes": ["tickers"],
    "GET /api/market/provider-status": [],
    "GET /api/market/instruments/search": ["q", "limit"],
    "GET /api/market/candles": ["instrumentId", "interval", "from", "to", "limit", "adjusted"],
    "GET /api/market/indicators": ["instrumentId", "interval", "adjusted"],
    "GET /api/market/impact": ["tickers", "countries", "windowMin", "couplingInterval", "couplingWindows", "benchmarkInstrumentId"],
    "GET /api/market/analytics": ["tickers", "countries", "windowMin", "couplingInterval", "couplingWindows", "benchmarkInstrumentId"],

    "GET /api/media/streams": ["force", "resolve", "ids"],
    "GET /api/media/streams/health": [],
    "GET /api/media/streams/:id": ["force", "resolve"],
    "POST /api/media/streams/refresh": [],
    "GET /api/news/aggregate": ["countries", "force", "topic", "threat", "limit"]
  }).map(([route, params]) => [route, new Set(params)])
);

function normalizeApiPath(originalUrl = "") {
  const pathname = new URL(originalUrl || "/", "http://local").pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function normalizeRouteKey(method, originalUrl = "") {
  const path = normalizeApiPath(originalUrl);
  const mediaStreamItemMatch = path.match(/^\/api\/media\/streams\/[^/]+$/);
  if (method === "GET" && mediaStreamItemMatch && path !== "/api/media/streams/health") {
    return `${method} /api/media/streams/:id`;
  }
  return `${method} ${path}`;
}

export function queryParamAllowlist(req, res, next) {
  const method = req.method === "HEAD" ? "GET" : req.method;
  const routeKey = normalizeRouteKey(method, req.originalUrl);
  const allowedParams = ROUTE_QUERY_PARAMS.get(routeKey);

  if (!allowedParams) {
    next();
    return;
  }

  const unexpectedParams = Object.keys(req.query || {}).filter((key) => !allowedParams.has(key));
  if (unexpectedParams.length) {
    res.status(404).json({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found",
        details: null,
        requestId: req.requestId
      }
    });
    return;
  }

  next();
}
