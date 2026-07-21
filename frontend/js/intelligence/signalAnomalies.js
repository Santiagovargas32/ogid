function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatValue(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "--";
  }
  return Number(value).toFixed(1);
}

function formatTimestamp(value) {
  const timestamp = new Date(value || 0);
  return Number.isFinite(timestamp.getTime())
    ? timestamp.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "--";
}

function insufficientMessage(item = {}) {
  const samples = item.samples || {};
  const notices = [];
  if (item.status === "insufficient_current_data") {
    notices.push("Datos actuales insuficientes");
  }
  if (Number(samples.baseline || 0) < Number(samples.requiredBaseline || 0)) {
    notices.push(`Baseline insuficiente (${Number(samples.baseline || 0)}/${Number(samples.requiredBaseline || 0)})`);
  } else if (Number(samples.baselineSpanHours || 0) < Number(samples.requiredSpanHours || 0)) {
    notices.push(`Baseline insuficiente (${formatValue(samples.baselineSpanHours)}h/${formatValue(samples.requiredSpanHours)}h)`);
  }
  return notices.join(" | ") || "Baseline insuficiente";
}

export function buildSignalAnomaliesHtml(payload = {}) {
  const section = payload.anomalies || {};
  const items = Array.isArray(section.items) ? section.items : [];
  const window = section.window || {};
  const windowLabel = `Active ${Number(window.activeWindowHours || 0)}h | baseline ${Number(window.baselineDays || 0)}d | latest bucket ${formatTimestamp(section.latestBucketAt)}`;
  if (!items.length) {
    return `<div class="small text-light-emphasis mb-2">${escapeHtml(windowLabel)}</div><div class="intel-baseline-insufficient">Baseline insuficiente</div>`;
  }

  return `
    <div class="small text-light-emphasis mb-2">${escapeHtml(windowLabel)}</div>
    <div class="intel-anomaly-list">
      ${items
        .map((item) => {
          const scoreAvailable = item.status === "ready" && item.anomalyScore !== null && item.anomalyScore !== undefined && Number.isFinite(Number(item.anomalyScore));
          if (!scoreAvailable) {
            const message = item.status === "invalid_window"
              ? `Baseline window too short (minimum ${Number(section.configuration?.minimumBaselineDays || 0)}d)`
              : insufficientMessage(item);
            return `
              <div class="intel-anomaly-item">
                <div class="intel-metric-row"><span>${escapeHtml(item.signalType || "signal")}</span></div>
                <div class="intel-baseline-insufficient">${escapeHtml(message)}</div>
                <div class="small text-light-emphasis">current ${formatValue(item.currentValue)} &middot; baseline ${formatValue(item.baselineMean)}</div>
              </div>
            `;
          }
          return `
            <div class="intel-anomaly-item ${item.isAnomalous ? "is-anomalous" : ""}">
              <div class="intel-metric-row">
                <span>${escapeHtml(item.signalType || "signal")}</span>
                <strong>${formatValue(item.anomalyScore)}</strong>
              </div>
              <div class="small text-light-emphasis">current ${formatValue(item.currentValue)} &middot; baseline ${formatValue(item.baselineMean)} &middot; z ${formatValue(item.zScore)}</div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}
