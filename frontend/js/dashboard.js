import { api } from "./api.js";
import { applyUpdate, getState, setSnapshot, subscribe } from "./state.js";
import { RealtimeSocket } from "./websocket.js";
import { HotspotMap, getLevelColor } from "./map.js";
import { mountSituationalWorkspace } from "./media/situationalWorkspace.js";
import { startWorldBrief } from "./intelligence/worldBrief.js";
import { startThreatClassifier } from "./intelligence/threatClassifier.js";
import { startRiskEngine } from "./intelligence/riskEngine.js";
import { startTrendDetector } from "./intelligence/trendDetector.js";
import { startEscalationHotspots } from "./intelligence/escalationHotspots.js";
import { startSignalAnomalies } from "./intelligence/signalAnomalies.js";

const LEVEL_RANK = {
  Stable: 1,
  Monitoring: 2,
  Elevated: 3,
  Critical: 4
};

const DEFAULT_WATCHLIST = ["US", "IL", "IR"];
const ANALYTICS_WINDOW_OPTIONS = [
  { label: "2h", minutes: 120 },
  { label: "6h", minutes: 360 },
  { label: "12h", minutes: 720 },
  { label: "24h", minutes: 1440 }
];
const CHART_COLORS = ["#49d6c5", "#ff8c42", "#f4c542", "#38c172", "#6fb1ff", "#ff4d4f", "#c59aff"];
const NEWS_PLACEHOLDER_SRC = "/assets/news-placeholder.svg";
const DIRECTION_COLORS = {
  Bullish: "#38c172",
  Bearish: "#ff4d4f",
  Volatile: "#ff8c42",
  Sideways: "#6fb1ff"
};
const MODE_BORDER_COLORS = {
  live: "#dff5ff",
  "web-delayed": "#6fb1ff",
  "historical-eod": "#9faebd",
  "router-stale": "#f4c542",
  "synthetic-fallback": "#ffb36b",
  stale: "#f4c542",
  fallback: "#ffb36b"
};
const MODE_POINT_STYLE = {
  live: "circle",
  "web-delayed": "rectRounded",
  "historical-eod": "rectRot",
  "router-stale": "rectRounded",
  "synthetic-fallback": "triangle",
  stale: "rectRounded",
  fallback: "triangle"
};

let hotspotMap;
let riskChart;
let impactTimelineChart;
let sectorBreakdownChart;
let impactScatterChart;
let socket;
let selectedCountries = new Set(DEFAULT_WATCHLIST);
let currentWatchlist = [...DEFAULT_WATCHLIST];
let apiLimitsPoller = null;
let analyticsRefreshTimer = null;
let latestAnalytics = null;
let latestAnalyticsContext = "";
let latestAnalyticsError = "";
let latestAnalyticsWindowMin = 120;
let analyticsRequestToken = 0;
let selectedCouplingTickers = [];
let couplingSelectionTouched = false;
let selectedAnalyticsWindowMin = 120;
let manualRefreshPendingId = null;
let manualRefreshState = "idle";
let manualRefreshMessage = "Refresh: idle";
let manualRefreshCooldownEndsAtMs = 0;
let manualRefreshCooldownTimer = null;
let newsDrawerInstance = null;
let currentNewsById = new Map();
const teardownHandlers = [];

const elements = {};

function byId(id) {
  return document.getElementById(id);
}

function cacheElements() {
  elements.sourceModeBadge = byId("source-mode-badge");
  elements.marketModeBadge = byId("market-mode-badge");
  elements.wsStatusBadge = byId("ws-status-badge");
  elements.lastUpdateText = byId("last-update-text");
  elements.marketUpdatedText = byId("market-updated-text");
  elements.marketCoverageText = byId("market-coverage-text");
  elements.newsCount = byId("news-count");
  elements.newsFeed = byId("news-feed");
  elements.predictionsList = byId("predictions-list");
  elements.insightsList = byId("insights-list");
  elements.riskChart = byId("risk-chart");
  elements.impactTimelineChart = byId("impact-timeline-chart");
  elements.sectorBreakdownChart = byId("sector-breakdown-chart");
  elements.impactScatterChart = byId("impact-scatter-chart");
  elements.distCritical = byId("dist-critical");
  elements.distElevated = byId("dist-elevated");
  elements.distMonitoring = byId("dist-monitoring");
  elements.distStable = byId("dist-stable");
  elements.countryFilterBar = byId("country-filter-bar");
  elements.marketQuotesBody = byId("market-quotes-body");
  elements.marketImpactList = byId("market-impact-list");
  elements.qualityHotspotsBadge = byId("quality-hotspots-badge");
  elements.qualityNewsBadge = byId("quality-news-badge");
  elements.qualityMarketBadge = byId("quality-market-badge");
  elements.qualityImpactBadge = byId("quality-impact-badge");
  elements.qualityInsightsBadge = byId("quality-insights-badge");
  elements.panelHotspots = byId("panel-hotspots");
  elements.panelNews = byId("panel-news");
  elements.panelRisk = byId("panel-risk");
  elements.panelMarket = byId("panel-market");
  elements.panelInsights = byId("panel-insights");
  elements.panelAdvancedIntel = byId("panel-advanced-intel");
  elements.panelSituational = byId("panel-situational");
  elements.panelWebcams = byId("panel-webcams");
  elements.apiLimitsPanel = byId("api-limits-panel");
  elements.toggleApiLimits = byId("toggle-api-limits");
  elements.pipelineStatusBody = byId("pipeline-status-body");
  elements.pipelineDiagnosticsBody = byId("pipeline-diagnostics-body");
  elements.apiLimitsBody = byId("api-limits-body");
  elements.apiLimitsUpdated = byId("api-limits-updated");
  elements.rssFeedStatusBody = byId("rss-feed-status-body");
  elements.analyticsStatus = byId("analytics-status");
  elements.analyticsWindowSelector = byId("analytics-window-selector");
  elements.couplingTickerSelector = byId("coupling-ticker-selector");
  elements.recentCycleErrorsBody = byId("recent-cycle-errors-body");
  elements.refreshNewsBtn = byId("refresh-news-btn");
  elements.refreshNewsStatus = byId("refresh-news-status");
  elements.newsDrawer = byId("news-detail-drawer");
  elements.newsDrawerTitle = byId("news-detail-title");
  elements.newsDrawerMeta = byId("news-drawer-meta");
  elements.newsDrawerImage = byId("news-drawer-image");
  elements.newsDrawerBody = byId("news-drawer-body");
  elements.newsDrawerLink = byId("news-drawer-link");
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderEmptyStateCard(message, actionLabel = "") {
  const button = actionLabel
    ? `<div class="mt-2"><button class="btn btn-sm btn-outline-info" type="button" data-action="show-all-countries">${escapeHtml(
      actionLabel
    )}</button></div>`
    : "";
  return `<div class="empty-state-card small text-light-emphasis">${escapeHtml(message)}${button}</div>`;
}

function initNewsDrawer() {
  if (!elements.newsDrawer || !window.bootstrap?.Offcanvas) {
    return;
  }

  newsDrawerInstance = window.bootstrap.Offcanvas.getOrCreateInstance(elements.newsDrawer);
}

function resolveNewsText(article = {}) {
  return String(article.fullText || article.content || article.excerpt || article.description || "").trim();
}

function resolveNewsExcerpt(article = {}) {
  const value = String(article.excerpt || article.description || article.fullText || article.content || "").trim();
  return value || "No summary available.";
}

function buildNewsParagraphs(article = {}) {
  const fullText = resolveNewsText(article);
  const paragraphs = fullText
    .split(/\n{2,}|\r\n\r\n/)
    .map((paragraph) => String(paragraph || "").trim())
    .filter(Boolean);

  if (paragraphs.length) {
    return paragraphs.slice(0, 10);
  }

  const excerpt = resolveNewsExcerpt(article);
  return excerpt ? [excerpt] : [];
}

function openNewsDrawer(articleId = "") {
  const article = currentNewsById.get(articleId);
  if (!article || !elements.newsDrawerTitle || !elements.newsDrawerMeta || !elements.newsDrawerBody || !elements.newsDrawerLink) {
    return;
  }

  const level = deriveArticleLevel(article, getState().countries || {});
  const mentions = article.countryMentions?.length ? article.countryMentions.join(", ") : "Global";
  const metaItems = [article.sourceName || "Unknown Source", formatDate(article.publishedAt), level, mentions, String(article.provider || "").toUpperCase()].filter(Boolean);
  const leadImageUrl = String(article.leadImageUrl || article.imageUrl || "").trim();

  elements.newsDrawerTitle.textContent = String(article.title || "Headline").trim() || "Headline";
  elements.newsDrawerMeta.innerHTML = metaItems
    .map((item) => `<span class="news-meta-pill">${escapeHtml(item)}</span>`)
    .join("");
  elements.newsDrawerBody.innerHTML = buildNewsParagraphs(article)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");

  if (leadImageUrl) {
    elements.newsDrawerImage.classList.remove("d-none");
    elements.newsDrawerImage.innerHTML = `<img src="${escapeHtml(leadImageUrl)}" alt="news lead" loading="lazy" referrerpolicy="no-referrer" />`;
  } else {
    elements.newsDrawerImage.classList.add("d-none");
    elements.newsDrawerImage.innerHTML = "";
  }

  elements.newsDrawerLink.href = String(article.url || "#");
  elements.newsDrawerLink.classList.toggle("disabled", !article.url);
  elements.newsDrawerLink.setAttribute("aria-disabled", article.url ? "false" : "true");

  newsDrawerInstance?.show();
}

function ensureChartOverlay(canvas) {
  if (!canvas?.parentElement) {
    return null;
  }

  let overlay = canvas.parentElement.querySelector(".chart-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "chart-overlay";
    canvas.parentElement.appendChild(overlay);
  }

  return overlay;
}

function setChartOverlay(canvas, message = "") {
  const overlay = ensureChartOverlay(canvas);
  if (!overlay) {
    return;
  }

  if (!message) {
    overlay.classList.remove("visible");
    overlay.textContent = "";
    return;
  }

  overlay.textContent = message;
  overlay.classList.add("visible");
}

function renderAnalyticsStatus(message = "") {
  if (!elements.analyticsStatus) {
    return;
  }

  if (!message) {
    elements.analyticsStatus.classList.add("d-none");
    elements.analyticsStatus.textContent = "";
    return;
  }

  elements.analyticsStatus.textContent = message;
  elements.analyticsStatus.classList.remove("d-none");
}

function renderAnalyticsWindowSelector() {
  if (!elements.analyticsWindowSelector) {
    return;
  }

  elements.analyticsWindowSelector.innerHTML = `
    <div class="chart-selector-help small text-light-emphasis">Analytics window</div>
    <div class="chart-selector-chips">
      ${ANALYTICS_WINDOW_OPTIONS.map((option) => {
    const activeClass = option.minutes === selectedAnalyticsWindowMin ? "active" : "";
    return `<button class="chart-selector-chip ${activeClass}" type="button" data-action="set-analytics-window" data-window-min="${option.minutes}">${option.label}</button>`;
  }).join("")}
    </div>
  `;
}

const tickerBubbleLabelPlugin = {
  id: "tickerBubbleLabelPlugin",
  afterDatasetsDraw(chart) {
    if (chart.canvas?.id !== "sector-breakdown-chart") {
      return;
    }

    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '600 10px "IBM Plex Sans", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      meta.data.forEach((element, index) => {
        const point = dataset.data?.[index];
        if (!point?.ticker) {
          return;
        }

        const shortMode = marketModeShortLabel(point.dataMode);
        const suffix = shortMode ? ` ${shortMode}` : "";
        ctx.fillStyle = "#eef6ff";
        ctx.fillText(`${point.ticker}${suffix}`, element.x, element.y - (point.r || 6) - 6);
      });
    });
    ctx.restore();
  }
};

Chart.register(tickerBubbleLabelPlugin);

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
  const totalSeconds = Math.max(0, Math.round(Number(value || 0) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatWindowLabel(minutes) {
  const normalized = Number(minutes || 0);
  if (normalized >= 1440) {
    return "24h";
  }
  if (normalized >= 60) {
    return `${Math.round(normalized / 60)}h`;
  }
  return `${normalized}m`;
}

function normalizeMarketDataMode(mode = "synthetic-fallback") {
  const normalized = String(mode || "").toLowerCase();
  if (normalized === "fallback") {
    return "synthetic-fallback";
  }
  if (normalized === "stale") {
    return "router-stale";
  }
  return normalized || "synthetic-fallback";
}

function marketModeLabel(mode = "synthetic-fallback") {
  const normalized = normalizeMarketDataMode(mode);
  if (normalized === "live") {
    return "LIVE";
  }
  if (normalized === "web-delayed") {
    return "WEB DELAYED";
  }
  if (normalized === "historical-eod") {
    return "EOD";
  }
  if (normalized === "router-stale") {
    return "STALE CACHE";
  }
  return "SIM";
}

function marketModeShortLabel(mode = "synthetic-fallback") {
  const normalized = normalizeMarketDataMode(mode);
  if (normalized === "web-delayed") {
    return "W";
  }
  if (normalized === "historical-eod") {
    return "E";
  }
  if (normalized === "router-stale") {
    return "C";
  }
  if (normalized === "synthetic-fallback") {
    return "S";
  }
  return "";
}

function marketModeClass(mode = "synthetic-fallback") {
  return `market-mode-${normalizeMarketDataMode(mode)}`;
}

function deriveQuoteAgeMin(quote = {}) {
  if (Number.isFinite(quote?.quoteAgeMin)) {
    return quote.quoteAgeMin;
  }

  const asOfTime = new Date(quote?.asOf || quote?.staleAt || 0).getTime();
  if (!Number.isFinite(asOfTime) || asOfTime <= 0) {
    return null;
  }

  return Math.max(0, Math.round((Date.now() - asOfTime) / 60_000));
}

function formatCompactList(values = [], fallback = "--") {
  if (!Array.isArray(values) || !values.length) {
    return fallback;
  }
  return values.join(", ");
}

function formatRemainingSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function resolveManualCooldownMs() {
  return Math.max(0, manualRefreshCooldownEndsAtMs - Date.now());
}

function renderManualRefreshControls() {
  if (!elements.refreshNewsBtn || !elements.refreshNewsStatus) {
    return;
  }

  const cooldownMs = resolveManualCooldownMs();
  let statusClass = "small text-light-emphasis";
  let buttonLabel = "Update";
  let disabled = false;
  let statusText = manualRefreshMessage || "Refresh: idle";

  if (manualRefreshState === "loading") {
    statusClass = "small refresh-status-loading";
    buttonLabel = "Updating";
    statusText = "Refresh: in progress...";
    disabled = true;
  } else if (cooldownMs > 0) {
    statusClass = "small refresh-status-cooldown";
    buttonLabel = "Cooldown";
    statusText = `Refresh: cooldown ${formatRemainingSeconds(cooldownMs / 1_000)}`;
    disabled = true;
  } else if (manualRefreshState === "ok") {
    statusClass = "small refresh-status-ok";
  } else if (manualRefreshState === "error") {
    statusClass = "small refresh-status-error";
  }

  elements.refreshNewsBtn.textContent = buttonLabel;
  elements.refreshNewsBtn.disabled = disabled;
  elements.refreshNewsStatus.className = statusClass;
  elements.refreshNewsStatus.textContent = statusText;
}

function setManualRefreshState(state, message) {
  manualRefreshState = state;
  manualRefreshMessage = message || manualRefreshMessage;
  renderManualRefreshControls();
}

function startManualRefreshCooldown(ms) {
  const durationMs = Number(ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return;
  }

  manualRefreshCooldownEndsAtMs = Date.now() + durationMs;
  clearInterval(manualRefreshCooldownTimer);
  manualRefreshCooldownTimer = setInterval(() => {
    if (resolveManualCooldownMs() <= 0) {
      clearInterval(manualRefreshCooldownTimer);
      manualRefreshCooldownTimer = null;
      if (manualRefreshState === "idle") {
        setManualRefreshState("idle", "Refresh: idle");
      } else {
        renderManualRefreshControls();
      }
      return;
    }
    renderManualRefreshControls();
  }, 1_000);
}

function resolveRetryAfterMs(error) {
  const fromDetails = Number(error?.details?.retryAfterMs);
  if (Number.isFinite(fromDetails) && fromDetails > 0) {
    return fromDetails;
  }

  const fromHeader = Number(error?.retryAfterSec);
  if (Number.isFinite(fromHeader) && fromHeader > 0) {
    return fromHeader * 1_000;
  }

  return 0;
}

function syncManualRefreshFromMeta(meta = {}) {
  const refreshStatus = meta?.refreshStatus || {};
  const lastRefreshId = refreshStatus.lastRefreshId || null;

  if (manualRefreshPendingId && refreshStatus.inProgress && lastRefreshId === manualRefreshPendingId) {
    setManualRefreshState("loading", "Refresh: in progress...");
    return;
  }

  if (manualRefreshPendingId && !refreshStatus.inProgress && lastRefreshId === manualRefreshPendingId) {
    manualRefreshPendingId = null;
    const suffix = refreshStatus.lastCompletedAt ? ` (${formatShortTime(refreshStatus.lastCompletedAt)})` : "";
    setManualRefreshState("ok", `Refresh: completed${suffix}`);
    return;
  }

  if (manualRefreshState === "loading" && !refreshStatus.inProgress && !manualRefreshPendingId) {
    setManualRefreshState("idle", "Refresh: idle");
    return;
  }

  renderManualRefreshControls();
}

function wsBadgeClass(status) {
  if (status === "connected") {
    return "text-bg-success";
  }
  if (status === "reconnecting" || status === "connecting") {
    return "text-bg-warning";
  }
  if (status === "error") {
    return "text-bg-danger";
  }
  return "text-bg-secondary";
}

function sourceBadgeClass(mode) {
  if (mode === "disabled") {
    return "text-bg-secondary";
  }
  return mode === "live" ? "text-bg-success" : "text-bg-warning";
}

function qualityBadgeClass(mode) {
  if (mode === "disabled") {
    return "badge-data-disabled";
  }
  if (mode === "live") {
    return "badge-data-live";
  }
  if (mode === "mixed") {
    return "badge-data-mixed";
  }
  return "badge-data-fallback";
}

function levelBadgeClass(level) {
  if (level === "Critical") {
    return "badge-level-critical";
  }
  if (level === "Elevated") {
    return "badge-level-elevated";
  }
  if (level === "Monitoring") {
    return "badge-level-monitoring";
  }
  return "badge-level-stable";
}

function newsLevelClass(level) {
  if (level === "Critical") {
    return "news-level-critical";
  }
  if (level === "Elevated") {
    return "news-level-elevated";
  }
  if (level === "Monitoring") {
    return "news-level-monitoring";
  }
  return "news-level-stable";
}

function selectedIncludesAll() {
  return selectedCountries.has("ALL");
}

function activeCountryList() {
  if (selectedIncludesAll()) {
    return [];
  }
  return [...selectedCountries];
}

function intersectsCountries(mentions = [], countriesSet) {
  if (!countriesSet.size) {
    return true;
  }
  return mentions.some((iso2) => countriesSet.has(iso2));
}

function filterMapAssetsBySelection(mapAssets = {}, countriesSet) {
  if (!countriesSet?.size) {
    return mapAssets;
  }

  const filterItems = (items = []) =>
    items.filter((item) => {
      if (item?.alwaysVisible) {
        return true;
      }
      return intersectsCountries(item.countries || (item.country ? [item.country] : []), countriesSet);
    });

  return {
    ...mapAssets,
    staticPoints: filterItems(mapAssets.staticPoints || []),
    movingSeeds: filterItems(mapAssets.movingSeeds || [])
  };
}

function filterStateBySelection(state) {
  if (selectedIncludesAll()) {
    return state;
  }

  const countriesSet = new Set(activeCountryList());
  const filteredNews = state.news.filter((article) => intersectsCountries(article.countryMentions || [], countriesSet));
  const filteredHotspots = state.hotspots.filter((hotspot) => countriesSet.has(hotspot.iso2));
  const filteredCountries = Object.fromEntries(
    Object.entries(state.countries || {}).filter(([iso2]) => countriesSet.has(iso2))
  );
  const filteredInsights = state.insights.filter((insight) => countriesSet.has(insight.iso2));
  const filteredImpactItems = (state.impact?.items || []).filter((item) =>
    intersectsCountries(item.linkedCountries || [], countriesSet)
  );
  const filteredMapAssets = filterMapAssetsBySelection(state.mapAssets || { staticPoints: [], movingSeeds: [] }, countriesSet);

  return {
    ...state,
    news: filteredNews,
    hotspots: filteredHotspots,
    countries: filteredCountries,
    insights: filteredInsights,
    mapAssets: filteredMapAssets,
    impact: {
      ...(state.impact || {}),
      items: filteredImpactItems
    }
  };
}

function deriveArticleLevel(article, countries) {
  let selectedLevel = "Stable";
  for (const iso2 of article.countryMentions || []) {
    const level = countries?.[iso2]?.level || "Stable";
    if ((LEVEL_RANK[level] || 0) > (LEVEL_RANK[selectedLevel] || 0)) {
      selectedLevel = level;
    }
  }
  return selectedLevel;
}

function setPanelMode(panel, mode) {
  if (!panel) {
    return;
  }
  panel.classList.remove("panel-fallback", "panel-mixed");
  if (mode === "fallback") {
    panel.classList.add("panel-fallback");
  }
  if (mode === "mixed") {
    panel.classList.add("panel-mixed");
  }
}

function setQualityBadge(element, label, quality = {}) {
  if (!element) {
    return;
  }
  const mode = quality.mode || "fallback";
  element.className = `badge ${qualityBadgeClass(mode)}`;
  const suffix = mode === "fallback" && quality.synthetic ? " (SIM)" : "";
  element.textContent = `${label}: ${mode}${suffix}`;
  element.title = quality.reason || "";
}

function renderMeta(meta, market) {
  elements.sourceModeBadge.className = `badge ${sourceBadgeClass(meta.sourceMode)}`;
  elements.sourceModeBadge.textContent = `Source: ${meta.sourceMode}`;

  elements.marketModeBadge.className = `badge ${sourceBadgeClass(market.sourceMode)}`;
  elements.marketModeBadge.textContent = `Market: ${market.sourceMode || "fallback"}`;

  elements.lastUpdateText.textContent = `Last update: ${formatDate(meta.lastRefreshAt)}`;
  elements.marketUpdatedText.textContent =
    market.sourceMode === "disabled" ? "Quotes: market disabled" : `Quotes: ${formatDate(market.updatedAt)}`;
  if (elements.marketCoverageText) {
    const coverage = market.coverageByMode || market.sourceMeta?.coverageByMode || {};
      elements.marketCoverageText.textContent =
        market.sourceMode === "disabled"
          ? "Coverage: market disabled"
          : `Coverage: ${coverage.live || 0} live / ${coverage.webDelayed || 0} web delayed / ${coverage.historicalEod || 0} EOD / ${coverage.routerStale || 0} stale cache / ${coverage.syntheticFallback || 0} sim`;
    }

  const dq = meta.dataQuality || {};
  setQualityBadge(elements.qualityHotspotsBadge, "Hotspots", dq.news || {});
  setQualityBadge(elements.qualityNewsBadge, "News", dq.news || {});
  setQualityBadge(elements.qualityMarketBadge, "Market", dq.market || {});
  setQualityBadge(elements.qualityImpactBadge, "Impact", dq.impact || {});
  setQualityBadge(elements.qualityInsightsBadge, "AI", dq.insights || {});

  setPanelMode(elements.panelHotspots, dq.news?.mode || "fallback");
  setPanelMode(elements.panelNews, dq.news?.mode || "fallback");
  setPanelMode(elements.panelRisk, dq.news?.mode || "fallback");
  setPanelMode(elements.panelMarket, dq.market?.mode || "fallback");
  setPanelMode(elements.panelInsights, dq.insights?.mode || "fallback");
  setPanelMode(elements.panelAdvancedIntel, dq.insights?.mode || "fallback");
  setPanelMode(elements.panelSituational, dq.news?.mode || "fallback");
  setPanelMode(elements.panelWebcams, dq.news?.mode || "fallback");
}

function renderCountryFilters() {
  const options = ["ALL", ...currentWatchlist];
  elements.countryFilterBar.innerHTML = options
    .map((iso2) => {
      const active = selectedCountries.has(iso2) ? "active" : "";
      return `<button class="filter-chip ${active}" data-country="${iso2}" type="button">${iso2}</button>`;
    })
    .join("");
}

function handleFilterClick(event) {
  const button = event.target.closest("[data-country]");
  if (!button) {
    return;
  }

  const country = button.dataset.country;
  if (country === "ALL") {
    selectedCountries = new Set(["ALL"]);
    renderCountryFilters();
    requestFilteredSnapshot();
    return;
  }

  if (selectedCountries.has("ALL")) {
    selectedCountries.delete("ALL");
  }

  if (selectedCountries.has(country)) {
    selectedCountries.delete(country);
  } else {
    selectedCountries.add(country);
  }

  if (!selectedCountries.size) {
    selectedCountries = new Set(currentWatchlist);
  }

  renderCountryFilters();
  requestFilteredSnapshot();
}

function showAllCountries() {
  selectedCountries = new Set(["ALL"]);
  renderCountryFilters();
  requestFilteredSnapshot();
}

function toggleCouplingTicker(ticker) {
  const normalizedTicker = String(ticker || "").trim().toUpperCase();
  if (!normalizedTicker) {
    return;
  }

  const alreadySelected = selectedCouplingTickers.includes(normalizedTicker);
  couplingSelectionTouched = true;

  if (alreadySelected) {
    if (selectedCouplingTickers.length <= 1) {
      return;
    }
    selectedCouplingTickers = selectedCouplingTickers.filter((candidate) => candidate !== normalizedTicker);
  } else if (selectedCouplingTickers.length >= 4) {
    selectedCouplingTickers = [...selectedCouplingTickers.slice(1), normalizedTicker];
  } else {
    selectedCouplingTickers = [...selectedCouplingTickers, normalizedTicker];
  }

  renderDashboard(getState());
}

function handleActionClick(event) {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) {
    return;
  }

  if (trigger.dataset.action === "show-all-countries") {
    event.preventDefault();
    showAllCountries();
    return;
  }

  if (trigger.dataset.action === "toggle-coupling-ticker") {
    event.preventDefault();
    toggleCouplingTicker(trigger.dataset.ticker);
    return;
  }

  if (trigger.dataset.action === "open-news") {
    event.preventDefault();
    openNewsDrawer(trigger.dataset.newsId);
    return;
  }

  if (trigger.dataset.action === "set-analytics-window") {
    event.preventDefault();
    const windowMin = Number.parseInt(trigger.dataset.windowMin || "", 10);
    if (Number.isFinite(windowMin) && windowMin > 0 && windowMin !== selectedAnalyticsWindowMin) {
      selectedAnalyticsWindowMin = windowMin;
      renderAnalyticsWindowSelector();
      refreshAnalytics();
    }
  }
}

function hasPositiveCountryScores(countries = {}) {
  return Object.values(countries || {}).some((country) => Number(country?.score || 0) > 0);
}

function resolveInsightsEmptyReason(rawState, filteredState) {
  if ((filteredState.insights || []).length) {
    return null;
  }

  if (!selectedIncludesAll()) {
    if (!hasPositiveCountryScores(rawState.countries || {})) {
      return `Watchlist focus is active. No country insights were produced for ${selectedCountryQueryValue()}. Switch to ALL to inspect broader country signals.`;
    }
    return `Watchlist focus is active. No country insights matched ${selectedCountryQueryValue()}. Switch to ALL to inspect broader country signals.`;
  }

  if (!hasPositiveCountryScores(rawState.countries || {})) {
    return "No country-level risk signals survived the current news selection.";
  }

  return rawState.meta?.emptyStates?.insights || "No country insights available for the current filters.";
}

function resolveImpactEmptyReason(rawState, filteredState) {
  if ((filteredState.impact?.items || []).length) {
    return null;
  }

  if (!(filteredState.news || []).length) {
    return !selectedIncludesAll()
      ? `Watchlist focus is active. No intelligence items matched ${selectedCountryQueryValue()}. Switch to ALL to inspect broader signals.`
      : "No intelligence items available for the current filters.";
  }

  if (!selectedIncludesAll()) {
    return `Watchlist focus is active. No linked news-to-ticker signals matched ${selectedCountryQueryValue()} in the current event window. Switch to ALL to inspect broader market linkage.`;
  }

  return (
    rawState.impact?.emptyReason ||
    rawState.meta?.emptyStates?.impact ||
    "No linked news-to-ticker signals were found in the current event window."
  );
}

function renderNews(news = [], countries = {}) {
  const ordered = [...news].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  elements.newsCount.textContent = `${ordered.length} items`;
  currentNewsById = new Map(ordered.map((article) => [String(article.id), article]));

  if (!ordered.length) {
    elements.newsFeed.innerHTML = '<div class="p-3 small text-light-emphasis">No intelligence items available.</div>';
    return;
  }

  elements.newsFeed.innerHTML = ordered
    .slice(0, 40)
    .map((article) => {
      const level = deriveArticleLevel(article, countries);
      const mentions = article.countryMentions?.length ? article.countryMentions.join(", ") : "Global";
      const title = String(article.title || "").trim() || "Untitled headline";
      const description = resolveNewsExcerpt(article);
      const safeImageUrl = String(article.leadImageUrl || article.imageUrl || "").trim();
      const thumbnail = safeImageUrl
        ? `<img class="news-thumb" src="${escapeHtml(safeImageUrl)}" alt="news image" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${NEWS_PLACEHOLDER_SRC}';this.classList.add('news-thumb-fallback')" />`
        : `<img class="news-thumb news-thumb-placeholder news-thumb-fallback" src="${NEWS_PLACEHOLDER_SRC}" alt="No image" loading="lazy" />`;
      const flag = article.synthetic ? '<span class="news-flag">SIMULATED</span>' : "";
      const provider = String(article.provider || "").toUpperCase() || "RSS";

      return `
      <article class="news-item ${newsLevelClass(level)}">
        ${thumbnail}
        <div class="news-content">
          <h3>${escapeHtml(title)}</h3>
          <p class="news-item-excerpt">${escapeHtml(description)}</p>
          <div class="news-item-footer">
            <div class="news-item-meta">
              <span class="news-meta-pill">${escapeHtml(article.sourceName)}</span>
              <span class="news-meta-pill">${formatDate(article.publishedAt)}</span>
              <span class="news-meta-pill">${escapeHtml(level)}</span>
              <span class="news-meta-pill">${escapeHtml(mentions)}</span>
              <span class="news-meta-pill">${escapeHtml(provider)}</span>
              ${flag}
            </div>
            <div class="news-card-actions">
              <button class="btn btn-sm btn-outline-info news-card-cta" type="button" data-action="open-news" data-news-id="${escapeHtml(
        article.id
      )}">Open brief</button>
              <a class="btn btn-sm btn-outline-light" href="${escapeHtml(article.url || "#")}" target="_blank" rel="noopener noreferrer">Source</a>
            </div>
          </div>
        </div>
      </article>
    `;
    })
    .join("");
}

function distributionFromCountries(countries) {
  const totals = {
    Critical: 0,
    Elevated: 0,
    Monitoring: 0,
    Stable: 0
  };

  for (const country of Object.values(countries || {})) {
    totals[country.level] += 1;
  }
  return totals;
}

function renderDistribution(countries) {
  const totals = distributionFromCountries(countries);
  elements.distCritical.textContent = `Critical: ${totals.Critical}`;
  elements.distElevated.textContent = `Elevated: ${totals.Elevated}`;
  elements.distMonitoring.textContent = `Monitoring: ${totals.Monitoring}`;
  elements.distStable.textContent = `Stable: ${totals.Stable}`;
}

function chartAxesOptions() {
  return {
    x: {
      ticks: { color: "#e1eefc", maxTicksLimit: 8 },
      grid: { color: "rgba(151, 169, 190, 0.2)" },
      border: { color: "rgba(151, 169, 190, 0.26)" }
    },
    y: {
      beginAtZero: true,
      ticks: { color: "#e1eefc" },
      grid: { color: "rgba(151, 169, 190, 0.22)" },
      border: { color: "rgba(151, 169, 190, 0.26)" }
    }
  };
}

function initRiskChart() {
  riskChart = new Chart(elements.riskChart.getContext("2d"), {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        {
          label: "Risk Score",
          data: [],
          backgroundColor: [],
          borderRadius: 6,
          borderSkipped: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: chartAxesOptions()
    }
  });
}

function initImpactTimelineChart() {
  impactTimelineChart = new Chart(elements.impactTimelineChart.getContext("2d"), {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        {
          label: "Prediction Score",
          data: [],
          backgroundColor: [],
          borderRadius: 8,
          borderSkipped: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const confidence = context.dataset.confidenceMap?.[context.dataIndex] ?? "--";
              return `score: ${context.raw} | confidence: ${confidence}%`;
            }
          }
        }
      },
      scales: chartAxesOptions()
    }
  });
}

function initSectorBreakdownChart() {
  sectorBreakdownChart = new Chart(elements.sectorBreakdownChart.getContext("2d"), {
    type: "bubble",
    data: {
      datasets: [
        {
          label: "Ticker Outlook Matrix",
          data: [],
          pointRadius(context) {
            return context.raw?.r || 6;
          },
          pointHoverRadius(context) {
            return (context.raw?.r || 6) + 2;
          }
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const raw = context.raw || {};
              return `${raw.ticker || "N/A"} | ${raw.direction || "Sideways"} | score: ${raw.predictionScore || 0} | mode: ${marketModeLabel(
                normalizeMarketDataMode(raw.dataMode || "synthetic-fallback")
              )}`;
            }
          }
        }
      },
      scales: {
        x: {
          ...chartAxesOptions().x,
          min: 0,
          suggestedMax: 10,
          title: { display: true, text: "Event Score", color: "#c7d4e2" }
        },
        y: {
          ...chartAxesOptions().y,
          suggestedMax: 100,
          title: { display: true, text: "Predicted Confidence", color: "#c7d4e2" }
        }
      }
    }
  });
}

function initImpactScatterChart() {
  impactScatterChart = new Chart(elements.impactScatterChart.getContext("2d"), {
    type: "line",
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: {
        mode: "index",
        intersect: false
      },
      plugins: { legend: { labels: { color: "#c7d4e2" } } },
      scales: {
        x: { ...chartAxesOptions().x, title: { display: true, text: "Time", color: "#c7d4e2" } },
        yImpact: {
          ...chartAxesOptions().y,
          title: { display: true, text: "Impact Score", color: "#c7d4e2" }
        },
        yPrice: {
          ...chartAxesOptions().y,
          position: "right",
          title: { display: true, text: "Price Reaction %", color: "#c7d4e2" },
          grid: { drawOnChartArea: false, color: "rgba(151, 169, 190, 0.12)" }
        }
      }
    }
  });
}

function renderRiskChart(countries) {
  const topCountries = Object.values(countries || {})
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  riskChart.data.labels = topCountries.map((country) => `${country.iso2} ${country.country}`);
  riskChart.data.datasets[0].data = topCountries.map((country) => country.score);
  riskChart.data.datasets[0].backgroundColor = topCountries.map((country) => getLevelColor(country.level));
  riskChart.update();
}

function renderPredictions(predictions = { sectors: [] }) {
  const sectors = predictions.sectors || [];
  if (!sectors.length) {
    elements.predictionsList.innerHTML = '<div class="p-3 small text-light-emphasis">No predictions available.</div>';
    return;
  }

  elements.predictionsList.innerHTML = sectors
    .map(
      (prediction) => `
      <article class="prediction-item">
        <div class="title-row">
          <strong>${escapeHtml(prediction.sector.toUpperCase())}</strong>
          <span class="badge ${qualityBadgeClass(prediction.inputMode || "fallback")}">${escapeHtml(
        prediction.direction
      )}</span>
        </div>
        <div class="prediction-meta">
          Confidence: ${prediction.confidence}% | Horizon: ${prediction.horizonHours}h | Tickers: ${prediction.tickers?.join(", ") || "N/A"
        }
        </div>
        <div class="insight-drivers mt-1">
          ${(prediction.drivers || [])
          .map((driver) => `<span class="driver-pill">${escapeHtml(driver)}</span>`)
          .join("")}
        </div>
      </article>
    `
    )
    .join("");
}

function renderInsights(insights = [], emptyReason = "") {
  if (!insights.length) {
    elements.insightsList.innerHTML = renderEmptyStateCard(
      emptyReason || "No insights available.",
      selectedIncludesAll() ? "" : "View ALL countries"
    );
    return;
  }

  const trendGlyph = {
    Escalating: "^",
    "De-escalating": "v",
    Flat: "-"
  };

  const filterNotice = !selectedIncludesAll() && insights.length < Math.min(4, currentWatchlist.length) ? `<div class="filter-notice small"><strong>Watchlist filter active.</strong> You are viewing a narrowed country set. <button class="btn btn-sm btn-outline-info mt-2" type="button" data-action="show-all-countries">View ALL</button></div>` : "";

  elements.insightsList.innerHTML = filterNotice + insights
    .map(
      (insight) => `
      <article class="insight-item">
        <div class="insight-header">
          <h3 class="insight-title mb-0">${escapeHtml(insight.country)}</h3>
          <span class="badge ${levelBadgeClass(insight.level)}">${escapeHtml(insight.level)}</span>
        </div>
        <p class="insight-summary">${escapeHtml(insight.summary)}</p>
        <div class="small text-light-emphasis mb-2">
          Trend: ${trendGlyph[insight.trend] || "-"} ${escapeHtml(insight.trend)} | Confidence: ${insight.confidence}%
        </div>
        <div class="insight-drivers">
          ${(insight.drivers || []).map((driver) => `<span class="driver-pill">${escapeHtml(driver)}</span>`).join("")}
        </div>
      </article>
    `
    )
    .join("");
}

function renderMarketQuotes(market = { quotes: {} }) {
  const quotes = Object.entries(market.quotes || {});
  if (!quotes.length) {
    elements.marketQuotesBody.innerHTML = '<tr><td colspan="3" class="text-light-emphasis">No market quotes available.</td></tr>';
    return;
  }

  elements.marketQuotesBody.innerHTML = quotes
    .map(([ticker, quote]) => {
      const change = Number(quote.changePct || 0);
      const cls = change >= 0 ? "text-up" : "text-down";
      const sign = change >= 0 ? "+" : "";
      const mode = normalizeMarketDataMode(quote.dataMode || (quote.synthetic ? "synthetic-fallback" : "live"));
      const modeCell = `<span class="market-mode-pill ${marketModeClass(mode)}">${marketModeLabel(mode)}</span>`;
      const quoteAgeMin = deriveQuoteAgeMin(quote);
      const ageLabel = Number.isFinite(quoteAgeMin) ? `${quoteAgeMin}m old` : "age --";
      const sourceLabel = quote.source || "unknown";
      return `
        <tr>
          <td>
            <div class="market-quote-head">
              <strong>${escapeHtml(ticker)}</strong>
              ${modeCell}
            </div>
            <div class="market-quote-meta">${escapeHtml(sourceLabel)} | ${escapeHtml(ageLabel)}</div>
          </td>
          <td>${Number.isFinite(quote.price) ? quote.price.toFixed(2) : "--"}</td>
          <td class="${cls}">${sign}${change.toFixed(2)}%</td>
        </tr>
      `;
    })
    .join("");
}

function renderImpact(impact = { items: [] }) {
  const items = (impact.items || []).filter(
    (item) => Number(item?.eventScore || 0) > 0 || Number(item?.impactScore || 0) > 0
  );
  if (!items.length) {
    elements.marketImpactList.innerHTML = renderEmptyStateCard(
      impact.emptyReason || "No impact signals available for current filters.",
      impact.showAllAction ? "View ALL countries" : ""
    );
    return;
  }

  elements.marketImpactList.innerHTML = items
    .slice(0, 20)
    .map((item) => {
      const quoteMode = normalizeMarketDataMode(item.quote?.dataMode || (item.quote?.synthetic ? "synthetic-fallback" : "live"));
      const quoteAgeMin = deriveQuoteAgeMin(item.quote || {});
      const quoteAgeLabel = Number.isFinite(quoteAgeMin) ? `${quoteAgeMin}m` : "--";
      return `
      <article class="impact-item">
        <div class="impact-header">
          <span><strong>${escapeHtml(item.ticker)}</strong> <span class="text-light-emphasis">(${escapeHtml(
        item.level
      )})</span></span>
          <span class="impact-score">${item.impactScore.toFixed(2)}</span>
        </div>
        <div class="impact-meta">
          mode: ${escapeHtml(item.inputMode || "live")} | eventScore: ${item.eventScore.toFixed(
        2
      )} | priceReaction: ${item.priceReaction.toFixed(2)}% | countries: ${(item.linkedCountries || []).join(", ") || "N/A"}
        </div>
        <div class="impact-meta">
          quote: ${escapeHtml(marketModeLabel(quoteMode))} | source: ${escapeHtml(item.quote?.source || "unknown")} | age: ${escapeHtml(quoteAgeLabel)}
        </div>
      </article>
    `;
    })
    .join("");
}

function visibleTickersForCharts(state, analytics = {}) {
  const fromImpact = (analytics.impactItems || state.impact?.items || []).map((item) => item.ticker);
  if (fromImpact.length) {
    return new Set(fromImpact);
  }
  return new Set(Object.keys(state.market?.quotes || {}));
}

function hasActiveImpactSignals(items = []) {
  return (items || []).some((item) => Number(item?.eventScore || 0) > 0 || Number(item?.impactScore || 0) > 0);
}

function fallbackDataModesByTicker(market = { quotes: {} }) {
  return Object.fromEntries(
    Object.entries(market.quotes || {}).map(([ticker, quote]) => [
      ticker,
      {
        dataMode: normalizeMarketDataMode(quote?.dataMode || (quote?.synthetic ? "synthetic-fallback" : "live")),
        synthetic: Boolean(quote?.synthetic),
        source: quote?.source || "unknown",
        quoteOriginStage: quote?.quoteOriginStage || "unknown",
        quoteAgeMin: deriveQuoteAgeMin(quote)
      }
    ])
  );
}

function resolveCouplingSelection(couplingSeries = [], visibleTickers = new Set()) {
  const availableSeries = (couplingSeries || []).filter((series) => visibleTickers.has(series.ticker));
  const availableTickers = availableSeries.map((series) => series.ticker);
  const maxSelection = Math.min(4, availableTickers.length);

  selectedCouplingTickers = selectedCouplingTickers.filter((ticker) => availableTickers.includes(ticker));

  if (!selectedCouplingTickers.length && maxSelection > 0) {
    selectedCouplingTickers = availableTickers.slice(0, maxSelection);
    couplingSelectionTouched = false;
  } else if (!couplingSelectionTouched && selectedCouplingTickers.length < maxSelection) {
    for (const ticker of availableTickers) {
      if (selectedCouplingTickers.length >= maxSelection) {
        break;
      }
      if (!selectedCouplingTickers.includes(ticker)) {
        selectedCouplingTickers.push(ticker);
      }
    }
  } else if (selectedCouplingTickers.length > maxSelection) {
    selectedCouplingTickers = selectedCouplingTickers.slice(-maxSelection);
  }

  const selectedTickers = [...selectedCouplingTickers];
  const selectedSeries = availableSeries
    .filter((series) => selectedTickers.includes(series.ticker))
    .sort((left, right) => selectedTickers.indexOf(left.ticker) - selectedTickers.indexOf(right.ticker));

  return {
    availableSeries,
    selectedSeries,
    selectedTickers
  };
}

function renderCouplingTickerSelector(availableSeries = [], selectedTickers = []) {
  if (!elements.couplingTickerSelector) {
    return;
  }

  if ((availableSeries || []).length <= 4) {
    elements.couplingTickerSelector.classList.add("d-none");
    elements.couplingTickerSelector.innerHTML = "";
    return;
  }

  const selectedSet = new Set(selectedTickers);
  elements.couplingTickerSelector.classList.remove("d-none");
  elements.couplingTickerSelector.innerHTML = `
    <div class="chart-selector-help small text-light-emphasis">Showing up to 4 ticker histories at once.</div>
    <div class="chart-selector-chips">
      ${(availableSeries || [])
      .map((series) => {
        const activeClass = selectedSet.has(series.ticker) ? "active" : "";
        return `<button class="chart-selector-chip ${activeClass}" type="button" data-action="toggle-coupling-ticker" data-ticker="${escapeHtml(
          series.ticker
        )}">${escapeHtml(series.ticker)}</button>`;
      })
      .join("")}
    </div>
  `;
}

function applyDeterministicMatrixJitter(points = []) {
  const groups = new Map();
  points.forEach((point) => {
    const key = `${Number(point.x || 0).toFixed(2)}|${Math.round(Number(point.y || 0))}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(point);
  });

  return [...groups.values()].flatMap((group) => {
    if (group.length === 1) {
      return group;
    }

    const ordered = [...group].sort((left, right) => String(left.ticker).localeCompare(String(right.ticker)));
    return ordered.map((point, index) => {
      const centeredIndex = index - (ordered.length - 1) / 2;
      return {
        ...point,
        x: Number((point.x + centeredIndex * 0.28).toFixed(2)),
        y: Number((point.y + centeredIndex * 1.15).toFixed(2))
      };
    });
  });
}

function analyticsMatchesCurrentContext() {
  return (
    latestAnalyticsContext === selectedCountryQueryValue() &&
    latestAnalyticsWindowMin === selectedAnalyticsWindowMin &&
    (latestAnalytics?.predictedSectorDirection || latestAnalytics?.tickerOutlookMatrix || latestAnalytics?.couplingSeries)
  );
}

function resolveAnalyticsPayload(rawState) {
  if (analyticsMatchesCurrentContext()) {
    return latestAnalytics;
  }

  const predictedSectorDirection = (rawState.predictions?.sectors || []).map((sector) => ({
    sector: sector.sector,
    direction: sector.direction,
    confidence: sector.confidence,
    score: sector.score,
    inputMode: sector.inputMode
  }));

  const tickerOutlookMatrix = (rawState.predictions?.tickers || []).map((prediction) => {
    const impact = (rawState.impact?.items || []).find((item) => item.ticker === prediction.ticker) || {};
    const quote = rawState.market?.quotes?.[prediction.ticker] || {};
    const impactScore = Number(impact.impactScore || 0);
    const changePct = Number(quote.changePct || 0);
    return {
      ticker: prediction.ticker,
      sector: prediction.sector,
      direction: prediction.direction,
      eventScore: impact.eventScore || 0,
      impactScore,
      predictedConfidence: prediction.predictedConfidence || prediction.confidence || 0,
      predictionScore: prediction.predictionScore || 0,
      changePct,
      radius: Math.max(4, Math.min(20, 4 + Math.abs(changePct) * 1.5 + Math.min(8, impactScore / 5))),
      dataMode: normalizeMarketDataMode(quote.dataMode || (quote.synthetic ? "synthetic-fallback" : "live"))
    };
  });

  const couplingSeries = rawState.impact?.couplingSeries || [];
  const impactItems = rawState.impact?.items || [];
  const hasCurrentSignals = hasActiveImpactSignals(rawState.impact?.items || []);
  const usesHistoricalOnly =
    !hasCurrentSignals && couplingSeries.some((series) => (series.points || []).length >= 2);

  return {
    predictedSectorDirection,
    tickerOutlookMatrix,
    impactItems,
    couplingSeries,
    hasCurrentSignals,
    usesHistoricalOnly,
    dataModesByTicker: fallbackDataModesByTicker(rawState.market || { quotes: {} }),
    signalWindow: {
      requestedWindowMin: selectedAnalyticsWindowMin,
      latestSelectedArticleAgeMin: Number.isFinite(rawState.meta?.sourceMeta?.latestSelectedArticleAgeMin)
        ? rawState.meta.sourceMeta.latestSelectedArticleAgeMin
        : null,
      hasCurrentSignals,
      usesHistoricalOnly
    },
    emptyReason: hasCurrentSignals
      ? null
      : usesHistoricalOnly
        ? "Current window has no linked news-to-ticker signals; showing historical coupling only."
        : "No linked news-to-ticker signals in the current event window."
  };
}

function buildAnalyticsStatusMessage(analytics = {}) {
  if (latestAnalyticsError) {
    return latestAnalyticsError;
  }

  const signalWindow = analytics.signalWindow || {};
  if (analytics.hasCurrentSignals) {
    return "";
  }

  const latestAge = Number.isFinite(signalWindow.latestSelectedArticleAgeMin)
    ? `${signalWindow.latestSelectedArticleAgeMin}m`
    : "--";
  const windowLabel = formatWindowLabel(signalWindow.requestedWindowMin || selectedAnalyticsWindowMin);
  return analytics.usesHistoricalOnly
    ? `Window ${windowLabel} has no linked current signals. Latest selected article age: ${latestAge}. Showing historical coupling only.`
    : `Window ${windowLabel} has no linked current signals. Latest selected article age: ${latestAge}.`;
}

function resolveRenderedImpact(rawState, filteredState, analytics = {}) {
  if (analyticsMatchesCurrentContext() && Array.isArray(analytics.impactItems)) {
    return {
      ...(rawState.impact || {}),
      items: analytics.impactItems,
      emptyReason: analytics.emptyReason || resolveImpactEmptyReason(rawState, filteredState),
      signalWindow: analytics.signalWindow,
      showAllAction: !selectedIncludesAll()
    };
  }

  return {
    ...(filteredState.impact || { items: [] }),
    emptyReason: resolveImpactEmptyReason(rawState, filteredState),
    showAllAction: !selectedIncludesAll()
  };
}

function renderPredictedSectorDirection(items = [], overlayMessage = "") {
  impactTimelineChart.data.labels = items.map(
    (item) => `${String(item.sector || "unknown").toUpperCase()} (${Number(item.confidence || 0)}%)`
  );
  impactTimelineChart.data.datasets[0].data = items.map((item) => Number(item.score || 0));
  impactTimelineChart.data.datasets[0].backgroundColor = items.map(
    (item) => DIRECTION_COLORS[item.direction] || "#6fb1ff"
  );
  impactTimelineChart.data.datasets[0].confidenceMap = items.map((item) => Number(item.confidence || 0));
  impactTimelineChart.update();
  setChartOverlay(
    elements.impactTimelineChart,
    latestAnalyticsError || (!items.length ? overlayMessage || "No prediction bands available." : "")
  );
}

function renderTickerOutlookMatrix(items = [], visibleTickers = new Set(), analytics = {}) {
  const points = applyDeterministicMatrixJitter(
    items
      .filter((item) => visibleTickers.has(item.ticker))
      .map((item) => ({
        x: Number(item.eventScore || 0),
        y: Number(item.predictedConfidence || 0),
        r: Number(item.radius || 6),
        ticker: item.ticker,
        direction: item.direction,
        predictionScore: Number(item.predictionScore || 0),
        changePct: Number(item.changePct || 0),
        dataMode: normalizeMarketDataMode(item.dataMode || analytics.dataModesByTicker?.[item.ticker]?.dataMode || "synthetic-fallback")
      }))
  );

  sectorBreakdownChart.data.datasets[0].data = points;
  sectorBreakdownChart.data.datasets[0].pointBackgroundColor = points.map(
    (point) => DIRECTION_COLORS[point.direction] || "#6fb1ff"
  );
  sectorBreakdownChart.data.datasets[0].pointBorderColor = points.map(
    (point) => MODE_BORDER_COLORS[point.dataMode] || MODE_BORDER_COLORS["synthetic-fallback"]
  );
  sectorBreakdownChart.data.datasets[0].pointBorderWidth = points.map((point) => (point.dataMode === "live" ? 1.2 : 2.6));
  sectorBreakdownChart.data.datasets[0].pointStyle = points.map(
    (point) => MODE_POINT_STYLE[point.dataMode] || MODE_POINT_STYLE["synthetic-fallback"]
  );
  sectorBreakdownChart.options.scales.x.suggestedMax = Math.max(
    2,
    Math.ceil(Math.max(0, ...points.map((point) => Number(point.x || 0))) + 1)
  );
  sectorBreakdownChart.update();
  setChartOverlay(
    elements.sectorBreakdownChart,
    latestAnalyticsError || (!points.length ? analytics.emptyReason || "No ticker outlook points available for the current filters." : "")
  );
}

function renderNewsPriceCoupling(selectedSeries = [], analytics = {}) {
  const selectedWithPoints = (selectedSeries || []).filter((series) => (series.points || []).length >= 2);
  if (!selectedWithPoints.length) {
    impactScatterChart.data.labels = [];
    impactScatterChart.data.datasets = [];
    impactScatterChart.update();
    setChartOverlay(
      elements.impactScatterChart,
      latestAnalyticsError || analytics.emptyReason || "No coupling history available for the current filters."
    );
    return;
  }

  const labels = [...new Set(selectedWithPoints.flatMap((series) => (series.points || []).map((point) => point.timestamp)))]
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
    .map((timestamp) => formatShortTime(timestamp));

  const datasets = [];
  selectedWithPoints.forEach((series, index) => {
    const rawPoints = series.points || [];
    const map = new Map(rawPoints.map((point) => [formatShortTime(point.timestamp), point]));
    const color = CHART_COLORS[index % CHART_COLORS.length];
    const dataMode = normalizeMarketDataMode(analytics.dataModesByTicker?.[series.ticker]?.dataMode || "synthetic-fallback");
    const borderColor = dataMode === "live" ? color : MODE_BORDER_COLORS[dataMode] || color;

    datasets.push({
      label: `${series.ticker} impact [${String(dataMode).toUpperCase()}]`,
      data: labels.map((label) => Number(map.get(label)?.impactScore ?? null)),
      borderColor,
      backgroundColor: borderColor,
      borderWidth: 2.4,
      pointRadius: 2.5,
      tension: 0.25,
      yAxisID: "yImpact"
    });
    datasets.push({
      label: `${series.ticker} priceReaction`,
      data: labels.map((label) => Number(map.get(label)?.priceReaction ?? null)),
      borderColor: color,
      backgroundColor: color,
      borderDash: [5, 5],
      borderWidth: 1.9,
      pointRadius: 2,
      tension: 0.25,
      yAxisID: "yPrice"
    });

    if (Number.isFinite(series.predictionScore) && index === 0) {
      datasets.push({
        label: `${series.ticker} predictionScore`,
        data: labels.map(() => Number(series.predictionScore || 0)),
        borderColor: "#f4c542",
        backgroundColor: "#f4c542",
        borderDash: [2, 3],
        pointRadius: 0,
        tension: 0,
        yAxisID: "yImpact"
      });
    }
  });

  impactScatterChart.data.labels = labels;
  impactScatterChart.data.datasets = datasets;
  impactScatterChart.update();
  setChartOverlay(elements.impactScatterChart, latestAnalyticsError || "");
}

function renderCharts(rawState, filteredState, analytics = resolveAnalyticsPayload(rawState)) {
  const visibleTickers = visibleTickersForCharts(filteredState, analytics);
  const couplingSelection = resolveCouplingSelection(analytics.couplingSeries || [], visibleTickers);
  const predictionOverlay =
    latestAnalyticsError && !(analytics.predictedSectorDirection || []).length
      ? "Live analytics refresh failed. Showing snapshot-only view."
      : latestAnalyticsError;
  renderAnalyticsStatus(buildAnalyticsStatusMessage(analytics));
  renderCouplingTickerSelector(couplingSelection.availableSeries, couplingSelection.selectedTickers);
  renderPredictedSectorDirection(analytics.predictedSectorDirection || [], predictionOverlay);
  renderTickerOutlookMatrix(analytics.tickerOutlookMatrix || [], visibleTickers, analytics);
  renderNewsPriceCoupling(couplingSelection.selectedSeries, analytics);
}

function renderDashboard(rawState) {
  const state = filterStateBySelection(rawState);
  const analytics = resolveAnalyticsPayload(rawState);
  renderMeta(rawState.meta, rawState.market || {});
  renderNews(state.news, state.countries);
  renderDistribution(state.countries);
  renderRiskChart(state.countries);
  renderPredictions(rawState.predictions || {});
  renderInsights(state.insights, resolveInsightsEmptyReason(rawState, state));
  renderMarketQuotes(rawState.market || {});
  renderImpact(resolveRenderedImpact(rawState, state, analytics));
  renderCharts(rawState, state, analytics);
  hotspotMap.render(state.hotspots, state.news, currentWatchlist, state.mapAssets || { staticPoints: [], movingSeeds: [] });
}

function setWsStatus(status) {
  elements.wsStatusBadge.className = `badge ${wsBadgeClass(status)}`;
  elements.wsStatusBadge.textContent = `WS: ${status}`;
}

function selectedCountryQueryValue() {
  if (selectedIncludesAll()) {
    return "ALL";
  }
  return activeCountryList().join(",");
}

async function refreshAnalytics() {
  const requestToken = ++analyticsRequestToken;
  const countryKey = selectedCountryQueryValue();
  try {
    const payload = await api.getMarketAnalytics({
      countries: countryKey,
      windowMin: selectedAnalyticsWindowMin
    });
    if (requestToken !== analyticsRequestToken) {
      return;
    }
    latestAnalytics = payload;
    latestAnalyticsContext = countryKey;
    latestAnalyticsWindowMin = selectedAnalyticsWindowMin;
    latestAnalyticsError = "";
    renderDashboard(getState());
  } catch (error) {
    if (requestToken !== analyticsRequestToken) {
      return;
    }
    latestAnalytics = null;
    latestAnalyticsContext = "";
    latestAnalyticsWindowMin = selectedAnalyticsWindowMin;
    latestAnalyticsError = "Live analytics refresh failed. Displaying snapshot-derived charts.";
    console.error("Failed to refresh analytics:", error);
    renderDashboard(getState());
  }
}

function scheduleAnalyticsRefresh() {
  clearTimeout(analyticsRefreshTimer);
  analyticsRefreshTimer = setTimeout(() => {
    refreshAnalytics();
  }, 500);
}

async function requestFilteredSnapshot() {
  try {
    latestAnalytics = null;
    latestAnalyticsContext = "";
    latestAnalyticsWindowMin = selectedAnalyticsWindowMin;
    latestAnalyticsError = "";
    selectedCouplingTickers = [];
    couplingSelectionTouched = false;
    const snapshot = await api.getSnapshot({
      countries: selectedCountryQueryValue(),
      limit: 100
    });
    setSnapshot(snapshot);
    await refreshAnalytics();
  } catch (error) {
    console.error("Failed to refresh filtered snapshot:", error);
  }
}

async function handleManualRefreshClick() {
  if (manualRefreshState === "loading" || resolveManualCooldownMs() > 0) {
    return;
  }

  setManualRefreshState("loading", "Refresh: requesting...");

  try {
    const data = await api.refreshIntel({
      countries: selectedCountryQueryValue(),
      reason: "manual"
    });
    manualRefreshPendingId = data.refreshId || null;
    startManualRefreshCooldown(data.retryAfterMs || 0);
    setManualRefreshState("loading", "Refresh: in progress...");
  } catch (error) {
    const retryAfterMs = resolveRetryAfterMs(error);
    if (retryAfterMs > 0) {
      startManualRefreshCooldown(retryAfterMs);
    }

    if (error.status === 409) {
      setManualRefreshState("error", "Refresh: already in progress.");
      return;
    }
    if (error.status === 429) {
      setManualRefreshState("error", "Refresh: cooldown active.");
      return;
    }
    setManualRefreshState("error", "Refresh: request failed.");
  }
}

function mountWebSocket() {
  socket = new RealtimeSocket({
    path: "/ws",
    onStatusChange: setWsStatus,
    onMessage: (message) => {
      if (message.type === "snapshot") {
        setSnapshot(message.data);
        scheduleAnalyticsRefresh();
        return;
      }
      if (message.type === "update") {
        applyUpdate(message.data);
        scheduleAnalyticsRefresh();
        return;
      }
      if (message.type === "error") {
        console.error("Realtime update error:", message.data);
      }
    }
  });
  socket.connect();
}

function syncWatchlistFromState(state) {
  const watchlist = state.meta?.watchlistCountries || DEFAULT_WATCHLIST;
  currentWatchlist = watchlist.length ? [...watchlist] : [...DEFAULT_WATCHLIST];
  if (!selectedCountries.size) {
    selectedCountries = new Set(currentWatchlist);
  }
}

function toggleApiLimitsPanel() {
  elements.apiLimitsPanel.classList.toggle("d-none");
}

function renderPipelineStatus(payload = {}) {
  const market = payload.market || {};
  const news = payload.news || {};

  if (!elements.pipelineStatusBody) {
    return;
  }

  const rows = [
    {
      pipeline: "market",
      band: market.quotaBand || "--",
      nextRun: market.nextRecommendedRunAt ? `${formatShortTime(market.nextRecommendedRunAt)} (${formatDurationMs(market.nextDelayMs)})` : "--",
      mode: market.requestMode || "--",
      skipped: (market.providersSkipped || []).map((item) => item.provider).join(", ") || "--",
      batchOrPage: market.batchSize || "--",
      lastError:
        market.lastUpstreamError ||
        ((market.usedStaleQuotes || []).length ? `stale:${(market.usedStaleQuotes || []).length}` : "--")
    },
    {
      pipeline: "news",
      band: news.quotaBand || "--",
      nextRun: news.nextRecommendedRunAt ? `${formatShortTime(news.nextRecommendedRunAt)} (${formatDurationMs(news.nextDelayMs)})` : "--",
      mode: news.provider || "--",
      skipped: (news.providersSkipped || []).map((item) => item.provider).join(", ") || "--",
      batchOrPage: news.pageSize || "--",
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
          <td>${escapeHtml(String(row.mode))}</td>
          <td>${escapeHtml(row.skipped)}</td>
          <td>${escapeHtml(String(row.batchOrPage))}</td>
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
      const hasRawCount = Object.prototype.hasOwnProperty.call(rawCounts, provider);
      const hasSelectedCount = Object.prototype.hasOwnProperty.call(selectedCounts, provider);
      const hasQueryLength = Object.prototype.hasOwnProperty.call(queryLengths, provider);
      const status = ["ok", "empty", "error", "skipped"].includes(String(attempt.status || "").toLowerCase())
        ? String(attempt.status).toLowerCase()
        : Number(news.selectedCountByProvider?.[provider] || 0) > 0
          ? "ok"
          : "empty";

      return {
        provider,
        status,
        rawCount: Number(hasRawCount ? rawCounts[provider] : attempt.rawCount || 0),
        selectedCount: Number(hasSelectedCount ? selectedCounts[provider] : attempt.count || 0),
        queryLength: Number(hasQueryLength ? queryLengths[provider] : 0),
        reason: attempt.reason || "",
        nextAllowedAt: attempt.nextAllowedAt || ""
      };
    });
}

function buildSourceSelectionDiagnostics(news = {}) {
  return (news.selectionBySourceName || [])
    .slice(0, 8)
    .map((item) => ({
      provider: item.provider || "unknown",
      sourceName: item.sourceName || "Unknown Source",
      raw: Number(item.raw || 0),
      filtered: Number(item.filtered || 0),
      selected: Number(item.selected || 0)
    }));
}

function renderPipelineDiagnostics(news = {}) {
  if (elements.pipelineDiagnosticsBody) {
    const diagnostics = buildNewsProviderDiagnostics(news);
    const sourceDiagnostics = buildSourceSelectionDiagnostics(news);

    if (!diagnostics.length) {
      elements.pipelineDiagnosticsBody.innerHTML =
        '<div class="diagnostic-item diagnostic-item-meta">No provider diagnostics available.</div>';
    } else {
      const providerMarkup = diagnostics
        .map((item) => {
          const reasonLine = item.reason
            ? `<div class="diagnostic-item-meta">reason: ${escapeHtml(item.reason)}${item.nextAllowedAt ? ` | next: ${escapeHtml(formatShortTime(item.nextAllowedAt))}` : ""
            }</div>`
            : item.nextAllowedAt
              ? `<div class="diagnostic-item-meta">next: ${escapeHtml(formatShortTime(item.nextAllowedAt))}</div>`
              : "";
          return `
            <article class="diagnostic-item">
              <div class="diagnostic-item-header">
                <strong>${escapeHtml(item.provider)}</strong>
                <span class="diagnostic-pill ${item.status}">${escapeHtml(item.status)}</span>
              </div>
              <div class="diagnostic-item-meta">
                raw: ${item.rawCount} | selected: ${item.selectedCount} | query length: ${item.queryLength}
              </div>
              ${reasonLine}
            </article>
          `;
        })
        .join("");
      const sourceMarkup = sourceDiagnostics.length
        ? `
          <div class="diagnostic-section-label">Selection by source</div>
          ${sourceDiagnostics
          .map(
            (item) => `
                <article class="diagnostic-item">
                  <div class="diagnostic-item-header">
                    <strong>${escapeHtml(item.sourceName)}</strong>
                    <span class="diagnostic-pill ok">${escapeHtml(item.provider)}</span>
                  </div>
                  <div class="diagnostic-item-meta">raw: ${item.raw} | filtered: ${item.filtered} | selected: ${item.selected}</div>
                </article>
              `
          )
          .join("")}
        `
        : "";
      elements.pipelineDiagnosticsBody.innerHTML = providerMarkup + sourceMarkup;
    }
  }

  if (!elements.rssFeedStatusBody) {
    return;
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
          <div class="diagnostic-item-meta">
            count: ${Number(feed.count || 0)} | ${escapeHtml(feed.error || feed.url || "--")}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderRecentCycleErrors(items = []) {
  if (!elements.recentCycleErrorsBody) {
    return;
  }

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

function renderApiLimits(payload = { providers: [] }) {
  const providers = payload.providers || [];
  elements.apiLimitsUpdated.textContent = `Updated: ${formatDate(payload.generatedAt)}`;

  if (!providers.length) {
    elements.apiLimitsBody.innerHTML =
      '<tr><td colspan="8" class="text-light-emphasis">No API limits data available.</td></tr>';
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
          <td class="${statusClass}">${provider.lastStatus || "idle"}</td>
        </tr>
      `;
    })
    .join("");
}

async function refreshApiLimits() {
  try {
    const [limits, pipeline] = await Promise.all([api.getApiLimits(), api.getPipelineStatus()]);
    renderApiLimits(limits);
    renderPipelineStatus(pipeline);
  } catch (error) {
    console.error("Failed to load API limits:", error);
  }
}

function startPolling() {
  clearInterval(apiLimitsPoller);

  apiLimitsPoller = setInterval(() => {
    if (!elements.apiLimitsPanel.classList.contains("d-none")) {
      refreshApiLimits();
    }
  }, 120_000);
}

async function bootstrap() {
  cacheElements();
  initNewsDrawer();
  renderAnalyticsWindowSelector();
  hotspotMap = new HotspotMap("hotspot-map");
  hotspotMap.init();
  teardownHandlers.push(mountSituationalWorkspace({ api }));
  teardownHandlers.push(startWorldBrief({ api }));
  teardownHandlers.push(startThreatClassifier({ api }));
  teardownHandlers.push(startRiskEngine({ api }));
  teardownHandlers.push(startTrendDetector({ api }));
  teardownHandlers.push(startEscalationHotspots({ api }));
  teardownHandlers.push(startSignalAnomalies({ api }));
  initRiskChart();
  initImpactTimelineChart();
  initSectorBreakdownChart();
  initImpactScatterChart();

  elements.countryFilterBar.addEventListener("click", handleFilterClick);
  document.body.addEventListener("click", handleActionClick);
  elements.refreshNewsBtn.addEventListener("click", handleManualRefreshClick);

  subscribe((state) => {
    syncWatchlistFromState(state);
    renderCountryFilters();
    renderDashboard(state);
    syncManualRefreshFromMeta(state.meta);
  });

  setWsStatus("connecting");

  try {
    const snapshot = await api.getSnapshot({ countries: selectedCountryQueryValue(), limit: 100 });
    setSnapshot(snapshot);
    await refreshAnalytics();
  } catch (error) {
    console.error("Failed to fetch initial snapshot:", error);
    elements.newsFeed.innerHTML =
      '<div class="p-3 small text-danger">Failed to load initial intelligence snapshot.</div>';
  }

  mountWebSocket();

  window.addEventListener("beforeunload", () => {
    socket?.close();
    clearInterval(apiLimitsPoller);
    clearTimeout(analyticsRefreshTimer);
    clearInterval(manualRefreshCooldownTimer);
    teardownHandlers.forEach((teardown) => teardown?.());
  });
}

document.addEventListener("DOMContentLoaded", bootstrap);
