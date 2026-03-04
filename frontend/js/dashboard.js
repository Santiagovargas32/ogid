import { api } from "./api.js";
import { applyUpdate, setSnapshot, subscribe } from "./state.js";
import { RealtimeSocket } from "./websocket.js";
import { HotspotMap, getLevelColor } from "./map.js";

const LEVEL_RANK = {
  Stable: 1,
  Monitoring: 2,
  Elevated: 3,
  Critical: 4
};

const DEFAULT_WATCHLIST = ["US", "IL", "IR"];
const CHART_COLORS = ["#49d6c5", "#ff8c42", "#f4c542", "#38c172", "#6fb1ff", "#ff4d4f", "#c59aff"];
const NEWS_PLACEHOLDER_SRC = "/assets/news-placeholder.svg";
const DIRECTION_COLORS = {
  Bullish: "#38c172",
  Bearish: "#ff4d4f",
  Volatile: "#ff8c42",
  Sideways: "#6fb1ff"
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
let analyticsPoller = null;
let analyticsRefreshTimer = null;
let latestAnalytics = null;

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
  elements.apiLimitsPanel = byId("api-limits-panel");
  elements.toggleApiLimits = byId("toggle-api-limits");
  elements.apiLimitsBody = byId("api-limits-body");
  elements.apiLimitsUpdated = byId("api-limits-updated");
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
  return mode === "live" ? "text-bg-success" : "text-bg-warning";
}

function qualityBadgeClass(mode) {
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

  return {
    ...state,
    news: filteredNews,
    hotspots: filteredHotspots,
    countries: filteredCountries,
    insights: filteredInsights,
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
  panel.classList.remove("panel-fallback", "panel-mixed");
  if (mode === "fallback") {
    panel.classList.add("panel-fallback");
  }
  if (mode === "mixed") {
    panel.classList.add("panel-mixed");
  }
}

function setQualityBadge(element, label, quality = {}) {
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
  elements.marketUpdatedText.textContent = `Quotes: ${formatDate(market.updatedAt)}`;

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

function renderNews(news = [], countries = {}) {
  const ordered = [...news].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  elements.newsCount.textContent = `${ordered.length} items`;

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
      const description = String(article.description || "").trim() || "No description provided.";
      const safeImageUrl = String(article.imageUrl || "").trim();
      const thumbnail = safeImageUrl
        ? `<img class="news-thumb" src="${escapeHtml(safeImageUrl)}" alt="news image" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${NEWS_PLACEHOLDER_SRC}';this.classList.add('news-thumb-fallback')" />`
        : `<img class="news-thumb news-thumb-placeholder news-thumb-fallback" src="${NEWS_PLACEHOLDER_SRC}" alt="No image" loading="lazy" />`;
      const flag = article.synthetic ? '<span class="news-flag">SIMULATED</span>' : "";

      return `
      <article class="news-item ${newsLevelClass(level)}">
        ${thumbnail}
        <div class="news-content">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(description)}</p>
          <div class="news-item-meta">
            <span>${escapeHtml(article.sourceName)}</span>
            <span>${formatDate(article.publishedAt)}</span>
            <span>${escapeHtml(level)}</span>
            <span>${escapeHtml(mentions)}</span>
            <span>${escapeHtml((article.provider || "").toUpperCase())}</span>
            ${flag}
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
      ticks: { color: "#c7d4e2" },
      grid: { color: "rgba(151, 169, 190, 0.12)" }
    },
    y: {
      beginAtZero: true,
      ticks: { color: "#c7d4e2" },
      grid: { color: "rgba(151, 169, 190, 0.16)" }
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
          backgroundColor: []
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
        legend: { labels: { color: "#c7d4e2" } },
        tooltip: {
          callbacks: {
            label(context) {
              const raw = context.raw || {};
              return `${raw.ticker || "N/A"} | ${raw.direction || "Sideways"} | score: ${raw.predictionScore || 0}`;
            }
          }
        }
      },
      scales: {
        x: { ...chartAxesOptions().x, title: { display: true, text: "Event Score", color: "#c7d4e2" } },
        y: { ...chartAxesOptions().y, title: { display: true, text: "Predicted Confidence", color: "#c7d4e2" } }
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
      plugins: { legend: { labels: { color: "#c7d4e2" } } },
      scales: {
        x: { ...chartAxesOptions().x, title: { display: true, text: "Time", color: "#c7d4e2" } },
        y: { ...chartAxesOptions().y, title: { display: true, text: "Impact / Price Coupling", color: "#c7d4e2" } }
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
          Confidence: ${prediction.confidence}% | Horizon: ${prediction.horizonHours}h | Tickers: ${
            prediction.tickers?.join(", ") || "N/A"
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

function renderInsights(insights = []) {
  if (!insights.length) {
    elements.insightsList.innerHTML = '<div class="p-3 small text-light-emphasis">No insights available.</div>';
    return;
  }

  const trendGlyph = {
    Escalating: "^",
    "De-escalating": "v",
    Flat: "-"
  };

  elements.insightsList.innerHTML = insights
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
    elements.marketQuotesBody.innerHTML =
      '<tr><td colspan="3" class="text-light-emphasis">No market quotes available.</td></tr>';
    return;
  }

  elements.marketQuotesBody.innerHTML = quotes
    .map(([ticker, quote]) => {
      const change = Number(quote.changePct || 0);
      const cls = change >= 0 ? "text-up" : "text-down";
      const sign = change >= 0 ? "+" : "";
      const modeCell = quote.synthetic ? '<span class="badge text-bg-warning data-mode-cell">SIM</span>' : "";
      return `
        <tr>
          <td>${escapeHtml(ticker)} ${modeCell}</td>
          <td>${Number.isFinite(quote.price) ? quote.price.toFixed(2) : "--"}</td>
          <td class="${cls}">${sign}${change.toFixed(2)}%</td>
        </tr>
      `;
    })
    .join("");
}

function renderImpact(impact = { items: [] }) {
  const items = impact.items || [];
  if (!items.length) {
    elements.marketImpactList.innerHTML =
      '<div class="p-3 small text-light-emphasis">No impact signals available for current filters.</div>';
    return;
  }

  elements.marketImpactList.innerHTML = items
    .slice(0, 20)
    .map(
      (item) => `
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
      </article>
    `
    )
    .join("");
}

function visibleTickersForCharts(state) {
  const fromImpact = (state.impact?.items || []).map((item) => item.ticker);
  if (fromImpact.length) {
    return new Set(fromImpact);
  }
  return new Set(Object.keys(state.market?.quotes || {}));
}

function resolveAnalyticsPayload(rawState) {
  if (
    latestAnalytics?.predictedSectorDirection ||
    latestAnalytics?.tickerOutlookMatrix ||
    latestAnalytics?.couplingSeries
  ) {
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
    return {
      ticker: prediction.ticker,
      sector: prediction.sector,
      direction: prediction.direction,
      eventScore: impact.eventScore || 0,
      impactScore: impact.impactScore || 0,
      predictedConfidence: prediction.predictedConfidence || prediction.confidence || 0,
      predictionScore: prediction.predictionScore || 0,
      changePct: Number(quote.changePct || 0),
      radius: Math.max(3, Math.min(18, Math.abs(Number(quote.changePct || 0)) * 2 + 4))
    };
  });

  const couplingSeries = (rawState.impact?.couplingSeries || []).slice(0, 3);

  return {
    predictedSectorDirection,
    tickerOutlookMatrix,
    couplingSeries
  };
}

function renderPredictedSectorDirection(items = []) {
  impactTimelineChart.data.labels = items.map(
    (item) => `${String(item.sector || "unknown").toUpperCase()} (${Number(item.confidence || 0)}%)`
  );
  impactTimelineChart.data.datasets[0].data = items.map((item) => Number(item.score || 0));
  impactTimelineChart.data.datasets[0].backgroundColor = items.map(
    (item) => DIRECTION_COLORS[item.direction] || "#6fb1ff"
  );
  impactTimelineChart.data.datasets[0].confidenceMap = items.map((item) => Number(item.confidence || 0));
  impactTimelineChart.update();
}

function renderTickerOutlookMatrix(items = [], visibleTickers = new Set()) {
  const points = items
    .filter((item) => visibleTickers.has(item.ticker))
    .map((item) => ({
      x: Number(item.eventScore || 0),
      y: Number(item.predictedConfidence || 0),
      r: Number(item.radius || 6),
      ticker: item.ticker,
      direction: item.direction,
      predictionScore: Number(item.predictionScore || 0),
      changePct: Number(item.changePct || 0)
    }));

  sectorBreakdownChart.data.datasets[0].data = points;
  sectorBreakdownChart.data.datasets[0].pointBackgroundColor = points.map(
    (point) => DIRECTION_COLORS[point.direction] || "#6fb1ff"
  );
  sectorBreakdownChart.update();
}

function renderNewsPriceCoupling(couplingSeries = [], visibleTickers = new Set()) {
  const selected = couplingSeries.filter((series) => visibleTickers.has(series.ticker)).slice(0, 3);
  if (!selected.length) {
    impactScatterChart.data.labels = [];
    impactScatterChart.data.datasets = [];
    impactScatterChart.update();
    return;
  }

  const labels = [...new Set(selected.flatMap((series) => (series.points || []).map((point) => point.timestamp)))]
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
    .map((timestamp) => formatShortTime(timestamp));

  const datasets = [];
  selected.forEach((series, index) => {
    const rawPoints = series.points || [];
    const map = new Map(rawPoints.map((point) => [formatShortTime(point.timestamp), point]));
    const color = CHART_COLORS[index % CHART_COLORS.length];

    datasets.push({
      label: `${series.ticker} impact`,
      data: labels.map((label) => Number(map.get(label)?.impactScore ?? null)),
      borderColor: color,
      backgroundColor: color,
      tension: 0.25
    });
    datasets.push({
      label: `${series.ticker} priceReaction`,
      data: labels.map((label) => Number(map.get(label)?.priceReaction ?? null)),
      borderColor: color,
      backgroundColor: color,
      borderDash: [5, 5],
      tension: 0.25
    });

    if (Number.isFinite(series.predictionScore) && index === 0) {
      datasets.push({
        label: `${series.ticker} predictionScore`,
        data: labels.map(() => Number(series.predictionScore || 0)),
        borderColor: "#f4c542",
        backgroundColor: "#f4c542",
        borderDash: [2, 3],
        pointRadius: 0,
        tension: 0
      });
    }
  });

  impactScatterChart.data.labels = labels;
  impactScatterChart.data.datasets = datasets;
  impactScatterChart.update();
}

function renderCharts(rawState, filteredState) {
  const analytics = resolveAnalyticsPayload(rawState);
  const visibleTickers = visibleTickersForCharts(filteredState);
  renderPredictedSectorDirection(analytics.predictedSectorDirection || []);
  renderTickerOutlookMatrix(analytics.tickerOutlookMatrix || [], visibleTickers);
  renderNewsPriceCoupling(analytics.couplingSeries || [], visibleTickers);
}

function renderDashboard(rawState) {
  const state = filterStateBySelection(rawState);
  renderMeta(rawState.meta, rawState.market || {});
  renderNews(state.news, state.countries);
  renderDistribution(state.countries);
  renderRiskChart(state.countries);
  renderPredictions(rawState.predictions || {});
  renderInsights(state.insights);
  renderMarketQuotes(rawState.market || {});
  renderImpact(state.impact || { items: [] });
  renderCharts(rawState, state);
  hotspotMap.render(state.hotspots, state.news);
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
  try {
    latestAnalytics = await api.getMarketAnalytics({
      countries: selectedCountryQueryValue()
    });
  } catch (error) {
    console.error("Failed to refresh analytics:", error);
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

function renderApiLimits(payload = { providers: [] }) {
  const providers = payload.providers || [];
  elements.apiLimitsUpdated.textContent = `Updated: ${formatDate(payload.generatedAt)}`;

  if (!providers.length) {
    elements.apiLimitsBody.innerHTML =
      '<tr><td colspan="7" class="text-light-emphasis">No API limits data available.</td></tr>';
    return;
  }

  elements.apiLimitsBody.innerHTML = providers
    .map((provider) => {
      const statusClass = provider.exhausted ? "text-danger" : "text-light-emphasis";
      const remaining = Number.isFinite(provider.effectiveRemaining) ? provider.effectiveRemaining : "--";
      return `
        <tr>
          <td>${escapeHtml(provider.provider)}</td>
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
    const data = await api.getApiLimits();
    renderApiLimits(data);
  } catch (error) {
    console.error("Failed to load API limits:", error);
  }
}

function startPolling() {
  clearInterval(apiLimitsPoller);
  clearInterval(analyticsPoller);

  apiLimitsPoller = setInterval(() => {
    refreshApiLimits();
  }, 60_000);

  analyticsPoller = setInterval(() => {
    refreshAnalytics();
  }, 30_000);
}

async function bootstrap() {
  cacheElements();
  hotspotMap = new HotspotMap("hotspot-map");
  hotspotMap.init();
  initRiskChart();
  initImpactTimelineChart();
  initSectorBreakdownChart();
  initImpactScatterChart();

  elements.countryFilterBar.addEventListener("click", handleFilterClick);
  elements.toggleApiLimits.addEventListener("click", () => {
    toggleApiLimitsPanel();
    refreshApiLimits();
  });

  subscribe((state) => {
    syncWatchlistFromState(state);
    renderCountryFilters();
    renderDashboard(state);
  });

  setWsStatus("connecting");

  try {
    const snapshot = await api.getSnapshot({ countries: selectedCountryQueryValue(), limit: 100 });
    setSnapshot(snapshot);
    await refreshAnalytics();
    await refreshApiLimits();
  } catch (error) {
    console.error("Failed to fetch initial snapshot:", error);
    elements.newsFeed.innerHTML =
      '<div class="p-3 small text-danger">Failed to load initial intelligence snapshot.</div>';
  }

  mountWebSocket();
  startPolling();

  window.addEventListener("beforeunload", () => {
    socket?.close();
    clearInterval(apiLimitsPoller);
    clearInterval(analyticsPoller);
    clearTimeout(analyticsRefreshTimer);
  });
}

document.addEventListener("DOMContentLoaded", bootstrap);
