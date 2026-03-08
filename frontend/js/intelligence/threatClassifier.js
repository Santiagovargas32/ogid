import { SmartPollLoop } from "../smartPollLoop.js";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function startThreatClassifier({ api, rootId = "threat-classifier-body" }) {
  const root = document.getElementById(rootId);
  if (!root) {
    return () => {};
  }

  const loop = new SmartPollLoop({
    intervalMs: 100_000,
    hiddenIntervalMs: 180_000,
    task: () => api.getAggregateNews({ limit: 120 }),
    onData: (payload) => {
      const levelCounts = (payload.items || []).reduce((accumulator, item) => {
        const key = String(item.threatLevel || "low").toLowerCase();
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
      }, {});
      const topicCounts = (payload.items || []).reduce((accumulator, item) => {
        (item.topicTags || []).forEach((tag) => {
          accumulator[tag] = (accumulator[tag] || 0) + 1;
        });
        return accumulator;
      }, {});
      const topTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);

      root.innerHTML = `
        <div class="intel-metric-row">
          <span>Critical</span><strong>${levelCounts.critical || 0}</strong>
        </div>
        <div class="intel-metric-row">
          <span>Elevated</span><strong>${levelCounts.elevated || 0}</strong>
        </div>
        <div class="intel-metric-row">
          <span>Monitoring</span><strong>${levelCounts.monitoring || 0}</strong>
        </div>
        <div class="intel-topic-list">
          ${topTopics.map(([tag, count]) => `<span class="driver-pill">${escapeHtml(tag)}:${count}</span>`).join("")}
        </div>
      `;
    },
    onError: () => {
      root.innerHTML = '<div class="small text-warning">Threat classifier unavailable.</div>';
    }
  });

  loop.start();
  return () => loop.stop();
}
