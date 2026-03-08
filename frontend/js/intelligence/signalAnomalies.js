import { SmartPollLoop } from "../smartPollLoop.js";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function startSignalAnomalies({ api, rootId = "signal-anomalies-body" }) {
  const root = document.getElementById(rootId);
  if (!root) {
    return () => {};
  }

  const loop = new SmartPollLoop({
    intervalMs: 105_000,
    hiddenIntervalMs: 180_000,
    task: () => api.getIntelAnomalies({}),
    onData: (payload) => {
      const items = (payload.items || []).slice(0, 5);

      root.innerHTML = `
        ${items
          .map(
            (item) => `
              <div class="intel-metric-row">
                <span>${escapeHtml(item.signalType || "signal")}</span>
                <strong>${Number(item.anomalyScore || 0).toFixed(1)}</strong>
              </div>
              <div class="small text-light-emphasis">
                current ${Number(item.currentValue || 0).toFixed(1)} vs baseline ${Number(item.baselineMean || 0).toFixed(1)}
              </div>
            `
          )
          .join("")}
      `;
    },
    onError: () => {
      root.innerHTML = '<div class="small text-warning">Signal anomalies unavailable.</div>';
    }
  });

  loop.start();
  return () => loop.stop();
}
