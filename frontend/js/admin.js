import { api } from "./api.js";

const POLL_INTERVAL_MS = 60_000;
const RAW_PAGE_SIZE = 100;

const elements = {};
let pollHandle = null;
const rawPaginationState = {
  intel: 1,
  rssAggregate: 1
};

function byId(id) {
  return document.getElementById(id);
}

function cacheElements() {
  elements.adminLastRefresh = byId("admin-last-refresh");
  elements.serverSummaryUpdated = byId("server-summary-updated");
  elements.serverSummaryBody = byId("server-summary-body");
  elements.mediaStreamSummaryBody = byId("media-stream-summary-body");
  elements.refreshMediaStreamsBtn = byId("refresh-media-streams-btn");
  elements.pipelineGeneratedAt = byId("pipeline-generated-at");
  elements.pipelineStatusBody = byId("pipeline-status-body");
  elements.pipelineDiagnosticsBody = byId("pipeline-diagnostics-body");
  elements.rssFeedStatusBody = byId("rss-feed-status-body");
  elements.recentCycleErrorsBody = byId("recent-cycle-errors-body");
  elements.apiLimitsUpdated = byId("api-limits-updated");
  elements.apiLimitsBody = byId("api-limits-body");
  elements.intelNewsCount = byId("intel-news-count");
  elements.intelNewsBody = byId("intel-news-body");
  elements.aggregateNewsCount = byId("aggregate-news-count");
  elements.aggregateNewsBody = byId("aggregate-news-body");
  elements.intelNewsRawCount = byId("intel-news-raw-count");
  elements.intelNewsRawBody = byId("intel-news-raw-body");
  elements.intelNewsRawPrev = byId("intel-news-raw-prev");
  elements.intelNewsRawNext = byId("intel-news-raw-next");
  elements.intelNewsRawPage = byId("intel-news-raw-page");
  elements.aggregateNewsRawCount = byId("aggregate-news-raw-count");
  elements.aggregateNewsRawBody = byId("aggregate-news-raw-body");
  elements.aggregateNewsRawPrev = byId("aggregate-news-raw-prev");
  elements.aggregateNewsRawNext = byId("aggregate-news-raw-next");
  elements.aggregateNewsRawPage = byId("aggregate-news-raw-page");
  elements.mediaStreamsUpdated = byId("media-streams-updated");
  elements.mediaStreamsBody = byId("media-streams-body");
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) {
    return "--";
  }
  return new Date(value).toLocaleString();
}

function formatShortTime(value) {
  if (!value) {
    return "--";
  }
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDurationMs(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) {
    return "--";
  }
  const seconds = Math.round(number / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes <= 0) {
    return `${remainder}s`;
  }
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function renderEmptyRow(colspan, message) {
  return `<tr><td colspan="${colspan}" class="text-light-emphasis">${escapeHtml(message)}</td></tr>`;
}

function renderSummaryCard(items = []) {
  return items
    .map(
      (item) => `
        <article class="diagnostic-item">
          <div class="diagnostic-item-header">
            <strong>${escapeHtml(item.label)}</strong>
            <span class="diagnostic-item-meta">${escapeHtml(item.value)}</span>
          </div>
          ${item.meta ? `<div class="diagnostic-item-meta">${escapeHtml(item.meta)}</div>` : ""}
        </article>
      `
    )
    .join("");
}

function renderServerSummary(health = {}, pipeline = {}) {
  const market = pipeline?.market || {};
  const news = pipeline?.news || {};
  elements.serverSummaryBody.innerHTML = renderSummaryCard([
    {
      label: "Health",
      value: health.status || "unknown",
      meta: `Uptime ${Math.max(0, Number(health.uptimeSeconds || 0))}s`
    },
    {
      label: "WebSocket clients",
      value: String(health.websocketClients ?? 0),
      meta: `Last refresh ${formatDate(health.lastRefreshAt)}`
    },
    {
      label: "Source mode",
      value: String(health.sourceMode || "--"),
      meta: `News provider ${String(news.provider || "--")}`
    },
    {
      label: "Market provider",
      value: String(market.provider || "--"),
      meta: market.enabled === false ? "Market disabled" : `Next market run ${formatShortTime(market.nextRecommendedRunAt)}`
    },
    {
      label: "News cycle latency",
      value: formatDurationMs(news.lastDurationMs),
      meta: `Status ${String(news.lastStatus || "idle")}`
    },
    {
      label: "Market cycle latency",
      value: formatDurationMs(market.lastDurationMs),
      meta: `Status ${String(market.lastStatus || "idle")}`
    }
  ]);
  elements.serverSummaryUpdated.textContent = `Updated: ${formatDate(new Date().toISOString())}`;
}

function renderMediaSummary(media = {}) {
  const summary = media.summary || {};
  elements.mediaStreamSummaryBody.innerHTML = renderSummaryCard([
    {
      label: "Total streams",
      value: String(summary.total ?? 0)
    },
    {
      label: "Live",
      value: String(summary.live ?? 0),
      meta: `Embedded ${String(summary.embedded ?? 0)}`
    },
    {
      label: "Offline",
      value: String(summary.offline ?? 0),
      meta: `Link only ${String(summary.linkOnly ?? 0)}`
    },
    {
      label: "Error",
      value: String(summary.error ?? 0),
      meta: `Unverified ${String(summary.unverified ?? 0)}`
    }
  ]);
}

function renderPipelineStatus(payload = {}) {
  const market = payload.market || {};
  const news = payload.news || {};
  elements.pipelineGeneratedAt.textContent = `Generated: ${formatDate(payload.generatedAt)}`;
  const rows = [
    {
      pipeline: "market",
      band: market.quotaBand || "--",
      nextRun: market.nextRecommendedRunAt ? `${formatShortTime(market.nextRecommendedRunAt)} (${formatDurationMs(market.nextDelayMs)})` : "--",
      lastRun: formatShortTime(market.lastCompletedAt),
      duration: formatDurationMs(market.lastDurationMs),
      status: market.lastStatus || "idle",
      mode: market.requestMode || "--",
      provider: market.provider || "--",
      lastError:
        market.disabledReason ||
        market.lastUpstreamError ||
        ((market.usedStaleQuotes || []).length ? `stale:${(market.usedStaleQuotes || []).length}` : "--")
    },
    {
      pipeline: "news",
      band: news.quotaBand || "--",
      nextRun: news.nextRecommendedRunAt ? `${formatShortTime(news.nextRecommendedRunAt)} (${formatDurationMs(news.nextDelayMs)})` : "--",
      lastRun: formatShortTime(news.lastCompletedAt),
      duration: formatDurationMs(news.lastDurationMs),
      status: news.lastStatus || "idle",
      mode: news.pageSize ? `page:${news.pageSize}` : "--",
      provider: news.provider || "--",
      lastError: (news.attempts || []).filter((item) => item.status === "error").map((item) => item.provider).join(", ") || "--"
    }
  ];

  elements.pipelineStatusBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.pipeline)}</td>
          <td>${escapeHtml(row.band)}</td>
          <td>${escapeHtml(row.nextRun)}</td>
          <td>${escapeHtml(row.lastRun)}</td>
          <td>${escapeHtml(row.duration)}</td>
          <td>${escapeHtml(row.status)}</td>
          <td>${escapeHtml(row.mode)}</td>
          <td>${escapeHtml(row.provider)}</td>
          <td>${escapeHtml(row.lastError)}</td>
        </tr>
      `
    )
    .join("");

  renderPipelineDiagnostics(news);
  renderRecentCycleErrors(payload.recentCycleErrors || []);
}

function buildNewsProviderDiagnostics(news = {}) {
  const attemptByProvider = new Map(
    (news.attempts || []).map((attempt) => [String(attempt.provider || "").toLowerCase(), attempt])
  );
  const rawCounts = news.rawCountByProvider || {};
  const selectedCounts = news.selectedCountByProvider || {};
  const queryLengths = news.queryLengthByProvider || {};
  const providers = new Set([
    ...Object.keys(rawCounts),
    ...Object.keys(selectedCounts),
    ...Object.keys(queryLengths),
    ...(news.attempts || []).map((attempt) => String(attempt.provider || "").toLowerCase())
  ]);

  return [...providers]
    .filter(Boolean)
    .sort()
    .map((provider) => {
      const attempt = attemptByProvider.get(provider) || {};
      const status = ["ok", "empty", "error", "skipped"].includes(String(attempt.status || "").toLowerCase())
        ? String(attempt.status).toLowerCase()
        : Number(news.selectedCountByProvider?.[provider] || 0) > 0
          ? "ok"
          : "empty";
      return {
        provider,
        status,
        rawCount: Number(rawCounts[provider] || attempt.rawCount || 0),
        selectedCount: Number(selectedCounts[provider] || attempt.count || 0),
        queryLength: Number(queryLengths[provider] || 0),
        reason: attempt.reason || "",
        nextAllowedAt: attempt.nextAllowedAt || ""
      };
    });
}

function renderPipelineDiagnostics(news = {}) {
  const diagnostics = buildNewsProviderDiagnostics(news);
  if (!diagnostics.length) {
    elements.pipelineDiagnosticsBody.innerHTML =
      '<div class="diagnostic-item diagnostic-item-meta">No provider diagnostics available.</div>';
  } else {
    elements.pipelineDiagnosticsBody.innerHTML = diagnostics
      .map((item) => {
        const reasonLine = item.reason
          ? `<div class="diagnostic-item-meta">reason: ${escapeHtml(item.reason)}${item.nextAllowedAt ? ` | next: ${escapeHtml(formatShortTime(item.nextAllowedAt))}` : ""}</div>`
          : item.nextAllowedAt
            ? `<div class="diagnostic-item-meta">next: ${escapeHtml(formatShortTime(item.nextAllowedAt))}</div>`
            : "";
        return `
          <article class="diagnostic-item">
            <div class="diagnostic-item-header">
              <strong>${escapeHtml(item.provider)}</strong>
              <span class="diagnostic-pill ${item.status}">${escapeHtml(item.status)}</span>
            </div>
            <div class="diagnostic-item-meta">raw: ${item.rawCount} | selected: ${item.selectedCount} | query length: ${item.queryLength}</div>
            ${reasonLine}
          </article>
        `;
      })
      .join("");
  }

  const feedStatus = news.rssFeedStatus || [];
  if (!feedStatus.length) {
    elements.rssFeedStatusBody.innerHTML =
      '<div class="diagnostic-item diagnostic-item-meta">No RSS diagnostics available.</div>';
    return;
  }
  elements.rssFeedStatusBody.innerHTML = feedStatus
    .map((feed) => {
      const status = String(feed.status || "empty").toLowerCase();
      const safeStatus = ["ok", "error", "empty", "invalid-feed", "skipped"].includes(status) ? status : "empty";
      return `
        <article class="diagnostic-item">
          <div class="diagnostic-item-header">
            <strong>${escapeHtml(feed.label || feed.url || "RSS feed")}</strong>
            <span class="diagnostic-pill ${safeStatus}">${escapeHtml(status)}</span>
          </div>
          <div class="diagnostic-item-meta">count: ${Number(feed.count || 0)} | ${escapeHtml(feed.error || feed.url || "--")}</div>
        </article>
      `;
    })
    .join("");
}

function renderRecentCycleErrors(items = []) {
  if (!(items || []).length) {
    elements.recentCycleErrorsBody.innerHTML =
      '<div class="diagnostic-item diagnostic-item-meta">No recent cycle errors recorded.</div>';
    return;
  }

  elements.recentCycleErrorsBody.innerHTML = (items || [])
    .slice(-10)
    .reverse()
    .map(
      (item) => `
        <article class="diagnostic-item">
          <div class="diagnostic-item-header">
            <strong>${escapeHtml(item.provider || item.cycle || "system")}</strong>
            <span class="diagnostic-pill error">${escapeHtml(item.code || "error")}</span>
          </div>
          <div class="diagnostic-item-meta">${escapeHtml(item.cycle || "system")} | ${escapeHtml(formatShortTime(item.at))}</div>
          <div class="diagnostic-item-meta">${escapeHtml(item.message || "unknown-error")}</div>
        </article>
      `
    )
    .join("");
}

function renderApiLimits(payload = {}) {
  const providers = payload.providers || [];
  elements.apiLimitsUpdated.textContent = `Updated: ${formatDate(payload.generatedAt)}`;
  if (!providers.length) {
    elements.apiLimitsBody.innerHTML = renderEmptyRow(8, "No API limits data available.");
    return;
  }
  elements.apiLimitsBody.innerHTML = providers
    .map((provider) => {
      const statusClass = provider.exhausted ? "text-danger" : "text-light-emphasis";
      const remaining = Number.isFinite(provider.effectiveRemaining) ? provider.effectiveRemaining : "--";
      return `
        <tr>
          <td>${escapeHtml(provider.provider)}</td>
          <td>${escapeHtml(provider.quotaBand || "--")}</td>
          <td>${provider.calls24h}</td>
          <td>${provider.success24h}</td>
          <td>${provider.errors24h}</td>
          <td>${provider.fallback24h}</td>
          <td>${remaining}</td>
          <td class="${statusClass}">${escapeHtml(provider.lastStatus || "idle")}</td>
        </tr>
      `;
    })
    .join("");
}

function renderNewsRows(items = [], { linkTitles = false } = {}) {
  return items
    .map((item) => {
      const title = escapeHtml(item.title || "--");
      const titleMarkup =
        linkTitles && item.url
          ? `<a class="admin-table-title-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
          : title;
      return `
        <tr>
          <td>${escapeHtml(formatDate(item.publishedAt))}</td>
          <td>${escapeHtml(item.sourceName || "Unknown")}</td>
          <td>${titleMarkup}</td>
          <td>${escapeHtml(item.provider || "--")}</td>
        </tr>
      `;
    })
    .join("");
}

function renderNewsTable(items = [], tbody, countLabel, options = {}) {
  const {
    countText = `${items.length} items`,
    emptyMessage = "No news data available.",
    limit = 50,
    linkTitles = false
  } = options;
  countLabel.textContent = countText;
  if (!items.length) {
    tbody.innerHTML = renderEmptyRow(4, emptyMessage);
    return;
  }

  tbody.innerHTML = renderNewsRows(items.slice(0, limit), { linkTitles });
}

function renderRawPagination(pagination = {}, pageLabel, prevButton, nextButton) {
  const page = Number(pagination.page || 1);
  const totalPages = Number(pagination.totalPages || 1);
  pageLabel.textContent = `Page ${page} of ${totalPages}`;
  prevButton.disabled = page <= 1;
  nextButton.disabled = page >= totalPages;
}

function applyRawNewsPayload(datasetKey, payload = {}) {
  const config =
    datasetKey === "intel"
      ? {
          countLabel: elements.intelNewsRawCount,
          tbody: elements.intelNewsRawBody,
          pageLabel: elements.intelNewsRawPage,
          prevButton: elements.intelNewsRawPrev,
          nextButton: elements.intelNewsRawNext,
          emptyMessage: "No raw intel news available."
        }
      : {
          countLabel: elements.aggregateNewsRawCount,
          tbody: elements.aggregateNewsRawBody,
          pageLabel: elements.aggregateNewsRawPage,
          prevButton: elements.aggregateNewsRawPrev,
          nextButton: elements.aggregateNewsRawNext,
          emptyMessage: "No raw RSS aggregate news available."
        };
  const summary = payload.summary || {};
  const pagination = payload.pagination || {};
  rawPaginationState[datasetKey] = Number(pagination.page || rawPaginationState[datasetKey] || 1);

  const countText =
    datasetKey === "intel"
      ? `raw: ${Number(summary.rawTotal || 0)} | selected: ${Number(summary.selectedTotal || 0)} | query length: ${Number(summary.queryLengthTotal || 0)}`
      : `raw: ${Number(summary.rawTotal || 0)}`;

  renderNewsTable(payload.items || [], config.tbody, config.countLabel, {
    countText,
    emptyMessage: config.emptyMessage,
    limit: payload.items?.length || RAW_PAGE_SIZE,
    linkTitles: true
  });
  renderRawPagination(pagination, config.pageLabel, config.prevButton, config.nextButton);
}

async function refreshRawNewsDataset(datasetKey) {
  const dataset = datasetKey === "intel" ? "intel" : "rss-aggregate";
  const payload = await api.getAdminNewsRaw({
    dataset,
    page: rawPaginationState[datasetKey],
    pageSize: RAW_PAGE_SIZE
  });
  applyRawNewsPayload(datasetKey, payload);
  return payload;
}

async function handleRawPaginationClick(datasetKey, direction) {
  const currentPage = rawPaginationState[datasetKey] || 1;
  rawPaginationState[datasetKey] = Math.max(1, currentPage + direction);
  try {
    await refreshRawNewsDataset(datasetKey);
  } catch (error) {
    rawPaginationState[datasetKey] = currentPage;
    console.error("raw news pagination failed", error);
  }
}

function renderMediaStreams(payload = {}) {
  elements.mediaStreamsUpdated.textContent = `Updated: ${formatDate(payload.generatedAt)}`;
  const rows = []
    .concat((payload?.sections?.situational || []).map((item) => ({ ...item, section: "situational" })))
    .concat((payload?.sections?.webcams || []).map((item) => ({ ...item, section: "webcams" })));

  if (!rows.length) {
    elements.mediaStreamsBody.innerHTML = renderEmptyRow(6, "No media stream data available.");
    return;
  }

  elements.mediaStreamsBody.innerHTML = rows
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.section)}</td>
          <td>${escapeHtml(item.name || "--")}</td>
          <td>${escapeHtml(item.kind || "--")}</td>
          <td>${escapeHtml(item.availability || "--")}</td>
          <td>${escapeHtml(item.mode || "--")}</td>
          <td>
            ${item.fallbackUrl ? `<a class="btn btn-sm btn-outline-info" href="${escapeHtml(item.fallbackUrl)}" target="_blank" rel="noopener noreferrer">Open</a>` : "--"}
          </td>
        </tr>
      `
    )
    .join("");
}

async function refreshAll({ forceMedia = false } = {}) {
  const [healthResult, limitsResult, pipelineResult, intelNewsResult, aggregateNewsResult, intelRawResult, aggregateRawResult, mediaResult] =
    await Promise.allSettled([
      api.getHealth(),
      api.getApiLimits(),
      api.getPipelineStatus(),
      api.getNews({ limit: 40, countries: "ALL" }),
      api.getAggregateNews({ limit: 40 }),
      api.getAdminNewsRaw({ dataset: "intel", page: rawPaginationState.intel, pageSize: RAW_PAGE_SIZE }),
      api.getAdminNewsRaw({ dataset: "rss-aggregate", page: rawPaginationState.rssAggregate, pageSize: RAW_PAGE_SIZE }),
      api.getMediaStreams(forceMedia ? { force: 1 } : {})
    ]);

  const health = healthResult.status === "fulfilled" ? healthResult.value : {};
  const limits = limitsResult.status === "fulfilled" ? limitsResult.value : { providers: [] };
  const pipeline = pipelineResult.status === "fulfilled" ? pipelineResult.value : {};
  const intelNews = intelNewsResult.status === "fulfilled" ? intelNewsResult.value?.news || [] : [];
  const aggregateNews =
    aggregateNewsResult.status === "fulfilled" ? aggregateNewsResult.value?.items || [] : [];
  const intelRaw = intelRawResult.status === "fulfilled" ? intelRawResult.value : null;
  const aggregateRaw = aggregateRawResult.status === "fulfilled" ? aggregateRawResult.value : null;
  const media = mediaResult.status === "fulfilled" ? mediaResult.value : {};

  renderServerSummary(health, pipeline);
  renderMediaSummary(media);
  renderPipelineStatus(pipeline);
  renderApiLimits(limits);
  renderNewsTable(intelNews, elements.intelNewsBody, elements.intelNewsCount);
  renderNewsTable(aggregateNews, elements.aggregateNewsBody, elements.aggregateNewsCount);
  applyRawNewsPayload("intel", intelRaw || {});
  applyRawNewsPayload("rssAggregate", aggregateRaw || {});
  renderMediaStreams(media);

  const now = formatDate(new Date().toISOString());
  elements.adminLastRefresh.textContent = `Updated: ${now}`;
}

function startPolling() {
  window.clearInterval(pollHandle);
  pollHandle = window.setInterval(() => {
    refreshAll().catch((error) => {
      console.error("admin refresh failed", error);
    });
  }, POLL_INTERVAL_MS);
}

async function bootstrap() {
  cacheElements();
  elements.refreshMediaStreamsBtn?.addEventListener("click", async () => {
    elements.refreshMediaStreamsBtn.disabled = true;
    try {
      await refreshAll({ forceMedia: true });
    } finally {
      elements.refreshMediaStreamsBtn.disabled = false;
    }
  });
  elements.intelNewsRawPrev?.addEventListener("click", async () => handleRawPaginationClick("intel", -1));
  elements.intelNewsRawNext?.addEventListener("click", async () => handleRawPaginationClick("intel", 1));
  elements.aggregateNewsRawPrev?.addEventListener("click", async () => handleRawPaginationClick("rssAggregate", -1));
  elements.aggregateNewsRawNext?.addEventListener("click", async () => handleRawPaginationClick("rssAggregate", 1));

  await refreshAll();
  startPolling();
  window.addEventListener("beforeunload", () => {
    window.clearInterval(pollHandle);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((error) => {
    console.error("admin bootstrap failed", error);
  });
});
