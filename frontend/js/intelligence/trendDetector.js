import { SmartPollLoop } from "../smartPollLoop.js";

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "from", "into", "amid", "after", "over", "this", "have", "will", "news", "live"]);

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function extractKeywords(items = []) {
  const counts = new Map();
  items.forEach((item) => {
    String(item.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token))
      .forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
}

export function startTrendDetector({ api, rootId = "trend-detector-body" }) {
  const root = document.getElementById(rootId);
  if (!root) {
    return () => {};
  }

  const loop = new SmartPollLoop({
    intervalMs: 110_000,
    hiddenIntervalMs: 180_000,
    task: async () => {
      const [news, anomalies] = await Promise.all([
        api.getAggregateNews({ limit: 80 }),
        api.getIntelAnomalies({})
      ]);
      return { news, anomalies };
    },
    onData: ({ news, anomalies }) => {
      const keywords = extractKeywords(news.items || []);
      const anomalyItems = (anomalies.items || []).slice(0, 4);
      root.innerHTML = `
        <div class="intel-topic-list">
          ${keywords.map(([token, count]) => `<span class="driver-pill">${escapeHtml(token)}:${count}</span>`).join("")}
        </div>
        <div class="intel-anomaly-list">
          ${anomalyItems
            .map(
              (item) => `
                <div class="intel-metric-row">
                  <span>${escapeHtml(item.signalType)}</span>
                  <strong>${Number(item.anomalyScore || 0).toFixed(1)}</strong>
                </div>
              `
            )
            .join("")}
        </div>
      `;
    },
    onError: () => {
      root.innerHTML = '<div class="small text-warning">Trend detector unavailable.</div>';
    }
  });

  loop.start();
  return () => loop.stop();
}
