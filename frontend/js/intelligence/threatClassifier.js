function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildNewsSeverityHtml(payload = {}) {
  const severity = payload.severity || {};
  const counts = severity.counts || {};
  const topics = Array.isArray(severity.topTopics) ? severity.topTopics : [];

  return `
    <div class="small text-light-emphasis mb-2">Rule-based &middot; ${Number(severity.sampleSize || 0)} classified articles</div>
    ${[
      ["Critical", counts.critical],
      ["Elevated", counts.elevated],
      ["Monitoring", counts.monitoring],
      ["Low", counts.low]
    ]
      .map(
        ([label, count]) => `
          <div class="intel-metric-row">
            <span>${label}</span><strong>${Number(count || 0)}</strong>
          </div>
        `
      )
      .join("")}
    <div class="intel-topic-list mt-2">
      ${topics.map((item) => `<span class="driver-pill">${escapeHtml(item.topic)}:${Number(item.count || 0)}</span>`).join("")}
    </div>
  `;
}
