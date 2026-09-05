function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function evidenceHtml(entry) {
  const sources = (entry.provenance?.evidence || []).slice(0, 8).map((item) => {
    const label = escapeHtml(item.publisher || item.sourceName || item.articleId || "source");
    try {
      const url = new URL(item.canonicalUrl);
      if (["http:", "https:"].includes(url.protocol)) return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } catch { /* Evidence without a valid URL is still attributed by name. */ }
    return `<span>${label}</span>`;
  });
  return sources.length ? `<div class="ai-evidence-list"><strong>Evidence:</strong> ${sources.join(" · ")}</div>` : "";
}

export function renderMarketExplanationHistory(ai = {}, { symbols = null, expanded = new Map(), formatDate = (value) => value ? new Date(value).toLocaleString() : "--" } = {}) {
  if (ai.enabled !== true || ai.mode !== "visible" || ["none", "off", "disabled"].includes(ai.provider || "none")) return "";
  const allowed = symbols == null ? null : new Set(symbols.map((symbol) => String(symbol).toUpperCase()));
  const matches = (entry) => !allowed || allowed.has(String(entry.ticker || "").toUpperCase());
  const current = Object.values(ai.marketExplanations || {}).filter(matches);
  const seen = new Set();
  const history = (ai.marketExplanationHistory || current).filter(matches)
    .filter((entry) => {
      if (!["ready", "stale"].includes(entry.status) || !entry.output || seen.has(entry.enrichmentId)) return false;
      seen.add(entry.enrichmentId);
      return true;
    })
    .sort((left, right) => Date.parse(right.generatedAt || 0) - Date.parse(left.generatedAt || 0))
    .slice(0, 3);
  const updates = current.filter((entry) => ["pending", "running", "failed", "rejected"].includes(entry.refreshStatus || entry.status));
  const progress = updates.length ? `<div class="small text-light-emphasis" role="status">${updates.map((entry) => {
    const status = entry.refreshStatus || entry.status;
    const label = ["pending", "running"].includes(status) ? "Analysis in progress" : "Latest analysis unavailable";
    return `${escapeHtml(entry.ticker || entry.subjectId)} · ${label}`;
  }).join(" · ")}</div>` : "";
  const hasNewLatest = history.length > 0 && !expanded.has(history[0].enrichmentId);
  return progress + history.map((entry, index) => {
    const output = entry.output;
    const open = !hasNewLatest && expanded.has(entry.enrichmentId) ? expanded.get(entry.enrichmentId) : index === 0;
    const drivers = (output.drivers || []).map((driver) => `<li>${escapeHtml(driver.text)}</li>`).join("");
    const limitations = (output.limitations || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    const notes = (output.uncertainty?.notes || []).map(escapeHtml).join(" ");
    return `<details class="ai-enrichment-card ai-market-history-entry" data-enrichment-id="${escapeHtml(entry.enrichmentId)}"${open ? " open" : ""}>
      <summary><span class="ai-enrichment-label">${escapeHtml(entry.ticker || entry.subjectId)} · ${index === 0 ? "Latest analysis" : "Previous analysis"}</span>
        <span class="small text-light-emphasis">${escapeHtml(formatDate(entry.generatedAt))}</span></summary>
      <p>${escapeHtml(output.narrative || "")}</p>
      ${drivers ? `<ul>${drivers}</ul>` : ""}
      ${evidenceHtml(entry)}
      ${limitations ? `<div class="small text-light-emphasis">Limitations:<ul>${limitations}</ul></div>` : ""}
      <div class="small text-light-emphasis">Generated content · ${escapeHtml(entry.model || "--")} · causality ${escapeHtml(output.causality || "not_established")} · uncertainty ${escapeHtml(output.uncertainty?.level || "unknown")}${notes ? ` · ${notes}` : ""}</div>
    </details>`;
  }).join("");
}
