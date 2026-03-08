import { SmartPollLoop } from "../smartPollLoop.js";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function startRiskEngine({ api, rootId = "strategic-risk-body" }) {
  const root = document.getElementById(rootId);
  if (!root) {
    return () => {};
  }

  const loop = new SmartPollLoop({
    intervalMs: 90_000,
    hiddenIntervalMs: 180_000,
    task: () => api.getCountryInstability({}),
    onData: (payload) => {
      const top = (payload.ranking || []).slice(0, 5);
      const average =
        top.reduce((sum, item) => sum + Number(item.cii || 0), 0) / Math.max(1, top.length);

      root.innerHTML = `
        <div class="intel-risk-score">${average.toFixed(1)}</div>
        <div class="small text-light-emphasis mb-2">Average top-tier CII</div>
        ${top
          .map(
            (item) => `
              <div class="intel-metric-row">
                <span>${escapeHtml(item.country)}</span>
                <strong>${Number(item.cii || 0).toFixed(1)}</strong>
              </div>
            `
          )
          .join("")}
      `;
    },
    onError: () => {
      root.innerHTML = '<div class="small text-warning">Risk engine unavailable.</div>';
    }
  });

  loop.start();
  return () => loop.stop();
}
