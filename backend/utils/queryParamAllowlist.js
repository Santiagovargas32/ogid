const ROUTE_QUERY_PARAMS = new Map(
  Object.entries({
    "GET /api/health": [],
    "GET /api/country-instability": ["countries", "force"],

    "GET /api/admin/api-limits": [],
    "GET /api/admin/news-raw": ["dataset", "page", "pageSize"],
    "GET /api/admin/pipeline-status": [],

    "GET /api/intel/snapshot": ["countries", "sources", "limit"],
    "POST /api/intel/refresh": ["countries"],
    "GET /api/intel/hotspots": ["countries", "sources", "limit"],
    "GET /api/intel/risks": ["countries", "sources", "limit"],
    "GET /api/intel/news": ["countries", "sources", "limit"],
    "GET /api/intel/insights": ["countries", "sources", "limit"],
    "GET /api/intel/hotspots-v2": ["countries", "force", "maxEvents"],
    "GET /api/intel/anomalies": ["activeWindowHours", "baselineDays"],

    "GET /api/map/config": [],
    "GET /api/map/layers": ["layers", "timeWindow", "countries", "bbox", "limit", "preset", "force"],
    "GET /api/map/presets": [],
    "GET /api/map/themes": [],

    "GET /api/market/quotes": ["tickers"],
    "GET /api/market/impact": ["tickers", "countries", "windowMin"],
    "GET /api/market/analytics": ["tickers", "countries", "windowMin"],

    "GET /api/media/streams": ["force"],
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

export function queryParamAllowlist(req, res, next) {
  const method = req.method === "HEAD" ? "GET" : req.method;
  const routeKey = `${method} ${normalizeApiPath(req.originalUrl)}`;
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

export function listAllowedQueryParams() {
  return Object.fromEntries(
    [...ROUTE_QUERY_PARAMS.entries()].map(([route, params]) => [route, [...params].sort()])
  );
}
