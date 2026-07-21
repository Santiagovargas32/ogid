import { SmartPollLoop } from "../smartPollLoop.js";
import { buildEscalationHotspotsHtml } from "./escalationHotspots.js";
import { buildCountryInstabilityHtml } from "./riskEngine.js";
import { buildSignalAnomaliesHtml } from "./signalAnomalies.js";
import { buildNewsSeverityHtml } from "./threatClassifier.js";
import { buildFrequentTermsHtml } from "./trendDetector.js";
import { buildWorldBriefHtml } from "./worldBrief.js";

const DEFAULT_ROOT_IDS = Object.freeze({
  worldBrief: "world-brief-body",
  countryInstability: "strategic-risk-body",
  severity: "threat-classifier-body",
  frequentTerms: "trend-detector-body",
  hotspots: "escalation-hotspots-body",
  anomalies: "signal-anomalies-body",
  meta: "advanced-intel-meta",
  panel: "panel-advanced-intel"
});

const SECTION_BUILDERS = Object.freeze({
  worldBrief: buildWorldBriefHtml,
  countryInstability: buildCountryInstabilityHtml,
  severity: buildNewsSeverityHtml,
  frequentTerms: buildFrequentTermsHtml,
  hotspots: buildEscalationHotspotsHtml,
  anomalies: buildSignalAnomaliesHtml
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatGeneratedAt(value) {
  if (!value) {
    return "--";
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime())
    ? timestamp.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "--";
}

function qualityMode(value) {
  const mode = String(value || "fallback").toLowerCase();
  return ["live", "mixed", "fallback"].includes(mode) ? mode : "fallback";
}

function countryParam(value) {
  if (Array.isArray(value)) {
    return value.map((iso2) => String(iso2 || "").trim().toUpperCase()).filter(Boolean).join(",");
  }
  return String(value || "").trim();
}

export function buildAdvancedMetaHtml(payload = {}) {
  const corpus = payload.corpus || {};
  const quality = payload.quality || {};
  const methodologyVersion = payload.methodology?.version || "--";
  const mode = qualityMode(quality.mode);
  const provider = [quality.provider || "unknown", quality.pipelineMode].filter(Boolean).join(" / ");
  const providerDetails = (quality.providers || [])
    .map((item) => `${item.role || "source"}: ${item.provider || "unknown"} (${item.mode || "unknown"}, n=${Number(item.sampleSize || 0)})`)
    .join(" | ");
  const qualityTitle = [quality.reason, providerDetails].filter(Boolean).join(" | ");
  const eventCount = Number(corpus.eventCount || 0);
  const eventTotal = Number(corpus.availableEventCount || eventCount);
  const eventLabel = corpus.truncated ? `${eventCount}/${eventTotal} events` : `${eventCount} events`;

  return `
    <span class="intel-meta-item">Generated ${escapeHtml(formatGeneratedAt(payload.generatedAt))}</span>
    <span class="intel-meta-item">Window ${escapeHtml(payload.window?.label || "--")}</span>
    <span class="intel-meta-item">Corpus ${Number(corpus.uniqueArticles || 0)} unique / ${Number(corpus.windowedArticles || 0)} windowed / ${Number(corpus.inputArticles || 0)} input</span>
    <span class="intel-meta-item">${escapeHtml(eventLabel)}</span>
    <span class="intel-meta-item intel-quality intel-quality-${mode}" title="${escapeHtml(qualityTitle)}">${escapeHtml(provider)} &middot; ${escapeHtml(mode)} (${escapeHtml(quality.modeScope || "quality")})</span>
    <span class="intel-meta-item">Method ${escapeHtml(methodologyVersion)}</span>
  `;
}

function setPanelQuality(panel, mode) {
  if (!panel) {
    return;
  }
  panel.classList.remove("panel-fallback", "panel-mixed");
  if (mode === "fallback") {
    panel.classList.add("panel-fallback");
  } else if (mode === "mixed") {
    panel.classList.add("panel-mixed");
  }
  panel.dataset.advancedQuality = mode;
}

export function startAdvancedIntelligence({
  api,
  getCountries = () => "",
  rootIds = {},
  intervalMs = 90_000,
  hiddenIntervalMs = 180_000
} = {}) {
  const ids = { ...DEFAULT_ROOT_IDS, ...rootIds };
  const roots = Object.fromEntries(Object.keys(SECTION_BUILDERS).map((key) => [key, document.getElementById(ids[key])]));
  const metaRoot = document.getElementById(ids.meta);
  const panel = document.getElementById(ids.panel);
  let stopped = false;
  let requestInFlight = false;
  let pendingRefresh = false;
  let requestToken = 0;
  let lastSnapshot = null;
  let lastSnapshotContext = "";

  const currentCountries = () => countryParam(typeof getCountries === "function" ? getCountries() : "");

  function renderSnapshot(payload, context) {
    const renderedSections = Object.fromEntries(
      Object.entries(SECTION_BUILDERS).map(([key, builder]) => [key, builder(payload)])
    );
    const renderedMeta = buildAdvancedMetaHtml(payload);
    for (const [key, html] of Object.entries(renderedSections)) {
      if (roots[key]) roots[key].innerHTML = html;
    }
    if (metaRoot) {
      metaRoot.className = "intel-panel-meta";
      metaRoot.innerHTML = renderedMeta;
    }
    lastSnapshot = payload;
    lastSnapshotContext = context;
    setPanelQuality(panel, qualityMode(payload.quality?.mode));
    if (panel) panel.dataset.advancedRefresh = "ok";
  }

  function renderFailure(error, requestedContext) {
    const message = escapeHtml(error?.message || "Advanced intelligence snapshot unavailable.");
    if (lastSnapshot) {
      if (metaRoot) {
        const scopeNote = lastSnapshotContext !== requestedContext
          ? ` Snapshot scope ${escapeHtml(lastSnapshotContext || "default")}; requested ${escapeHtml(requestedContext || "default")}.`
          : "";
        metaRoot.className = "intel-panel-meta intel-panel-meta-error";
        metaRoot.innerHTML = `<span class="intel-refresh-error">Refresh failed: ${message}. Showing snapshot generated ${escapeHtml(
          formatGeneratedAt(lastSnapshot.generatedAt)
        )}.${scopeNote}</span>${buildAdvancedMetaHtml(lastSnapshot)}`;
      }
      setPanelQuality(panel, qualityMode(lastSnapshot.quality?.mode));
      if (panel) panel.dataset.advancedRefresh = "error";
      return;
    }
    for (const root of Object.values(roots)) {
      if (root) {
        root.innerHTML = '<div class="small text-warning">Advanced intelligence snapshot unavailable.</div>';
      }
    }
    if (metaRoot) {
      metaRoot.className = "intel-panel-meta intel-panel-meta-error";
      metaRoot.textContent = `Advanced snapshot unavailable: ${error?.message || "request failed"}`;
    }
    setPanelQuality(panel, "fallback");
    if (panel) panel.dataset.advancedRefresh = "error";
  }

  async function loadSnapshot() {
    if (stopped) {
      return null;
    }
    if (requestInFlight) {
      pendingRefresh = true;
      return null;
    }

    requestInFlight = true;
    const token = ++requestToken;
    const countries = currentCountries();
    try {
      const payload = await api.getAdvancedIntelligenceSnapshot({ countries });
      if (stopped || token !== requestToken) {
        return null;
      }
      if (countries !== currentCountries()) {
        pendingRefresh = true;
        return null;
      }
      renderSnapshot(payload || {}, countries);
      return payload;
    } catch (error) {
      if (!stopped && token === requestToken && countries === currentCountries()) {
        renderFailure(error, countries);
      }
      return null;
    } finally {
      requestInFlight = false;
      if (!stopped && pendingRefresh) {
        pendingRefresh = false;
        queueMicrotask(() => {
          void loadSnapshot();
        });
      }
    }
  }

  const loop = new SmartPollLoop({
    intervalMs,
    hiddenIntervalMs,
    task: loadSnapshot
  });

  if (metaRoot) {
    metaRoot.className = "intel-panel-meta";
    metaRoot.textContent = "Loading advanced intelligence snapshot...";
  }
  loop.start();

  return {
    refresh() {
      if (stopped) {
        return Promise.resolve(null);
      }
      if (requestInFlight) {
        requestToken += 1;
        pendingRefresh = true;
        return Promise.resolve(null);
      }
      loop.trigger(loop.getDelayMs());
      return loadSnapshot();
    },
    stop() {
      stopped = true;
      pendingRefresh = false;
      requestToken += 1;
      loop.stop();
    }
  };
}
