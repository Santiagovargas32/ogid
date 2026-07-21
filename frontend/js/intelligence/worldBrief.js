const DRIVER_LABELS = Object.freeze({
  news: "News",
  cii: "CII",
  geo: "Geo",
  military: "Military"
});

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

function formatPublishedAt(value) {
  if (!value) {
    return "";
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime())
    ? timestamp.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""), globalThis.location?.origin || "http://localhost");
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function buildWorldBriefHtml(payload = {}) {
  const brief = payload.worldBrief || {};
  const leader = brief.leader || null;
  const articles = Array.isArray(brief.articles) ? brief.articles : [];
  const drivers = Array.isArray(brief.drivers) ? brief.drivers : [];
  const windowLabel = payload.window?.label || (brief.windowHours ? `last ${brief.windowHours}h` : "selected window");

  const driverHtml = drivers.length
    ? `<div class="intel-topic-list intel-driver-list">${drivers
        .map((driver) => {
          const key = String(driver.key || "signal").toLowerCase();
          const detail = `weight ${(Number(driver.weight || 0) * 100).toFixed(0)}% | contribution ${formatScore(driver.contribution)}`;
          return `<span class="driver-pill" title="${escapeHtml(detail)}">${escapeHtml(DRIVER_LABELS[key] || key)} ${formatScore(driver.score)} <small>+${formatScore(driver.contribution)}</small></span>`;
        })
        .join("")}</div>`
    : "";

  const articlesHtml = articles.length
    ? articles
        .map((item) => {
          const meta = [item.sourceName || "Source", item.threatLevel || "low", formatPublishedAt(item.publishedAt)]
            .filter(Boolean)
            .join(" | ");
          const articleUrl = safeHttpUrl(item.url);
          const title = escapeHtml(item.title || "Headline");
          return `
            <article class="intel-brief-item">
              <strong>${articleUrl ? `<a href="${escapeHtml(articleUrl)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}</strong>
              <div class="small text-light-emphasis">${escapeHtml(meta)}</div>
              ${item.excerpt ? `<div class="small text-light-emphasis mt-1">${escapeHtml(item.excerpt)}</div>` : ""}
            </article>
          `;
        })
        .join("")
    : `<div class="intel-empty-state">${
        leader
          ? `No related headlines matched ${escapeHtml(leader.country || leader.iso2 || "the leading hotspot")} in ${escapeHtml(windowLabel)}.`
          : "No active escalation clusters detected in the selected window."
      }</div>`;

  return `
    <div class="intel-card-body">
      <p class="intel-brief-summary">${escapeHtml(
        brief.summary || "No active escalation clusters detected in the selected window."
      )}</p>
      ${driverHtml}
      ${articlesHtml}
    </div>
  `;
}
