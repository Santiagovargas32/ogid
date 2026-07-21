function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatScore(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "--";
  }
  return Number(value).toFixed(1);
}

function componentScore(item = {}, key, fallback) {
  const component = item.components?.[key];
  return component && typeof component === "object" ? component.score : fallback;
}

function explanationText(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(" | ");
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

export function buildEscalationHotspotsHtml(payload = {}) {
  const hotspots = Array.isArray(payload.hotspots) ? payload.hotspots.slice(0, 5) : [];
  const corpus = payload.corpus || {};
  const windowLabel = payload.window?.label || "selected window";
  if (!hotspots.length) {
    return '<div class="intel-empty-state">No escalation hotspots matched the active filters.</div>';
  }

  const eventLabel = corpus.truncated
    ? `${Number(corpus.eventCount || 0)} of ${Number(corpus.availableEventCount || 0)} unique events`
    : `${Number(corpus.eventCount || 0)} unique events`;

  return `
    <div class="small text-light-emphasis mb-2">${escapeHtml(eventLabel)} &middot; ${escapeHtml(windowLabel)}</div>
    ${hotspots
      .map((item) => {
        const news = componentScore(item, "news", item.newsActivity);
        const cii = componentScore(item, "cii", item.cii);
        const geo = componentScore(item, "geo", item.geoConvergence);
        const military = componentScore(item, "military", item.militaryActivity);
        const explanation = explanationText(item.explanation);
        return `
          <div class="intel-hotspot-item">
            <div class="intel-metric-row">
              <span>${escapeHtml(item.country || item.iso2 || "Unknown")}</span>
              <strong>${formatScore(item.hotspotScore)}</strong>
            </div>
            <div class="intel-component-line">
              News ${formatScore(news)} &middot; CII ${formatScore(cii)} &middot; Geo ${formatScore(geo)} &middot; Military ${formatScore(military)}
            </div>
            ${explanation ? `<div class="intel-explanation">${escapeHtml(explanation)}</div>` : ""}
          </div>
        `;
      })
      .join("")}
  `;
}
