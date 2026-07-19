import { api } from "./api.js";
import { applyUpdate, getState, setSnapshot, subscribe } from "./state.js";
import { RealtimeSocket } from "./websocket.js";
import { SmartPollLoop } from "./smartPollLoop.js";
import { resolveMarketQuotesPollDelayMs } from "./marketPolling.js";
import { HotspotMap, getLevelColor } from "./map.js";
import { mountSituationalWorkspace } from "./media/situationalWorkspace.js";
import { startWorldBrief } from "./intelligence/worldBrief.js";
import { startThreatClassifier } from "./intelligence/threatClassifier.js";
import { startRiskEngine } from "./intelligence/riskEngine.js";
import { startTrendDetector } from "./intelligence/trendDetector.js";
import { startEscalationHotspots } from "./intelligence/escalationHotspots.js";
import { startSignalAnomalies } from "./intelligence/signalAnomalies.js";
import {
  addMarketInstrument,
  marketSelectionIds,
  marketSelectionSymbols,
  removeMarketInstrument,
  resolveSelectedMarketInstruments,
  validateMarketSelection
} from "./marketWatchlistModel.js";
import { buildOhlcvChartSeries } from "./marketOhlcvModel.js";

const LEVEL_RANK = {
  Stable: 1,
  Monitoring: 2,
  Elevated: 3,
  Critical: 4
};

const ANALYTICS_WINDOW_OPTIONS = [
  { label: "2h", minutes: 120 },
  { label: "6h", minutes: 360 },
  { label: "12h", minutes: 720 },
  { label: "24h", minutes: 1440 }
];
const CHART_COLORS = ["#f3f4f4", "#d9dddf", "#bdc2c5", "#a2a8ac", "#878e93", "#6d747a", "#555c62"];
const NEWS_PLACEHOLDER_SRC = "/assets/news-placeholder.svg";
const DIRECTION_COLORS = {
  Bullish: "#38c172",
  Bearish: "#ff4d4f",
  Volatile: "#ff8c42",
  Sideways: "#a2a8ac"
};
const MODE_BORDER_COLORS = {
  live: "#f3f4f4",
  "web-delayed": "#bdc2c5",
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
let selectedCountries = new Set();
let currentWatchlist = [];
let selectedMarketSymbols = [];
let marketWatchlistLoaded = false;
let marketWatchlistModel = { maxSelected: null, instruments: [] };
let marketWatchlistDraft = [];
let marketSearchTimer = null;
let marketSearchToken = 0;
let marketSearchRequestKey = null;
let marketOhlcvChart = null;
let marketOhlcvRequestToken = 0;
let watchlistInitialized = false;
let marketProviderPoller = null;
let analyticsRefreshTimer = null;
let latestAnalytics = null;
let latestAnalyticsContext = "";
let latestAnalyticsError = "";
let latestAnalyticsWindowMin = 120;
let analyticsRequestToken = 0;
let selectedCouplingTickers = [];
let couplingSelectionTouched = false;
let selectedAnalyticsWindowMin = 120;
let marketQuotesPoller = null;
let marketQuotesPollerStarted = false;
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
  elements.marketProviderStatusText = byId("market-provider-status-text");
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
  elements.marketWatchlistSearchForm = byId("market-watchlist-search-form");
  elements.marketWatchlistSearch = byId("market-watchlist-search");
  elements.marketWatchlistSearchStatus = byId("market-watchlist-search-status");
  elements.marketWatchlistSearchResults = byId("market-watchlist-search-results");
  elements.marketWatchlistSelected = byId("market-watchlist-selected");
  elements.marketWatchlistSave = byId("market-watchlist-save");
  elements.marketWatchlistStatus = byId("market-watchlist-status");
  elements.marketOhlcvInstrument = byId("market-ohlcv-instrument");
  elements.marketOhlcvInterval = byId("market-ohlcv-interval");
  elements.marketOhlcvStatus = byId("market-ohlcv-status");
  elements.marketOhlcvCanvas = byId("market-ohlcv-chart");
  elements.marketImpactList = byId("market-impact-list");
  elements.aiMarketShell = byId("ai-market-shell");
  elements.aiMarketList = byId("ai-market-list");
  elements.aiCountryShell = byId("ai-country-shell");
  elements.aiCountryList = byId("ai-country-list");
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
  elements.analyticsStatus = byId("analytics-status");
  elements.analyticsWindowSelector = byId("analytics-window-selector");
  elements.couplingTickerSelector = byId("coupling-ticker-selector");
  elements.refreshNewsBtn = byId("refresh-news-btn");
  elements.refreshNewsStatus = byId("refresh-news-status");
  elements.newsDrawer = byId("news-detail-drawer");
  elements.newsDrawerTitle = byId("news-detail-title");
  elements.newsDrawerMeta = byId("news-drawer-meta");
  elements.newsDrawerImage = byId("news-drawer-image");
  elements.newsDrawerBody = byId("news-drawer-body");
  elements.newsDrawerAi = byId("news-drawer-ai");
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

function articleAiEntry(articleId, ai = getState().ai || {}) {
  return ai?.articleSummaries?.[String(articleId || "")] || null;
}

function aiStatusLabel(entry = {}) {
  if (entry.status === "ready") return "AI READY";
  if (entry.status === "stale") return "AI STALE";
  if (["pending", "running"].includes(entry.status)) return "AI PENDING";
  return "AI UNAVAILABLE";
}

function renderAiEvidence(entry = {}) {
  const evidence = (entry.provenance?.evidence || []).slice(0, 8);
  if (!evidence.length) return "";
  const sources = evidence.map((item) => {
    const label = item.publisher || item.sourceName || item.articleId || "source";
    if (item.canonicalUrl) {
      return `<a href="${escapeHtml(item.canonicalUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    }
    return `<span>${escapeHtml(label)}</span>`;
  }).join(" · ");
  return `<div class="ai-evidence-list"><strong>Evidence:</strong> ${sources}</div>`;
}

function renderArticleAiDetail(entry = null) {
  if (!elements.newsDrawerAi) return;
  elements.newsDrawerAi.classList.add("d-none");
  elements.newsDrawerAi.innerHTML = "";
  if (!entry) return;
  elements.newsDrawerAi.classList.remove("d-none");
  const output = entry.output;
  if (!output) {
    elements.newsDrawerAi.innerHTML = `<div class="ai-enrichment-label">AI analysis</div><p>${escapeHtml(aiStatusLabel(entry))}. Deterministic article data remains available above.</p>`;
    return;
  }
  const developments = (output.keyDevelopments || []).map((item) => `<li>${escapeHtml(item.text)}</li>`).join("");
  elements.newsDrawerAi.innerHTML = `
    <div class="ai-enrichment-label">AI analysis · ${escapeHtml(entry.status)}</div>
    <p>${escapeHtml(output.summary || "")}</p>
    ${developments ? `<ul>${developments}</ul>` : ""}
    ${renderAiEvidence(entry)}
    <div class="small text-light-emphasis">Model: ${escapeHtml(entry.model || "--")} · Generated: ${escapeHtml(formatDate(entry.generatedAt))} · Uncertainty: ${escapeHtml(output.uncertainty?.level || "unknown")}</div>
  `;
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
  renderArticleAiDetail(articleAiEntry(article.id));

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

function normalizeMarketDataMode(mode = "synthetic") {
  const normalized = String(mode || "").toLowerCase();
  if (normalized === "fallback") {
    return "synthetic";
  }
  if (normalized === "stale") {
    return "stale";
  }
  if (["live", "web-delayed"].includes(normalized)) return "observed";
  if (normalized === "synthetic-fallback") return "synthetic";
  if (normalized === "router-stale" || normalized === "historical-eod") return "stale";
  return normalized || "synthetic";
}

function marketModeLabel(mode = "synthetic") {
  const normalized = normalizeMarketDataMode(mode);
  if (normalized === "observed") {
    return "OBSERVED";
  }
  if (normalized === "web-delayed") {
    return "WEB DELAYED";
  }
  if (normalized === "historical-eod") {
    return "EOD";
  }
  if (normalized === "stale") {
    return "STALE";
  }
  return "SIM";
}

function marketModeShortLabel(mode = "synthetic") {
  const normalized = normalizeMarketDataMode(mode);
  if (normalized === "web-delayed") {
    return "W";
  }
  if (normalized === "historical-eod") {
    return "E";
  }
  if (normalized === "stale") {
    return "C";
  }
  if (normalized === "synthetic") {
    return "S";
  }
  return "";
}

function marketModeClass(mode = "synthetic") {
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
  const sessionLabel = market.session?.open ? "open" : market.session?.state || "closed";
  const dataLabel = market.sourceMode || "fallback";
  const offHoursPaused = !market.session?.open
    && market.sourceMeta?.upstreamPaused === true
    && market.sourceMeta?.pauseReason === "offhours-skip";
  elements.marketModeBadge.textContent = offHoursPaused
    ? `Market: session ${sessionLabel} | provider paused by policy`
    : `Market: session ${sessionLabel} | data ${dataLabel}`;
  elements.marketModeBadge.title = [
    `session: ${market.session?.state || "--"}`,
    `data: ${dataLabel}`,
    `upstreamPaused: ${market.sourceMeta?.upstreamPaused === true ? "yes" : "no"}`,
    `providerScore: ${Number.isFinite(Number(market.sourceMeta?.providerScore)) ? Number(market.sourceMeta.providerScore) : "--"}`,
    `latency: ${Number.isFinite(Number(market.sourceMeta?.providerLatencyMs)) ? `${Number(market.sourceMeta.providerLatencyMs)}ms` : "--"}`,
    `revision: ${market.revision || "--"}`
  ].join(" | ");

  elements.lastUpdateText.textContent = `Last update: ${formatDate(meta.lastRefreshAt)}`;
  elements.marketUpdatedText.textContent =
    market.sourceMode === "disabled"
      ? "Quotes: market disabled"
      : `Quotes: ${formatDate(market.updatedAt)}${market.revision ? ` | rev ${String(market.revision).slice(0, 8)}` : ""}`;
  if (elements.marketCoverageText) {
    const coverage = market.coverageByMode || market.sourceMeta?.coverageByMode || {};
    const pausedSuffix =
      market.sourceMeta?.upstreamPaused === true
        ? ` | upstream paused${market.sourceMeta?.pauseReason ? ` (${String(market.sourceMeta.pauseReason)})` : ""}`
        : "";
    elements.marketCoverageText.textContent =
      market.sourceMode === "disabled"
        ? "Coverage: market disabled"
        : `Coverage: ${coverage.live || 0} live / ${coverage.webDelayed || 0} web delayed / ${coverage.historicalEod || 0} EOD / ${coverage.routerStale || 0} stale cache / ${coverage.syntheticFallback || 0} sim${pausedSuffix}`;
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
  if (!currentWatchlist.length) {
    elements.countryFilterBar.innerHTML =
      '<span class="small text-light-emphasis">Countries loading...</span>';
    return;
  }

  const selectedList = activeCountryList().filter((iso2) => currentWatchlist.includes(iso2));
  const allSelected = selectedIncludesAll();
  const summaryLabel = allSelected ? "Countries: ALL" : `Countries: ${selectedList.length}/${currentWatchlist.length}`;
  const selectedChipHtml = allSelected
    ? '<button class="filter-chip active" data-country="ALL" type="button">ALL</button>'
    : selectedList
        .map(
          (iso2) =>
            `<button class="filter-chip active" data-country="${escapeHtml(iso2)}" type="button">${escapeHtml(iso2)}</button>`
        )
        .join("");

  elements.countryFilterBar.innerHTML = `
    <details class="country-picker">
      <summary class="country-picker-summary">${escapeHtml(summaryLabel)}</summary>
      <div class="country-picker-menu">
        <label class="country-picker-option">
          <input type="checkbox" data-country-toggle="ALL" ${allSelected ? "checked" : ""} />
          <span>ALL countries</span>
        </label>
        ${currentWatchlist
          .map((iso2) => {
            const checked = !allSelected && selectedCountries.has(iso2) ? "checked" : "";
            return `
              <label class="country-picker-option">
                <input type="checkbox" data-country-toggle="${escapeHtml(iso2)}" ${checked} />
                <span>${escapeHtml(iso2)}</span>
              </label>
            `;
          })
          .join("")}
      </div>
    </details>
    <div class="country-selected-chips">
      ${selectedChipHtml || '<span class="small text-light-emphasis">No countries selected</span>'}
    </div>
  `;
}

function marketOperationLabel(queue = {}, operation) {
  const metrics = queue.operations?.[operation] || {};
  const cooldownMs = Number(queue.cooldowns?.[operation] || 0);
  if (cooldownMs > 0) {
    const code = metrics.lastError?.status || metrics.lastError?.code || 429;
    return `${operation} limited ${Math.max(1, Math.ceil(cooldownMs / 1_000))}s (${code})`;
  }
  const failedAt = metrics.lastFailureAt ? Date.parse(metrics.lastFailureAt) : NaN;
  const successAt = metrics.lastSuccessAt ? Date.parse(metrics.lastSuccessAt) : NaN;
  if (metrics.lastError && (!Number.isFinite(successAt) || failedAt > successAt)) {
    return `${operation} error ${metrics.lastError.status || metrics.lastError.code || "unknown"}`;
  }
  if (metrics.lastSuccessAt) return `${operation} ready`;
  return `${operation} idle`;
}

function renderMarketProviderStatus(payload = {}) {
  if (!elements.marketProviderStatusText) return;
  const diagnostics = payload.diagnostics || {};
  const queue = diagnostics.client?.queue || {};
  const search = diagnostics.search?.last || null;
  const searchSuffix = search
    ? ` | last lookup ${search.source || "--"}${search.degraded ? " (degraded)" : ""}: ${Number(search.resultCount || 0)} result(s)`
    : "";
  const policySuffix = payload.upstreamPaused
    ? ` | scheduled quotes paused${payload.pauseReason ? ` (${payload.pauseReason})` : ""}`
    : "";
  elements.marketProviderStatusText.textContent = [
    `Yahoo transport: ${diagnostics.transport || "server-library"}`,
    marketOperationLabel(queue, "search"),
    marketOperationLabel(queue, "quote"),
    marketOperationLabel(queue, "chart")
  ].join(" | ") + searchSuffix + policySuffix;
}

async function refreshMarketProviderStatus() {
  try {
    renderMarketProviderStatus(await api.getMarketProviderStatus());
  } catch (error) {
    if (elements.marketProviderStatusText) {
      elements.marketProviderStatusText.textContent = `Yahoo transport diagnostics unavailable: ${error.message}`;
    }
  }
}

function startMarketProviderPolling() {
  clearInterval(marketProviderPoller);
  refreshMarketProviderStatus();
  marketProviderPoller = setInterval(refreshMarketProviderStatus, 15_000);
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

function handleCountryPickerChange(event) {
  const input = event.target.closest("[data-country-toggle]");
  if (!input) {
    return;
  }

  const country = input.dataset.countryToggle;
  if (country === "ALL") {
    selectedCountries = new Set(["ALL"]);
    renderCountryFilters();
    requestFilteredSnapshot();
    return;
  }

  if (selectedCountries.has("ALL")) {
    selectedCountries = new Set();
  }

  if (input.checked) {
    selectedCountries.add(country);
  } else {
    selectedCountries.delete(country);
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

function renderNews(news = [], countries = {}, ai = {}) {
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
      const aiEntry = articleAiEntry(article.id, ai);
      const aiFlag = aiEntry
        ? `<span class="news-ai-badge ai-status-${escapeHtml(aiEntry.status || "unknown")}">${escapeHtml(aiStatusLabel(aiEntry))}</span>`
        : "";

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
              ${aiFlag}
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
              return `score: ${context.raw} | signal strength: ${confidence}%`;
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

function renderPredictions(predictions = { tickers: [], sectors: [] }, market = { quotes: {} }) {
  const tickerPredictions = [...(predictions.tickers || [])].sort(
    (left, right) => Number(right.predictionScore || 0) - Number(left.predictionScore || 0)
  );

  if (tickerPredictions.length) {
    elements.predictionsList.innerHTML = tickerPredictions
      .map((prediction) => {
        const quote = market.quotes?.[prediction.ticker] || {};
        const direction = prediction.direction || "Sideways";
        const marketDataMode = normalizeMarketDataMode(
          prediction.marketDataMode || quote.dataMode || (quote.synthetic ? "synthetic-fallback" : "live")
        );
        const quoteFreshnessMin = deriveQuoteAgeMin(quote);
        const quoteFreshness = Number.isFinite(quoteFreshnessMin) ? `${quoteFreshnessMin}m` : "--";
        const changePct = Number(quote.changePct || 0);
        const changeLabel = Number.isFinite(changePct) ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : "--";

        return `
          <article class="prediction-item prediction-item-ticker">
            <div class="title-row">
              <div class="prediction-title-stack">
                <strong>${escapeHtml(prediction.ticker || "N/A")}</strong>
                <div class="prediction-kicker">${escapeHtml((prediction.sector || "unknown").toUpperCase())}</div>
              </div>
              <div class="prediction-badges">
                <span class="badge ${qualityBadgeClass(prediction.inputMode || "fallback")}">${escapeHtml(direction)}</span>
                <span class="market-mode-pill ${marketModeClass(marketDataMode)}">${escapeHtml(marketModeLabel(marketDataMode))}</span>
              </div>
            </div>
            <div class="prediction-grid">
              <div class="prediction-meta">Signal strength: ${escapeHtml(String(prediction.signalStrength ?? prediction.confidence ?? "--"))}%</div>
              <div class="prediction-meta">Score: ${escapeHtml(String(prediction.predictionScore ?? "--"))}</div>
              <div class="prediction-meta">Horizon: ${escapeHtml(String(prediction.horizonHours ?? "--"))}h</div>
              <div class="prediction-meta">Quote freshness: ${escapeHtml(quoteFreshness)}</div>
              <div class="prediction-meta">Source: ${escapeHtml(quote.sourceDetail || quote.source || "--")}</div>
              <div class="prediction-meta">Price move: ${escapeHtml(changeLabel)}</div>
            </div>
            <div class="insight-drivers mt-1">
              ${(prediction.drivers || [])
                .map((driver) => `<span class="driver-pill">${escapeHtml(driver)}</span>`)
                .join("")}
            </div>
          </article>
        `;
      })
      .join("");
    return;
  }

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
          Signal strength: ${prediction.signalStrength ?? prediction.confidence}% | Horizon: ${prediction.horizonHours}h | Tickers: ${prediction.tickers?.join(", ") || "N/A"
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
          Trend: ${trendGlyph[insight.trend] || "-"} ${escapeHtml(insight.trend)} | Signal strength: ${insight.signalStrength ?? insight.confidence}%
        </div>
        <div class="insight-drivers">
          ${(insight.drivers || []).map((driver) => `<span class="driver-pill">${escapeHtml(driver)}</span>`).join("")}
        </div>
      </article>
    `
    )
    .join("");
}

function renderAiCountryInsights(ai = {}) {
  if (!elements.aiCountryShell || !elements.aiCountryList) return;
  const allowed = selectedIncludesAll() ? null : new Set(activeCountryList());
  const entries = Object.entries(ai.countryInsights || {}).filter(([iso2]) => !allowed || allowed.has(iso2));
  elements.aiCountryShell.classList.toggle("d-none", ai.mode !== "visible" || entries.length === 0);
  elements.aiCountryList.innerHTML = entries.map(([iso2, entry]) => {
    const output = entry.output;
    return `<article class="ai-enrichment-card">
      <div class="ai-enrichment-label">${escapeHtml(iso2)} · ${escapeHtml(aiStatusLabel(entry))}</div>
      <p>${escapeHtml(output?.overview || "AI enrichment is pending or unavailable.")}</p>
      ${renderAiEvidence(entry)}
      <div class="small text-light-emphasis">Generated content · ${escapeHtml(entry.model || "--")} · uncertainty ${escapeHtml(output?.uncertainty?.level || "unknown")}</div>
    </article>`;
  }).join("");
}

function renderAiMarketExplanations(ai = {}) {
  if (!elements.aiMarketShell || !elements.aiMarketList) return;
  const allowed = new Set(selectedMarketSymbols || []);
  const entries = Object.entries(ai.marketExplanations || {}).filter(([, entry]) => !allowed.size || allowed.has(entry.ticker));
  elements.aiMarketShell.classList.toggle("d-none", ai.mode !== "visible" || entries.length === 0);
  elements.aiMarketList.innerHTML = entries.map(([instrumentId, entry]) => {
    const output = entry.output;
    return `<article class="ai-enrichment-card">
      <div class="ai-enrichment-label">${escapeHtml(entry.ticker || instrumentId)} · ${escapeHtml(aiStatusLabel(entry))}</div>
      <p>${escapeHtml(output?.narrative || "AI enrichment is pending or unavailable.")}</p>
      ${renderAiEvidence(entry)}
      <div class="small text-light-emphasis">Generated content · causality ${escapeHtml(output?.causality || "not established")} · uncertainty ${escapeHtml(output?.uncertainty?.level || "unknown")}</div>
    </article>`;
  }).join("");
}

function renderMarketQuotes(market = { quotes: {} }) {
  const allowed = new Set(selectedMarketSymbols);
  const quotes = Object.entries(market.quotes || {}).filter(([ticker]) => !marketWatchlistLoaded || allowed.has(ticker));
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
      const sourceLabel = [quote.source || "unknown", quote.sourceDetail ? `/${quote.sourceDetail}` : ""].join("");
      const staleLabel = quote.stale === true || mode === "stale" ? "stale yes" : "stale no";
      const qualityBits = [
        quote.currency ? `currency ${quote.currency}` : null,
        quote.exchange ? `exchange ${quote.exchange}` : null,
        quote.session ? `session ${quote.session}` : null,
        quote.asOf ? `asOf ${quote.asOf}` : null,
        `data ${mode}`,
        staleLabel,
        Number.isFinite(Number(quote.providerScore)) ? `score ${Number(quote.providerScore)}` : null,
        Number.isFinite(Number(quote.providerLatencyMs)) ? `${Number(quote.providerLatencyMs)}ms` : null,
        quote.marketState ? `state ${String(quote.marketState).toLowerCase()}` : null
      ].filter(Boolean);
      return `
        <tr>
          <td>
            <div class="market-quote-head">
              <strong>${escapeHtml(ticker)}</strong>
              ${modeCell}
            </div>
            <div class="market-quote-meta">${escapeHtml(sourceLabel)} | ${escapeHtml(ageLabel)}${qualityBits.length ? ` | ${escapeHtml(qualityBits.join(" | "))}` : ""}</div>
          </td>
          <td>${Number.isFinite(quote.price) ? quote.price.toFixed(2) : "--"}</td>
          <td class="${cls}">${sign}${change.toFixed(2)}%</td>
        </tr>
      `;
    })
    .join("");
}

function marketInstrumentMeta(instrument = {}) {
  return [instrument.assetType, instrument.exchange, instrument.currency].filter(Boolean).join(" Â· ");
}

function renderMarketWatchlistSelection() {
  const maxSelected = Number.isInteger(Number(marketWatchlistModel.maxSelected)) && Number(marketWatchlistModel.maxSelected) > 0
    ? Number(marketWatchlistModel.maxSelected)
    : null;
  elements.marketWatchlistSelected.innerHTML = marketWatchlistDraft.length
    ? marketWatchlistDraft.map((instrument) => `
      <div class="market-watchlist-item">
        <span><strong>${escapeHtml(instrument.symbol)}</strong> â€” ${escapeHtml(instrument.displayName)}<br>
          <small>${escapeHtml(marketInstrumentMeta(instrument))}</small></span>
        <button type="button" class="btn btn-sm btn-outline-danger" data-market-remove="${escapeHtml(instrument.instrumentId)}">Remove</button>
      </div>`).join("")
    : '<div class="small text-light-emphasis">No instruments selected. Quotes and news-impact analysis will stay empty.</div>';
  elements.marketWatchlistStatus.textContent = maxSelected == null
    ? `${marketWatchlistDraft.length} selected`
    : `${marketWatchlistDraft.length}/${maxSelected} selected`;
  elements.marketWatchlistSave.disabled = !validateMarketSelection(marketWatchlistDraft, maxSelected).valid;
}

function syncOhlcvInstrumentOptions({ refresh = false } = {}) {
  const previous = elements.marketOhlcvInstrument.value;
  elements.marketOhlcvInstrument.innerHTML = marketWatchlistDraft.map((instrument) =>
    `<option value="${escapeHtml(instrument.instrumentId)}">${escapeHtml(instrument.symbol)} Â· ${escapeHtml(instrument.displayName)}</option>`
  ).join("");
  const preferred = marketWatchlistDraft.some((instrument) => instrument.instrumentId === previous)
    ? previous
    : marketWatchlistDraft[0]?.instrumentId || "";
  elements.marketOhlcvInstrument.value = preferred;
  elements.marketOhlcvInstrument.disabled = !preferred;
  if (!preferred) {
    marketOhlcvChart?.destroy();
    marketOhlcvChart = null;
    elements.marketOhlcvStatus.textContent = "Add an instrument to load OHLCV.";
  } else if (refresh) loadMarketOhlcv();
}

function renderMarketWatchlist(model, { refreshOhlcv = true } = {}) {
  marketWatchlistModel = model || { maxSelected: null, instruments: [] };
  marketWatchlistDraft = resolveSelectedMarketInstruments(marketWatchlistModel);
  selectedMarketSymbols = marketSelectionSymbols(marketWatchlistDraft);
  marketWatchlistLoaded = true;
  elements.marketWatchlistSearch.disabled = false;
  elements.marketWatchlistSearchStatus.textContent = "Search by ticker or company name.";
  renderMarketWatchlistSelection();
  syncOhlcvInstrumentOptions({ refresh: refreshOhlcv });
}

function currentMarketSearchResults() {
  try { return JSON.parse(elements.marketWatchlistSearchResults.dataset.results || "[]"); }
  catch { return []; }
}

function renderMarketSearchResults(instruments = []) {
  const selectedIds = new Set(marketSelectionIds(marketWatchlistDraft).map((value) => value.toLowerCase()));
  const configuredLimit = Number(marketWatchlistModel.maxSelected);
  const atLimit = Number.isInteger(configuredLimit) && configuredLimit > 0 && marketWatchlistDraft.length >= configuredLimit;
  elements.marketWatchlistSearchResults.innerHTML = instruments.length
    ? instruments.map((instrument) => {
      const selected = selectedIds.has(String(instrument.instrumentId || "").toLowerCase());
      return `<div class="market-watchlist-item">
        <span><strong>${escapeHtml(instrument.symbol)}</strong> â€” ${escapeHtml(instrument.displayName)}<br><small>${escapeHtml(marketInstrumentMeta(instrument))}</small></span>
        <button type="button" class="btn btn-sm btn-outline-info" data-market-add="${escapeHtml(instrument.instrumentId)}" ${selected || atLimit ? "disabled" : ""}>${selected ? "Selected" : "Add"}</button>
      </div>`;
    }).join("")
    : '<div class="small text-light-emphasis">No matching Yahoo instruments.</div>';
}

async function searchMarketInstruments() {
  const query = elements.marketWatchlistSearch.value.trim();
  if (query.length < 2) {
    elements.marketWatchlistSearchStatus.textContent = "Enter at least two characters.";
    elements.marketWatchlistSearchResults.innerHTML = "";
    return;
  }
  const requestKey = query.toLowerCase();
  if (marketSearchRequestKey === requestKey) return;
  const token = ++marketSearchToken;
  marketSearchRequestKey = requestKey;
  elements.marketWatchlistSearchStatus.textContent = "Searching Yahoo Financeâ€¦";
  try {
    const result = await api.getMarketInstrumentSearch({ q: query, limit: 12 });
    if (token !== marketSearchToken) return;
    const instruments = result?.instruments || [];
    elements.marketWatchlistSearchResults.dataset.results = JSON.stringify(instruments);
    renderMarketSearchResults(instruments);
    const meta = result?.meta || {};
    const sourceLabel = meta.source === "verified-registry"
      ? meta.degraded ? " Saved verified symbols shown while Yahoo Search is limited." : " Verified local symbol."
      : meta.source === "yahoo-quote" ? " Exact ticker verified with Yahoo Quote." : "";
    elements.marketWatchlistSearchStatus.textContent = `${instruments.length} result${instruments.length === 1 ? "" : "s"}.${sourceLabel}`;
    refreshMarketProviderStatus();
  } catch (error) {
    if (token !== marketSearchToken) return;
    const retryAfter = Number.isFinite(error.retryAfterSec) ? ` Retry after ${error.retryAfterSec}s.` : "";
    elements.marketWatchlistSearchStatus.textContent = error.code === "MARKET_SEARCH_PROVIDER_RATE_LIMITED"
      ? `Yahoo Finance instrument lookup is temporarily limited.${retryAfter} Existing results and saved symbols are preserved.`
      : `Search failed: ${error.message}`;
    refreshMarketProviderStatus();
  } finally {
    if (marketSearchRequestKey === requestKey) marketSearchRequestKey = null;
  }
}

function handleMarketWatchlistAction(event) {
  const add = event.target.closest("[data-market-add]");
  const remove = event.target.closest("[data-market-remove]");
  if (add) {
    const candidate = currentMarketSearchResults().find((instrument) => instrument.instrumentId === add.dataset.marketAdd);
    const result = addMarketInstrument(marketWatchlistDraft, candidate, marketWatchlistModel.maxSelected);
    marketWatchlistDraft = result.instruments;
    if (result.reason === "limit") elements.marketWatchlistStatus.textContent = `The watchlist is limited to ${marketWatchlistModel.maxSelected} instruments.`;
  } else if (remove) marketWatchlistDraft = removeMarketInstrument(marketWatchlistDraft, remove.dataset.marketRemove).instruments;
  else return;
  renderMarketWatchlistSelection();
  renderMarketSearchResults(currentMarketSearchResults());
}

async function loadMarketWatchlist() {
  try { renderMarketWatchlist(await api.getMarketWatchlist()); }
  catch (error) {
    marketWatchlistLoaded = true;
    elements.marketWatchlistSearchStatus.textContent = "Watchlist unavailable.";
    elements.marketWatchlistStatus.textContent = `Unable to load watchlist: ${error.message}`;
  }
}

async function saveMarketWatchlist() {
  if (!validateMarketSelection(marketWatchlistDraft, marketWatchlistModel.maxSelected).valid) return;
  elements.marketWatchlistSave.disabled = true;
  try {
    const saved = await api.updateMarketWatchlist(marketSelectionIds(marketWatchlistDraft));
    renderMarketWatchlist(saved);
    elements.marketWatchlistStatus.textContent = marketWatchlistModel.maxSelected == null
      ? `${marketWatchlistDraft.length} selected Â· saved`
      : `${marketWatchlistDraft.length}/${marketWatchlistModel.maxSelected} selected Â· saved`;
    renderMarketQuotes(getState().market || { quotes: {} });
    marketQuotesPoller?.trigger(0);
    await refreshAnalytics();
  } catch (error) { elements.marketWatchlistStatus.textContent = `Save failed: ${error.message}`; }
  finally { elements.marketWatchlistSave.disabled = false; }
}

function renderMarketOhlcv(payload, instrument) {
  const series = buildOhlcvChartSeries(payload?.candles || []);
  marketOhlcvChart?.destroy();
  marketOhlcvChart = null;
  if (!series.candles.length) {
    elements.marketOhlcvStatus.textContent = `${instrument?.symbol || "Instrument"}: no OHLCV data available.`;
    return;
  }
  marketOhlcvChart = new Chart(elements.marketOhlcvCanvas, {
    type: "bar",
    data: { labels: series.labels, datasets: [
      { type: "line", label: "Close", data: series.closes, borderColor: "#d9dddf", backgroundColor: "rgba(217,221,223,.12)", borderWidth: 2, pointRadius: 0, tension: .15, yAxisID: "price" },
      { type: "bar", label: "Volume", data: series.volumes, backgroundColor: "rgba(154,159,166,.28)", borderWidth: 0, yAxisID: "volume" }
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 7, color: "#9faebd", callback(_value, index) { return new Date(series.labels[index]).toLocaleDateString(); } }, grid: { display: false } },
        price: { position: "left", ticks: { color: "#9faebd" }, grid: { color: "rgba(255,255,255,.05)" } },
        volume: { position: "right", beginAtZero: true, ticks: { color: "#6f8192", maxTicksLimit: 4 }, grid: { display: false } }
      },
      plugins: {
        legend: { labels: { color: "#d7e3ea", boxWidth: 12 } },
        tooltip: { callbacks: { afterBody(items) { const candle = series.candles[items[0]?.dataIndex]; return candle ? [`O ${candle.open}  H ${candle.high}`, `L ${candle.low}  C ${candle.close}`, `V ${candle.volume ?? "n/a"}`] : []; } } }
      }
    }
  });
  elements.marketOhlcvStatus.textContent = `${instrument.symbol} Â· ${payload.status || "stored"} Â· ${series.candles.length} bars${payload.error?.message ? ` Â· ${payload.error.message}` : ""}`;
}

async function loadMarketOhlcv() {
  const instrumentId = elements.marketOhlcvInstrument.value;
  const instrument = marketWatchlistDraft.find((item) => item.instrumentId === instrumentId);
  if (!instrument) return;
  const token = ++marketOhlcvRequestToken;
  elements.marketOhlcvStatus.textContent = `Loading ${instrument.symbol} OHLCVâ€¦`;
  try {
    const payload = await api.getMarketCandles({ instrumentId, interval: elements.marketOhlcvInterval.value, adjusted: "splits", limit: 240 });
    if (token === marketOhlcvRequestToken) renderMarketOhlcv(payload, instrument);
  } catch (error) {
    if (token === marketOhlcvRequestToken) elements.marketOhlcvStatus.textContent = `OHLCV unavailable: ${error.message}`;
  }
}

function shouldIgnoreMarketPayload(market = {}) {
  const currentMarket = getState().market || {};
  const currentStamp = currentMarket.revision || currentMarket.updatedAt || null;
  const nextStamp = market.revision || market.updatedAt || null;
  return Boolean(nextStamp && currentStamp && nextStamp === currentStamp);
}

function applyMarketPayload(payload = {}) {
  if (!payload || !payload.market) {
    return false;
  }

  if (shouldIgnoreMarketPayload(payload.market)) {
    return false;
  }

  applyUpdate(payload);
  scheduleAnalyticsRefresh();
  return true;
}

function startMarketQuotesPolling() {
  if (marketQuotesPollerStarted) {
    return marketQuotesPoller;
  }

  marketQuotesPoller = new SmartPollLoop({
    immediate: false,
    delayResolver: ({ hidden }) =>
      resolveMarketQuotesPollDelayMs({
        hidden,
        marketOpen: Boolean(getState().market?.session?.open),
        dataMode: getState().market?.sourceMode || "live"
      }),
    task: async () => {
      const currentState = getState();
      const tickers = marketWatchlistLoaded ? selectedMarketSymbols : Object.keys(currentState.market?.quotes || {});
      if (!tickers.length) {
        return null;
      }

      return api.getMarketQuotes({ tickers });
    },
    onData: (payload) => {
      if (!payload) {
        return;
      }
      applyMarketPayload(payload);
    },
    onError: (error) => {
      console.error("Failed to refresh market quotes:", error);
    }
  });
  marketQuotesPollerStarted = true;
  marketQuotesPoller.start();
  return marketQuotesPoller;
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
    confidence: sector.signalStrength ?? sector.confidence,
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
      predictedConfidence: prediction.signalStrength || prediction.predictedConfidence || prediction.confidence || 0,
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
    (item) => DIRECTION_COLORS[item.direction] || "#a2a8ac"
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
    (point) => DIRECTION_COLORS[point.direction] || "#a2a8ac"
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
  renderNews(state.news, state.countries, rawState.ai || {});
  renderDistribution(state.countries);
  renderRiskChart(state.countries);
  renderPredictions(rawState.predictions || {}, rawState.market || {});
  renderInsights(state.insights, resolveInsightsEmptyReason(rawState, state));
  renderAiCountryInsights(rawState.ai || {});
  renderMarketQuotes(rawState.market || {});
  renderImpact(resolveRenderedImpact(rawState, state, analytics));
  renderAiMarketExplanations(rawState.ai || {});
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
      if (message.type === "market:quotes-bootstrap:v1") {
        applyMarketPayload(message.data || {});
        return;
      }
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
      if (message.type === "ai:update:v1") {
        applyUpdate(message.data || {});
        return;
      }
      if (message.type === "media:streams:updated") {
        window.dispatchEvent(new CustomEvent("media:streams:updated", { detail: message.data || {} }));
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
  const watchlist = Array.isArray(state.meta?.watchlistCountries)
    ? [...new Set(state.meta.watchlistCountries.map((iso2) => String(iso2 || "").toUpperCase()).filter(Boolean))]
    : [];

  if (!watchlist.length) {
    return;
  }

  const previousWatchlist = currentWatchlist.join(",");
  currentWatchlist = watchlist;

  if (!watchlistInitialized || !selectedCountries.size) {
    selectedCountries = new Set(currentWatchlist);
    watchlistInitialized = true;
    return;
  }

  if (selectedIncludesAll()) {
    return;
  }

  selectedCountries = new Set([...selectedCountries].filter((iso2) => currentWatchlist.includes(iso2)));
  if (!selectedCountries.size || previousWatchlist !== currentWatchlist.join(",")) {
    selectedCountries = new Set(currentWatchlist);
  }
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
  elements.countryFilterBar.addEventListener("change", handleCountryPickerChange);
  document.body.addEventListener("click", handleActionClick);
  elements.refreshNewsBtn.addEventListener("click", handleManualRefreshClick);
  elements.marketWatchlistSave.addEventListener("click", saveMarketWatchlist);
  elements.marketWatchlistSearchForm.addEventListener("submit", (event) => { event.preventDefault(); clearTimeout(marketSearchTimer); searchMarketInstruments(); });
  elements.marketWatchlistSearch.addEventListener("input", () => { clearTimeout(marketSearchTimer); marketSearchTimer = setTimeout(searchMarketInstruments, 350); });
  elements.marketWatchlistSearchResults.addEventListener("click", handleMarketWatchlistAction);
  elements.marketWatchlistSelected.addEventListener("click", handleMarketWatchlistAction);
  elements.marketOhlcvInstrument.addEventListener("change", loadMarketOhlcv);
  elements.marketOhlcvInterval.addEventListener("change", loadMarketOhlcv);
  await loadMarketWatchlist();

  subscribe((state) => {
    syncWatchlistFromState(state);
    renderCountryFilters();
    renderDashboard(state);
    syncManualRefreshFromMeta(state.meta);
  });

  setWsStatus("connecting");
  mountWebSocket();

  try {
    const snapshot = await api.getSnapshot({ countries: selectedCountryQueryValue(), limit: 100 });
    setSnapshot(snapshot);
    await refreshAnalytics();
  } catch (error) {
    console.error("Failed to fetch initial snapshot:", error);
    elements.newsFeed.innerHTML =
      '<div class="p-3 small text-danger">Failed to load initial intelligence snapshot.</div>';
  }

  startMarketQuotesPolling();
  marketQuotesPoller?.trigger(0);
  startMarketProviderPolling();

  window.addEventListener("beforeunload", () => {
    socket?.close();
    marketQuotesPoller?.stop();
    clearInterval(marketProviderPoller);
    clearTimeout(analyticsRefreshTimer);
    clearTimeout(marketSearchTimer);
    marketOhlcvChart?.destroy();
    clearInterval(manualRefreshCooldownTimer);
    teardownHandlers.forEach((teardown) => teardown?.());
  });
}

document.addEventListener("DOMContentLoaded", bootstrap);
