import apiQuotaTracker, { WINDOW_MS } from "../services/admin/apiQuotaTrackerService.js";

export function getApiLimits(_req, res) {
  res.json({
    ok: true,
    data: {
      window: {
        hours: 24,
        ms: WINDOW_MS
      },
      providers: apiQuotaTracker.getSnapshot(),
      generatedAt: new Date().toISOString()
    }
  });
}
