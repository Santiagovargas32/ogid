function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function deltaLabel(item = {}) {
  if (item.delta === null || item.delta === undefined) {
    return "comparison unavailable";
  }
  const delta = Number(item.delta || 0);
  const changePct = item.changePct;
  const direction = delta > 0 ? "+" : "";
  const percent = changePct === null || changePct === undefined || !Number.isFinite(Number(changePct))
    ? ""
    : ` (${Number(changePct) > 0 ? "+" : ""}${Number(changePct).toFixed(1)}%)`;
  return `${direction}${delta}${percent}`;
}

export function buildFrequentTermsHtml(payload = {}) {
  const section = payload.frequentTerms || {};
  const items = Array.isArray(section.items) ? section.items : [];
  const entities = Array.isArray(section.entities) ? section.entities : [];
  const comparison = section.comparison || {};
  const comparisonStatus = String(comparison.status || "unknown").replaceAll("_", " ");
  const comparisonLabel = comparison.currentHours && comparison.previousHours
    ? `Current ${comparison.currentHours}h (${Number(comparison.currentSampleSize || 0)} articles) vs previous ${comparison.previousHours}h (${Number(
        comparison.previousSampleSize || 0
      )}) | ${comparisonStatus} | observed span ${Number(comparison.observedPreviousSpanHours || 0).toFixed(1)}h`
    : `${Number(payload.corpus?.uniqueArticles || 0)} unique articles`;

  if (!items.length && !entities.length) {
    return '<div class="intel-empty-state">No frequent headline terms matched the active filters.</div>';
  }

  return `
    <div class="small text-light-emphasis mb-2">${escapeHtml(comparisonLabel)}</div>
    <div class="intel-topic-list">
      ${items
        .map((item) => {
          const direction = ["up", "down", "flat"].includes(item.direction) ? item.direction : "unavailable";
          return `<span class="driver-pill intel-term-${direction}">${escapeHtml(item.term)}:${Number(item.count || 0)} <small>${escapeHtml(
            deltaLabel(item)
          )}</small></span>`;
        })
        .join("")}
    </div>
    ${
      entities.length
        ? `<div class="small text-light-emphasis mt-2 mb-1">Country entities</div><div class="intel-topic-list">${entities
            .map((entity) => `<span class="driver-pill">${escapeHtml(entity.label || entity.iso2)}:${Number(entity.count || 0)}</span>`)
            .join("")}</div>`
        : ""
    }
  `;
}
