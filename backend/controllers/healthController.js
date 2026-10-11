import { BACKEND_BUILD } from "../utils/buildIdentity.js";
import stateManager from "../state/stateManager.js";
import { isAdminAuthorized } from "../middleware/sensitiveRouteAuth.js";

export function getHealth(req, res) {
  const socketServer = res.app.locals.socketServer;
  const config = res.app.locals.config;
  const orchestrator = res.app.locals.orchestrator;
  const meta = stateManager.getMeta();
  const snapshot = stateManager.getSnapshot();
  const quoteCount = Object.keys(snapshot?.market?.quotes || {}).length;
  const websocket = socketServer?.getHealth?.() || {
    clientCount: socketServer?.clientCount?.() ?? 0,
    path: config?.wsPath || "/ws",
    heartbeatMs: config?.wsHeartbeatMs ?? null,
    activeConnections: [],
    lastConnection: null,
    lastDisconnection: null
  };
  const administrative = isAdminAuthorized(req, config?.security);
  const publicWebsocket = { clientCount:websocket.clientCount, path:websocket.path, heartbeatMs:websocket.heartbeatMs,
    metrics:websocket.metrics, activeConnections:[], lastConnection:null, lastDisconnection:null };
  const persistence = orchestrator?.getMarketHistoryStatus?.() || null;

  res.json({
    ok: true,
    data: {
      status: "ok",
      build: BACKEND_BUILD,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      websocketClients: websocket.clientCount ?? 0,
      websocket: administrative ? websocket : publicWebsocket,
      lastRefreshAt: meta.lastRefreshAt,
      refreshIntervalMs: meta.refreshIntervalMs,
      sourceMode: meta.sourceMode,
      dataQuality: meta.dataQuality || {},
      watchlistCountries: meta.watchlistCountries || [],
      market: {
        availability: quoteCount ? "available" : "empty",
        quoteCount,
        selectedInstrumentCount: config?.market?.tickers?.length || 0,
        configuredProvider: config?.market?.provider || null,
        configuredFallbackProvider: config?.market?.fallbackProvider || null,
        providerChain: snapshot?.market?.sourceMeta?.providerChain || config?.market?.providerChain || null,
        effectiveProvider: snapshot?.market?.sourceMeta?.effectiveProvider || snapshot?.market?.provider || null,
        providerScore: snapshot?.market?.sourceMeta?.providerScore ?? null,
        providerLatencyMs: snapshot?.market?.sourceMeta?.providerLatencyMs ?? null,
        revision: snapshot?.market?.revision || null,
        session: snapshot?.market?.session || null,
        historicalPersistence: administrative ? persistence : persistence && { enabled:persistence.enabled, lastLoadedAt:persistence.lastLoadedAt, lastSavedAt:persistence.lastSavedAt }
      }
    }
  });
}
