import stateManager from "../state/stateManager.js";

export function getHealth(_req, res) {
  const socketServer = res.app.locals.socketServer;
  const config = res.app.locals.config;
  const orchestrator = res.app.locals.orchestrator;
  const meta = stateManager.getMeta();
  const snapshot = stateManager.getSnapshot();

  res.json({
    ok: true,
    data: {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      websocketClients: socketServer?.clientCount?.() ?? 0,
      lastRefreshAt: meta.lastRefreshAt,
      refreshIntervalMs: meta.refreshIntervalMs,
      sourceMode: meta.sourceMode,
      dataQuality: meta.dataQuality || {},
      watchlistCountries: meta.watchlistCountries || [],
      market: {
        configuredProvider: config?.market?.provider || null,
        configuredFallbackProvider: config?.market?.fallbackProvider || null,
        effectiveProvider: snapshot?.market?.sourceMeta?.effectiveProvider || snapshot?.market?.provider || null,
        historicalPersistence: orchestrator?.getMarketHistoryStatus?.() || null
      },
      publicConfig: {
        adminMenuVisible: config?.security?.adminMenuVisible === true
      }
    }
  });
}
