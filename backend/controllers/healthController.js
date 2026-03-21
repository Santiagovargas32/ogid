import stateManager from "../state/stateManager.js";

export function getHealth(_req, res) {
  const socketServer = res.app.locals.socketServer;
  const config = res.app.locals.config;
  const orchestrator = res.app.locals.orchestrator;
  const meta = stateManager.getMeta();
  const snapshot = stateManager.getSnapshot();
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
      status: "ok",
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
