import { SmartPollLoop } from "../smartPollLoop.js";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function startWorldBrief({ api, rootId = "world-brief-body" }) {
  const root = document.getElementById(rootId);
  if (!root) {
    return () => {};
  }

  const loop = new SmartPollLoop({
    intervalMs: 90_000,
    hiddenIntervalMs: 180_000,
    task: async () => {
      const [news, hotspots] = await Promise.all([api.getAggregateNews({ limit: 8 }), api.getHotspotsV2({})]);
      return { news, hotspots };
    },
    onData: ({ news, hotspots }) => {
      const topHotspot = hotspots.hotspots?.[0];
      const topNews = (news.items || []).slice(0, 3);

      root.innerHTML = `
        <div class="intel-card-body">
          <p class="intel-brief-summary">
            ${topHotspot ? `${escapeHtml(topHotspot.country)} leads escalation monitoring with hotspot score ${Number(topHotspot.hotspotScore || 0).toFixed(1)}.` : "No active escalation clusters detected."}
          </p>
          ${topNews
            .map(
              (item) => `
                <article class="intel-brief-item">
                  <strong>${escapeHtml(item.title || "Headline")}</strong>
                  <div class="small text-light-emphasis">${escapeHtml(item.sourceName || "Source")} | ${escapeHtml(item.threatLevel || "monitoring")}</div>
                  <div class="small text-light-emphasis mt-1">${escapeHtml(item.excerpt || item.summary || "")}</div>
                </article>
              `
            )
            .join("")}
        </div>
      `;
    },
    onError: () => {
      root.innerHTML = '<div class="small text-warning">World brief unavailable.</div>';
    }
  });

  loop.start();
  return () => loop.stop();
}
