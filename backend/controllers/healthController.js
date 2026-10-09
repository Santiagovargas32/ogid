import { BACKEND_BUILD } from "../utils/buildIdentity.js";
import stateManager from "../state/stateManager.js";

export function getHealth(_req, res) {
  const socketServer = res.app.locals.socketServer;
  const config = res.app.locals.config;
  const orchestrator = res.app.locals.orchestrator;
  const storage=res.app.locals.storageManager?.getStatus?.() || null;
  const meta = stateManager.getMeta();
  const snapshot = { market: stateManager.state.market };
  const quoteCount = Object.keys(snapshot?.market?.quotes || {}).length;
  const websocket = socketServer?.getHealth?.() || {
    clientCount: socketServer?.clientCount?.() ?? 0,
    path: config?.wsPath || "/ws",
    heartbeatMs: config?.wsHeartbeatMs ?? null,
    activeConnections: [],
    lastConnection: null,
    lastDisconnection: null
  };

  res.json({
    ok: true,
    data: {
      status:storage&&!["ready","disabled"].includes(storage.state)?"degraded":"ok",
      storage,
      server:{pid:process.pid,nodeVersion:process.version,startedAt:new Date(Date.now()-process.uptime()*1000).toISOString(),memory:process.memoryUsage()},
      build: BACKEND_BUILD,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      websocketClients: websocket.clientCount ?? 0,
      websocket,
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
        historicalPersistence: orchestrator?.getMarketHistoryStatus?.() || null
      }
    }
  });
}
