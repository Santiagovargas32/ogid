import { SmartPollLoop } from "../smartPollLoop.js";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function startEscalationHotspots({ api, rootId = "escalation-hotspots-body" }) {
  const root = document.getElementById(rootId);
  if (!root) {
    return () => {};
  }

  const loop = new SmartPollLoop({
    intervalMs: 95_000,
    hiddenIntervalMs: 180_000,
    task: () => api.getHotspotsV2({}),
    onData: (payload) => {
      const hotspots = (payload.hotspots || []).slice(0, 5);

      root.innerHTML = `
        <div class="small text-light-emphasis mb-2">${Number(payload.eventCount || 0)} fused events in current escalation picture</div>
        ${hotspots
          .map(
            (item) => `
              <div class="intel-metric-row">
                <span>${escapeHtml(item.country || item.iso2 || "Unknown")}</span>
                <strong>${Number(item.hotspotScore || 0).toFixed(1)}</strong>
              </div>
            `
          )
          .join("")}
      `;
    },
    onError: () => {
      root.innerHTML = '<div class="small text-warning">Escalation hotspots unavailable.</div>';
    }
  });

  loop.start();
  return () => loop.stop();
}
