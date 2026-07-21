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

function componentLine(item = {}) {
  const components = item.components || {};
  return [
    `Baseline ${formatScore(components.baselineRisk)}`,
    `Unrest ${formatScore(components.unrestSignals)}`,
    `Security ${formatScore(components.securitySignals)}`,
    `Info ${formatScore(components.informationFlow)}`
  ].join(" &middot; ");
}

function explanationLine(item = {}) {
  const explanation = item.explanation || {};
  const sampleSize = Number(item.metrics?.sampleSize || 0);
  const parts = [
    `${sampleSize} country-linked article${sampleSize === 1 ? "" : "s"}`,
    explanation.windowHours ? `${Number(explanation.windowHours)}h window` : "",
    explanation.formula || ""
  ].filter(Boolean);
  return parts.join(" | ");
}

export function buildCountryInstabilityHtml(payload = {}) {
  const section = payload.countryInstability || {};
  const ranking = Array.isArray(section.ranking) ? section.ranking.slice(0, 5) : [];
  if (!ranking.length) {
    return '<div class="intel-empty-state">No countries matched the active filters.</div>';
  }

  const average = section.averageTopCii ??
    ranking.reduce((sum, item) => sum + Number(item.cii || 0), 0) / Math.max(1, ranking.length);
  const methodologyVersion = section.methodology?.version || payload.methodology?.countryInstability?.version || "--";

  return `
    <div class="intel-risk-score">${formatScore(average)}</div>
    <div class="small text-light-emphasis mb-2">Average of ${ranking.length} displayed countries &middot; ${Number(
      section.sampleSize ?? payload.corpus?.uniqueArticles ?? 0
    )} articles &middot; ${escapeHtml(methodologyVersion)}</div>
    ${ranking
      .map(
        (item) => `
          <div class="intel-country-row">
            <div class="intel-metric-row">
              <span>${escapeHtml(item.country || item.iso2 || "Unknown")}</span>
              <strong>${formatScore(item.cii)}</strong>
            </div>
            <div class="intel-component-line">${componentLine(item)}</div>
            <div class="intel-explanation">${escapeHtml(explanationLine(item))}</div>
          </div>
        `
      )
      .join("")}
  `;
}
