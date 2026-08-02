import { api } from "./api.js";
import { applyUpdate, getState, setSnapshot, subscribe } from "./state.js";
import { RealtimeSocket } from "./websocket.js";
import { SmartPollLoop } from "./smartPollLoop.js";
import { resolveMarketQuotesPollDelayMs } from "./marketPolling.js";
import { HotspotMap, getLevelColor } from "./map.js";
import { mountSituationalWorkspace } from "./media/situationalWorkspace.js";
import { startAdvancedIntelligence } from "./intelligence/advancedIntelligence.js";
import { mountAwarenessCenter } from "./awareness.js";
import {
  addMarketInstrument,
  marketSelectionIds,
  marketSelectionSymbols,
  removeMarketInstrument,
  resolveSelectedMarketInstruments,
  validateMarketSelection
} from "./marketWatchlistModel.js";
import { buildOhlcvChartSeries, buildOhlcvSummary } from "./marketOhlcvModel.js";
import {
  DEFAULT_MARKET_CONDITIONS_WINDOW_MIN,
  MARKET_CONDITIONS_WINDOWS,
  availabilityReasonDetails,
  inputStatusLabel,
  normalizeInputStatus,
  normalizeMarketConditions,
  scoreAriaLabel,
  scoreDisplay
} from "./marketConditionsModel.js";

const LEVEL_RANK = {
  Stable: 1,
  Monitoring: 2,
  Elevated: 3,
  Critical: 4
};

const NEWS_PLACEHOLDER_SRC = "/assets/news-placeholder.svg";
const MARKET_CONDITIONS_WINDOW_MINUTES = new Set(MARKET_CONDITIONS_WINDOWS.map((option) => option.minutes));

let hotspotMap;
let riskChart;
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
let marketConditionsRefreshTimer = null;
let latestMarketConditions = null;
let latestMarketConditionsContext = "";
let latestMarketConditionsError = "";
let marketConditionsRequestToken = 0;
let selectedMarketConditionsWindowMin = DEFAULT_MARKET_CONDITIONS_WINDOW_MIN;
let marketQuotesPoller = null;
let marketQuotesPollerStarted = false;
let manualRefreshPendingId = null;
let manualRefreshState = "idle";
let manualRefreshMessage = "Refresh: idle";
let manualRefreshCooldownEndsAtMs = 0;
let manualRefreshCooldownTimer = null;
let newsDrawerInstance = null;
let currentNewsById = new Map();
let advancedIntelligenceController = null;
let awarenessController = null;
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
  elements.riskChart = byId("risk-chart");
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
  elements.marketOhlcvOpen = byId("market-ohlcv-open");
  elements.marketOhlcvClose = byId("market-ohlcv-close");
  elements.marketOhlcvRange = byId("market-ohlcv-range");
  elements.marketOhlcvChange = byId("market-ohlcv-change");
  elements.aiMarketShell = byId("ai-market-shell");
  elements.aiMarketList = byId("ai-market-list");
  elements.aiCountryShell = byId("ai-country-shell");
  elements.aiCountryList = byId("ai-country-list");
  elements.marketConditionsInputBadge = byId("market-conditions-input-badge");
  elements.marketConditionsUpdated = byId("market-conditions-updated");
  elements.marketConditionsStatus = byId("market-conditions-status");
  elements.marketConditionsWindowSelector = byId("market-conditions-window-selector");
  elements.marketConditionsGeneral = byId("market-conditions-general");
  elements.marketConditionsSymbols = byId("market-conditions-symbols");
  elements.marketConditionsCountries = byId("market-conditions-countries");
  elements.marketConditionsLimitations = byId("market-conditions-limitations");
  elements.qualityHotspotsBadge = byId("quality-hotspots-badge");
  elements.qualityNewsBadge = byId("quality-news-badge");
  elements.qualityMarketBadge = byId("quality-market-badge");
  elements.panelHotspots = byId("panel-hotspots");
  elements.panelNews = byId("panel-news");
  elements.panelRisk = byId("panel-risk");
  elements.panelMarket = byId("panel-market");
  elements.panelMarketConditions = byId("panel-market-conditions");
  elements.panelAdvancedIntel = byId("panel-advanced-intel");
  elements.panelSituational = byId("panel-situational");
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

function isAiVisible(ai = {}) {
  const provider = String(ai.provider || ai.activeProvider || "none").trim().toLowerCase();
  return ai.enabled === true && ai.mode === "visible" && !["none", "off", "disabled"].includes(provider);
}

function articleAiEntry(articleId, ai = getState().ai || {}) {
  if (!isAiVisible(ai)) {
    return null;
  }
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

function renderMarketConditionsStatus(message = "", { error = false } = {}) {
  if (!elements.marketConditionsStatus) {
    return;
  }
  elements.marketConditionsStatus.textContent = message;
  elements.marketConditionsStatus.classList.toggle("is-error", error);
}

function renderMarketConditionsWindowSelector() {
  if (!elements.marketConditionsWindowSelector) {
    return;
  }

  elements.marketConditionsWindowSelector.innerHTML = `
    <div class="chart-selector-help small text-light-emphasis">Analysis window</div>
    <div class="chart-selector-chips" role="group" aria-label="Market conditions analysis window">
      ${MARKET_CONDITIONS_WINDOWS.map((option) => {
    const activeClass = option.minutes === selectedMarketConditionsWindowMin ? "active" : "";
    const pressed = option.minutes === selectedMarketConditionsWindowMin ? "true" : "false";
    return `<button class="chart-selector-chip ${activeClass}" type="button" data-action="set-market-conditions-window" data-window-min="${option.minutes}" aria-pressed="${pressed}">${option.label}</button>`;
  }).join("")}
    </div>
  `;
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

function formatMarketPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  return number.toLocaleString([], {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(number) < 1 ? 6 : 2
  });
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

  setPanelMode(elements.panelHotspots, dq.news?.mode || "fallback");
  setPanelMode(elements.panelNews, dq.news?.mode || "fallback");
  setPanelMode(elements.panelRisk, dq.news?.mode || "fallback");
  setPanelMode(elements.panelMarket, dq.market?.mode || "fallback");
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

  if (trigger.dataset.action === "open-news") {
    event.preventDefault();
    openNewsDrawer(trigger.dataset.newsId);
    return;
  }

  if (trigger.dataset.action === "set-market-conditions-window") {
    event.preventDefault();
    const windowMin = Number.parseInt(trigger.dataset.windowMin || "", 10);
    if (MARKET_CONDITIONS_WINDOW_MINUTES.has(windowMin) && windowMin !== selectedMarketConditionsWindowMin) {
      selectedMarketConditionsWindowMin = windowMin;
      renderMarketConditionsWindowSelector();
      refreshMarketConditions();
    }
  }
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

function renderRiskChart(countries) {
  const topCountries = Object.values(countries || {})
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  riskChart.data.labels = topCountries.map((country) => `${country.iso2} ${country.country}`);
  riskChart.data.datasets[0].data = topCountries.map((country) => country.score);
  riskChart.data.datasets[0].backgroundColor = topCountries.map((country) => getLevelColor(country.level));
  riskChart.update();
}

function formatConditionMetric(value, { digits = 1, suffix = "", signed = false } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "--";
  }
  const number = Number(value);
  const prefix = signed && number > 0 ? "+" : "";
  return `${prefix}${number.toFixed(digits)}${suffix}`;
}

function marketConditionAvailabilityView(symbol) {
  const availability = symbol.availability || {};
  const details = availabilityReasonDetails(availability.primaryReason, { analyzable: availability.analyzable });
  const statusClass = details.code || "available";
  const retainedScore = symbol.operabilityScore !== null || symbol.directionScore !== null;
  const messageParts = [];
  if (details.code) messageParts.push(details.message);
  if (details.code === "stale_local_data" && retainedScore) {
    messageParts.push("Retained scores remain visible but cannot be presented as favorable conditions.");
  } else if (!availability.analyzable && retainedScore) {
    messageParts.push("Displayed values are retained from the latest eligible observations.");
  }
  if (availability.availableClosedCandles !== null) {
    messageParts.push(`${availability.availableClosedCandles} of ${availability.requiredClosedCandles} required closed candles are available.`);
  }
  if (details.code === "stale_local_data" && availability.lastCandleAt) {
    messageParts.push(`Last local candle: ${formatDate(availability.lastCandleAt)}.`);
  }
  if (details.code === "stale_local_data" && availability.expectedLatestCandleAt) {
    messageParts.push(`Expected coverage through: ${formatDate(availability.expectedLatestCandleAt)}.`);
  }
  if (availability.ingestionState === "unsupported") {
    messageParts.push("Automatic 5-minute ingestion is not supported for this session policy.");
  } else if (availability.ingestionState === "disabled") {
    messageParts.push("Scheduled intraday ingestion is disabled.");
  } else if (availability.ingestionState === "not_scheduled") {
    messageParts.push("This instrument is not scheduled for intraday collection.");
  }
  if (availability.nextEligibleAt) {
    messageParts.push(`Next eligible session: ${formatDate(availability.nextEligibleAt)}.`);
  }
  return {
    className: statusClass,
    label: details.label,
    message: messageParts.join(" "),
    unavailableAria: `${symbol.ticker} score unavailable. ${details.message}`
  };
}

function renderMarketConditionsGeneral(snapshot) {
  const score = snapshot.market.stabilityScore;
  const band = snapshot.market.band;
  const scoreEmpty = score === null;
  const scoreStyle = scoreEmpty ? "" : ` style="--gauge-value: ${score}"`;
  const coverage = snapshot.quality.coveragePct === null ? "--" : `${Math.round(snapshot.quality.coveragePct)}%`;
  const latestNewsAge = snapshot.quality.latestNewsAgeMin === null ? "--" : `${Math.round(snapshot.quality.latestNewsAgeMin)}m`;
  const latestCandleAge = snapshot.quality.latestCandleAgeMin === null ? "--" : `${Math.round(snapshot.quality.latestCandleAgeMin)}m`;
  const sourceLabels = snapshot.sourceSummary
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const label = entry?.sourceName || entry?.provider || entry?.source || "source";
      const count = Number.isFinite(Number(entry?.count)) ? ` (${Number(entry.count)})` : "";
      return `${label}${count}`;
    })
    .filter(Boolean)
    .slice(0, 5);
  const factorHtml = snapshot.market.components.length
    ? snapshot.market.components.map((component) => `
      <div class="market-condition-factor">
        <div class="market-condition-factor-head">
          <strong>${escapeHtml(component.label)}</strong>
          <strong>${escapeHtml(scoreDisplay(component.score))}</strong>
        </div>
        <div class="market-condition-factor-track" aria-hidden="true"><span style="--factor-value: ${component.score ?? 0}"></span></div>
        ${component.summary ? `<div class="market-condition-meta mt-1">${escapeHtml(component.summary)}</div>` : ""}
      </div>
    `).join("")
    : renderEmptyStateCard("No factor breakdown is available for this window.");
  const driverHtml = snapshot.market.drivers.length
    ? snapshot.market.drivers.map((driver) => `
      <div class="market-condition-driver">
        <strong>${escapeHtml(driver.label)}</strong>
        <div class="market-condition-meta mt-1">Direction: ${escapeHtml(driver.direction)}${driver.evidenceCount === null ? "" : ` | evidence: ${driver.evidenceCount}`}</div>
      </div>
    `).join("")
    : "";

  elements.marketConditionsGeneral.innerHTML = `
    <div class="market-condition-score-row">
      <div class="market-condition-donut band-${escapeHtml(band)} ${scoreEmpty ? "is-empty" : ""}"${scoreStyle} role="img" aria-label="${escapeHtml(scoreAriaLabel("Market stability", score, band))}">
        <div class="market-condition-donut-content"><strong>${escapeHtml(scoreDisplay(score))}</strong><span>stability index</span></div>
      </div>
      <div class="market-condition-band">
        <strong>${escapeHtml(band)}</strong>
        <span>Coverage ${escapeHtml(coverage)}</span>
        <span>News age ${escapeHtml(latestNewsAge)}</span>
        <span>Candle age ${escapeHtml(latestCandleAge)}</span>
        <span>Window ${escapeHtml(snapshot.window.label)}</span>
        <span>Bars ${escapeHtml(snapshot.window.indicatorInterval || "--")}</span>
      </div>
    </div>
    ${sourceLabels.length ? `<div class="market-condition-meta">Top sources: ${escapeHtml(sourceLabels.join(", "))}</div>` : ""}
    <div class="market-condition-factor-list">${factorHtml}</div>
    ${driverHtml ? `<div class="market-condition-driver-list">${driverHtml}</div>` : ""}
  `;
}

function renderMarketConditionSymbol(symbol) {
  const operabilityEmpty = symbol.operabilityScore === null;
  const directionEmpty = symbol.directionScore === null || !symbol.pressure;
  const availabilityView = marketConditionAvailabilityView(symbol);
  const operabilityStyle = operabilityEmpty ? "" : ` style="--gauge-value: ${symbol.operabilityScore}"`;
  const subtitle = [symbol.displayName !== symbol.ticker ? symbol.displayName : "", symbol.sector, symbol.assetType]
    .filter(Boolean)
    .join(" | ");
  const drivers = symbol.drivers.length
    ? `<div class="market-condition-driver-pills">${symbol.drivers.map((driver) => {
      const strength = driver.strength === null ? "" : ` ${Math.round(Math.abs(driver.strength))}`;
      return `<span class="driver-pill">${escapeHtml(driver.label)} | ${escapeHtml(driver.direction)}${strength}</span>`;
    }).join("")}</div>`
    : "";
  const pressureStyle = symbol.pressure
    ? `--pressure-positive: ${symbol.pressure.positiveEnd}; --pressure-neutral: ${symbol.pressure.neutralEnd}`
    : "";
  const directionStyle = directionEmpty ? "" : ` style="${pressureStyle}"`;
  const operabilityAria = operabilityEmpty
    ? availabilityView.unavailableAria.replace("score", "operability")
    : scoreAriaLabel(`${symbol.ticker} operability`, symbol.operabilityScore, symbol.operabilityBand);
  const directionAria = symbol.pressure
    ? `${scoreAriaLabel(`${symbol.ticker} direction`, symbol.directionScore, symbol.directionBand, { signed: true })}. Pressure distribution: ${symbol.pressure.positive} percent positive, ${symbol.pressure.neutral} percent neutral, ${symbol.pressure.negative} percent negative.`
    : directionEmpty
      ? availabilityView.unavailableAria.replace("score", "direction")
      : scoreAriaLabel(`${symbol.ticker} direction`, symbol.directionScore, symbol.directionBand, { signed: true });

  return `
    <article class="market-condition-symbol" role="listitem">
      <div class="market-condition-symbol-header">
        <div class="market-condition-symbol-title">
          <strong>${escapeHtml(symbol.ticker)}</strong>
          <span title="${escapeHtml(subtitle)}">${escapeHtml(subtitle || "Observed instrument")}</span>
        </div>
        <div class="market-condition-symbol-badges" aria-label="Availability and input quality">
          <span class="badge availability-status-${escapeHtml(availabilityView.className)}" aria-label="Availability: ${escapeHtml(availabilityView.label)}">${escapeHtml(availabilityView.label)}</span>
          <span class="badge input-status-${escapeHtml(symbol.quality.status)}" aria-label="Input quality: ${escapeHtml(symbol.quality.status)}">Quality: ${escapeHtml(symbol.quality.status)}</span>
        </div>
      </div>
      ${availabilityView.message ? `<div class="market-condition-availability-message" role="note"><strong>${escapeHtml(availabilityView.label)}.</strong> ${escapeHtml(availabilityView.message)}</div>` : ""}
      <div class="market-condition-symbol-gauges">
        <div class="market-condition-mini-gauge">
          <div class="market-condition-mini-donut band-${escapeHtml(symbol.operabilityBand)} ${operabilityEmpty ? "is-empty" : ""}"${operabilityStyle} role="img" aria-label="${escapeHtml(operabilityAria)}"><strong>${escapeHtml(scoreDisplay(symbol.operabilityScore))}</strong></div>
          <div class="market-condition-mini-label"><span>Operability</span><strong>${escapeHtml(symbol.operabilityBand)}</strong></div>
        </div>
        <div class="market-condition-mini-gauge">
          <div class="market-condition-mini-donut is-pressure ${directionEmpty ? "is-empty" : ""}"${directionStyle} role="img" aria-label="${escapeHtml(directionAria)}"><strong>${escapeHtml(scoreDisplay(symbol.directionScore, { signed: true }))}</strong></div>
          <div class="market-condition-mini-label"><span>Direction</span><strong>${escapeHtml(symbol.directionBand)}</strong>${symbol.pressure ? `<span>+${symbol.pressure.positive}% | =${symbol.pressure.neutral}% | -${symbol.pressure.negative}%</span>` : ""}</div>
        </div>
      </div>
      <div class="market-condition-metric-grid">
        <span>Return ${escapeHtml(formatConditionMetric(symbol.metrics.windowReturnPct, { digits: 2, suffix: "%", signed: true }))}</span>
        <span>RSI ${escapeHtml(formatConditionMetric(symbol.metrics.rsi))}</span>
        <span>ATR ${escapeHtml(formatConditionMetric(symbol.metrics.atrPct, { suffix: "%" }))}</span>
        <span>Vol ${escapeHtml(formatConditionMetric(symbol.metrics.realizedVolatilityPct, { suffix: "%" }))}</span>
        <span>Linked news ${escapeHtml(formatConditionMetric(symbol.metrics.linkedNewsCount, { digits: 0 }))}</span>
        <span>Observed coupling ${escapeHtml(formatConditionMetric(symbol.metrics.couplingCount, { digits: 0 }))}</span>
        <span>Candle age ${symbol.quality.latestCandleAgeMin === null ? "--" : `${Math.round(symbol.quality.latestCandleAgeMin)}m`}</span>
      </div>
      ${drivers}
    </article>
  `;
}

function renderMarketConditionsSymbols(snapshot) {
  elements.marketConditionsSymbols.innerHTML = snapshot.symbols.length
    ? snapshot.symbols.map(renderMarketConditionSymbol).join("")
    : renderEmptyStateCard("No observed instrument has sufficient local inputs for this window.");
}

function renderMarketConditionsCountries(snapshot) {
  const trendGlyph = { Escalating: "^", "De-escalating": "v", Flat: "-" };
  const context = snapshot.countryContext;
  if (!context.items.length) {
    elements.marketConditionsCountries.innerHTML = renderEmptyStateCard(
      "No country context is available for the current geopolitical cycle.",
      selectedIncludesAll() ? "" : "View ALL countries"
    );
    return;
  }

  elements.marketConditionsCountries.innerHTML = context.items.map((country) => `
    <article class="market-condition-country" role="listitem">
      <div class="market-condition-country-header">
        <div class="market-condition-country-title">
          <strong>${escapeHtml(country.country)}</strong>
          <span>${escapeHtml(country.iso2)} | ${escapeHtml(context.contextWindow)}</span>
        </div>
        <span class="badge ${levelBadgeClass(country.level)}">${escapeHtml(country.level)}</span>
      </div>
      <p>${escapeHtml(country.summary)}</p>
      <div class="market-condition-country-meta">Trend: ${trendGlyph[country.trend] || "-"} ${escapeHtml(country.trend)}</div>
      ${country.drivers.length ? `<div class="market-condition-driver-pills">${country.drivers.map((driver) => `<span class="driver-pill">${escapeHtml(driver)}</span>`).join("")}</div>` : ""}
    </article>
  `).join("");
}

function renderMarketConditions(snapshot = null, { error = "" } = {}) {
  if (!snapshot) {
    const message = error || "Loading deterministic market conditions...";
    elements.marketConditionsInputBadge.className = "badge input-status-insufficient";
    elements.marketConditionsInputBadge.textContent = "Inputs: insufficient";
    elements.marketConditionsUpdated.textContent = "--";
    elements.marketConditionsGeneral.innerHTML = renderEmptyStateCard(message);
    elements.marketConditionsSymbols.innerHTML = renderEmptyStateCard(message);
    elements.marketConditionsCountries.innerHTML = renderEmptyStateCard(message);
    elements.marketConditionsLimitations.textContent = "";
    renderMarketConditionsStatus(message, { error: Boolean(error) });
    setPanelMode(elements.panelMarketConditions, "fallback");
    return;
  }

  const normalized = normalizeMarketConditions(snapshot);
  const inputStatus = normalizeInputStatus(normalized.quality.status);
  elements.marketConditionsInputBadge.className = `badge input-status-${inputStatus}`;
  elements.marketConditionsInputBadge.textContent = inputStatusLabel(inputStatus);
  elements.marketConditionsInputBadge.title = normalized.quality.limitations.join(" ");
  elements.marketConditionsUpdated.textContent = normalized.generatedAt ? `Generated: ${formatDate(normalized.generatedAt)}` : "Generated: --";
  setPanelMode(elements.panelMarketConditions, inputStatus === "partial" ? "mixed" : ["stale", "insufficient"].includes(inputStatus) ? "fallback" : "live");
  renderMarketConditionsGeneral(normalized);
  renderMarketConditionsSymbols(normalized);
  renderMarketConditionsCountries(normalized);
  const limitations = [...new Set([...normalized.quality.limitations, ...normalized.limitations])];
  elements.marketConditionsLimitations.textContent = limitations.length ? `Limitations: ${limitations.join(" ")}` : "";
  const statusParts = [
    `${normalized.window.label} analysis`,
    `${normalized.symbols.length} instrument${normalized.symbols.length === 1 ? "" : "s"}`,
    normalized.methodVersion
  ];
  renderMarketConditionsStatus(statusParts.join(" | "));
}

function renderAiCountryInsights(ai = {}) {
  if (!elements.aiCountryShell || !elements.aiCountryList) return;
  const allowed = selectedIncludesAll() ? null : new Set(activeCountryList());
  const entries = Object.entries(ai.countryInsights || {}).filter(([iso2]) => !allowed || allowed.has(iso2));
  elements.aiCountryShell.classList.toggle("d-none", !isAiVisible(ai) || entries.length === 0);
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
  elements.aiMarketShell.classList.toggle("d-none", !isAiVisible(ai) || entries.length === 0);
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
    await refreshMarketConditions();
  } catch (error) { elements.marketWatchlistStatus.textContent = `Save failed: ${error.message}`; }
  finally { elements.marketWatchlistSave.disabled = false; }
}

function renderMarketOhlcv(payload, instrument) {
  const series = buildOhlcvChartSeries(payload?.candles || []);
  marketOhlcvChart?.destroy();
  marketOhlcvChart = null;
  if (!series.candles.length) {
    elements.marketOhlcvOpen.textContent = "--";
    elements.marketOhlcvClose.textContent = "--";
    elements.marketOhlcvRange.textContent = "--";
    elements.marketOhlcvChange.textContent = "--";
    elements.marketOhlcvChange.className = "";
    elements.marketOhlcvStatus.textContent = `${instrument?.symbol || "Instrument"}: no OHLCV data available.`;
    return;
  }
  const summary = buildOhlcvSummary(series.candles);
  elements.marketOhlcvOpen.textContent = formatMarketPrice(summary.open);
  elements.marketOhlcvClose.textContent = formatMarketPrice(summary.close);
  elements.marketOhlcvRange.textContent = `${formatMarketPrice(summary.low)} – ${formatMarketPrice(summary.high)}`;
  elements.marketOhlcvChange.textContent = summary.changePct == null
    ? "--"
    : `${summary.changePct >= 0 ? "+" : ""}${summary.changePct.toFixed(2)}%`;
  elements.marketOhlcvChange.className = summary.changePct == null
    ? ""
    : summary.changePct >= 0 ? "market-positive" : "market-negative";
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
  let payload;
  try {
    payload = await api.getMarketCandles({ instrumentId, interval: elements.marketOhlcvInterval.value, adjusted: "splits", limit: 240 });
  } catch (error) {
    if (token === marketOhlcvRequestToken) elements.marketOhlcvStatus.textContent = `OHLCV request failed: ${error.message}`;
    return;
  }
  if (token !== marketOhlcvRequestToken) return;
  try {
    renderMarketOhlcv(payload, instrument);
  } catch (error) {
    console.error("Failed to render OHLCV:", error);
    elements.marketOhlcvStatus.textContent = "OHLCV data loaded, but the chart could not be rendered.";
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
  scheduleMarketConditionsRefresh();
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

function renderDashboard(rawState) {
  const state = filterStateBySelection(rawState);
  renderMeta(rawState.meta, rawState.market || {});
  renderNews(state.news, state.countries, rawState.ai || {});
  renderDistribution(state.countries);
  renderRiskChart(state.countries);
  renderAiCountryInsights(rawState.ai || {});
  renderMarketQuotes(rawState.market || {});
  renderAiMarketExplanations(rawState.ai || {});
  renderMarketConditions(
    marketConditionsMatchesCurrentContext() ? latestMarketConditions : null,
    { error: latestMarketConditionsError }
  );
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

function marketConditionsContextKey() {
  return `${selectedCountryQueryValue()}|${selectedMarketConditionsWindowMin}|${[...selectedMarketSymbols].sort().join(",")}`;
}

function marketConditionsMatchesCurrentContext() {
  return Boolean(latestMarketConditions) && latestMarketConditionsContext === marketConditionsContextKey();
}

async function refreshMarketConditions() {
  const requestToken = ++marketConditionsRequestToken;
  const countryKey = selectedCountryQueryValue();
  const contextKey = marketConditionsContextKey();
  renderMarketConditionsStatus(`Loading ${formatWindowLabel(selectedMarketConditionsWindowMin)} market conditions...`);
  try {
    const payload = await api.getMarketConditions({
      countries: countryKey,
      windowMin: selectedMarketConditionsWindowMin
    });
    if (requestToken !== marketConditionsRequestToken) {
      return;
    }
    latestMarketConditions = payload;
    latestMarketConditionsContext = contextKey;
    latestMarketConditionsError = "";
    renderDashboard(getState());
  } catch (error) {
    if (requestToken !== marketConditionsRequestToken) {
      return;
    }
    latestMarketConditions = null;
    latestMarketConditionsContext = contextKey;
    latestMarketConditionsError = "Market conditions are unavailable. Existing quotes and country risk remain unchanged.";
    console.error("Failed to refresh market conditions:", error);
    renderDashboard(getState());
  }
}

function scheduleMarketConditionsRefresh() {
  clearTimeout(marketConditionsRefreshTimer);
  marketConditionsRefreshTimer = setTimeout(() => {
    refreshMarketConditions();
  }, 500);
}

async function requestFilteredSnapshot() {
  void advancedIntelligenceController?.refresh();
  try {
    latestMarketConditions = null;
    latestMarketConditionsContext = "";
    latestMarketConditionsError = "";
    const snapshot = await api.getSnapshot({
      countries: selectedCountryQueryValue(),
      limit: 100
    });
    setSnapshot(snapshot);
    awarenessController?.syncCompact(snapshot?.awareness);
    await refreshMarketConditions();
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
        awarenessController?.syncCompact(message.data?.awareness);
        void advancedIntelligenceController?.refresh();
        scheduleMarketConditionsRefresh();
        return;
      }
      if (message.type === "update") {
        applyUpdate(message.data);
        awarenessController?.syncCompact(message.data?.awareness);
        void advancedIntelligenceController?.refresh();
        scheduleMarketConditionsRefresh();
        return;
      }
      if (message.type === "ai:update:v1") {
        applyUpdate(message.data || {});
        return;
      }
      if (message.type === "awareness:update:v1") {
        awarenessController?.applyRealtime(message.data || {});
        scheduleMarketConditionsRefresh();
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
  renderMarketConditionsWindowSelector();
  hotspotMap = new HotspotMap("hotspot-map");
  hotspotMap.init();
  const handleAwarenessMapEvents = (event) => hotspotMap?.setAwarenessEvents(event.detail?.events || []);
  window.addEventListener("awareness:map-events:v1", handleAwarenessMapEvents);
  teardownHandlers.push(() => window.removeEventListener("awareness:map-events:v1", handleAwarenessMapEvents));
  teardownHandlers.push(mountSituationalWorkspace({ api }));
  advancedIntelligenceController = startAdvancedIntelligence({ api, getCountries: selectedCountryQueryValue });
  teardownHandlers.push(() => advancedIntelligenceController?.stop());
  awarenessController = mountAwarenessCenter({ api });
  teardownHandlers.push(() => awarenessController?.stop());
  initRiskChart();

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
    awarenessController?.syncCompact(snapshot?.awareness);
    await refreshMarketConditions();
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
    clearTimeout(marketConditionsRefreshTimer);
    clearTimeout(marketSearchTimer);
    marketOhlcvChart?.destroy();
    clearInterval(manualRefreshCooldownTimer);
    teardownHandlers.forEach((teardown) => teardown?.());
  });
}

document.addEventListener("DOMContentLoaded", bootstrap);
