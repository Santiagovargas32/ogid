import stateManager from "../state/stateManager.js";

export function getHealth(_req, res) {
  const socketServer = res.app.locals.socketServer;
  const meta = stateManager.getMeta();

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
      watchlistCountries: meta.watchlistCountries || []
    }
  });
}
