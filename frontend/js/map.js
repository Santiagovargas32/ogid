const LEVEL_COLORS = {
  Critical: "#ff4d4f",
  Elevated: "#ff8c42",
  Monitoring: "#f4c542",
  Stable: "#38c172"
};

const EVENT_COLOR = "#49d6c5";
const WATCHLIST_COLOR = "#6fb1ff";
const STATIC_SEED_COLOR = "#8fd9ff";
const MOVING_SEED_COLOR = "#ff9c73";
const HEAT_ZOOM_THRESHOLD = 3;
const CARTO_DARK_MATTER_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const CARTO_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO";

const SEED_STYLE_REGISTRY = Object.freeze({
  military_bases: Object.freeze({ primary: "#8f9bb0", accent: "#ff6e6e", glow: "rgba(255, 110, 110, 0.35)", shape: "hex" }),
  datacenters: Object.freeze({ primary: "#71d5ff", accent: "#b7f2ff", glow: "rgba(113, 213, 255, 0.34)", shape: "square" }),
  strategic_ports: Object.freeze({ primary: "#49d6c5", accent: "#d9fff7", glow: "rgba(73, 214, 197, 0.3)", shape: "openRing" }),
  airports: Object.freeze({ primary: "#86bbff", accent: "#edf6ff", glow: "rgba(134, 187, 255, 0.28)", shape: "diamond" }),
  refineries: Object.freeze({ primary: "#ffb36b", accent: "#5c2d11", glow: "rgba(255, 179, 107, 0.34)", shape: "hexPulse" }),
  power_plants: Object.freeze({ primary: "#b4f06c", accent: "#f7ffe2", glow: "rgba(180, 240, 108, 0.34)", shape: "power" }),
  substations: Object.freeze({ primary: "#f4c542", accent: "#fff9d9", glow: "rgba(244, 197, 66, 0.32)", shape: "gridSquare" }),
  critical_minerals: Object.freeze({ primary: "#d98b4d", accent: "#ffe2c9", glow: "rgba(217, 139, 77, 0.32)", shape: "triangle" }),
  shipping_chokepoints: Object.freeze({ primary: "#ffbf7d", accent: "#fff2df", glow: "rgba(255, 191, 125, 0.3)", shape: "hourglass" }),
  air_defense: Object.freeze({ primary: "#9bd06e", accent: "#f2ffe5", glow: "rgba(155, 208, 110, 0.3)", shape: "shield" }),
  strategic_chokepoints: Object.freeze({ primary: "#df96d7", accent: "#ffe6fb", glow: "rgba(223, 150, 215, 0.28)", shape: "bracket" }),
  ports_congestion: Object.freeze({ primary: "#ff8d4a", accent: "#fff0e1", glow: "rgba(255, 141, 74, 0.34)", shape: "doubleRing" }),
  space_launch_sites: Object.freeze({ primary: "#c59aff", accent: "#f6ecff", glow: "rgba(197, 154, 255, 0.32)", shape: "orbitalSite" }),
  naval_vessels: Object.freeze({ primary: "#ff8f78", accent: "#fff0ea", glow: "rgba(255, 143, 120, 0.34)", shape: "chevron" }),
  aircraft_adsb: Object.freeze({ primary: "#9fd8ff", accent: "#ffffff", glow: "rgba(159, 216, 255, 0.34)", shape: "aircraft" }),
  space_orbital_passes: Object.freeze({ primary: "#c59aff", accent: "#f7f0ff", glow: "rgba(197, 154, 255, 0.32)", shape: "orbitalPass" })
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(value) {
  if (!value) {
    return "--";
  }
  return new Date(value).toLocaleString();
}

function stableHash(value = "") {
  let hash = 0;
  const normalized = String(value || "");
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash << 5) - hash + normalized.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function stableOffset(seed, scale = 0.06) {
  const hash = stableHash(seed);
  return ((hash % 9) - 4) * scale;
}

function currentViewContainsBounds(map, bounds) {
  if (!map || !bounds?.isValid?.()) {
    return false;
  }

  const view = map.getBounds();
  return view.contains(bounds.getNorthEast()) && view.contains(bounds.getSouthWest());
}

function numericValue(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function humanizeStatus(status = "seeded") {
  if (status === "country-inferred") {
    return "Country inferred";
  }
  if (status === "confirmed") {
    return "Confirmed";
  }
  return "Seeded";
}

function seedStyleForAsset(asset = {}) {
  return SEED_STYLE_REGISTRY[asset.styleKey] || {
    primary: asset.assetType === "moving" ? MOVING_SEED_COLOR : STATIC_SEED_COLOR,
    accent: "#eef7ff",
    glow: asset.assetType === "moving" ? "rgba(255, 156, 115, 0.34)" : "rgba(143, 217, 255, 0.3)",
    shape: asset.assetType === "moving" ? "chevron" : "openRing"
  };
}

function renderSeedSvg(style = {}, asset = {}) {
  const primary = escapeHtml(style.primary || STATIC_SEED_COLOR);
  const accent = escapeHtml(style.accent || "#eef7ff");

  if (style.shape === "hex") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <polygon points="14,2 24,8 24,20 14,26 4,20 4,8" fill="${primary}" fill-opacity="0.24" stroke="${primary}" stroke-width="1.8"></polygon>
        <circle cx="14" cy="14" r="3.1" fill="${accent}"></circle>
      </svg>
    `;
  }

  if (style.shape === "square") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <rect x="4.5" y="4.5" width="19" height="19" rx="3" fill="${primary}" fill-opacity="0.16" stroke="${primary}" stroke-width="1.7"></rect>
        <rect x="8.3" y="8.3" width="11.4" height="11.4" rx="2" fill="none" stroke="${accent}" stroke-width="1.35"></rect>
      </svg>
    `;
  }

  if (style.shape === "openRing") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r="8.2" fill="none" stroke="${primary}" stroke-width="2.2" stroke-dasharray="34 11" stroke-linecap="round"></circle>
        <circle cx="22" cy="10" r="2.15" fill="${accent}"></circle>
      </svg>
    `;
  }

  if (style.shape === "diamond") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <polygon points="14,3 25,14 14,25 3,14" fill="${primary}" fill-opacity="0.18" stroke="${primary}" stroke-width="1.8"></polygon>
        <line x1="9" y1="18.5" x2="19" y2="8.5" stroke="${accent}" stroke-width="1.7" stroke-linecap="round"></line>
      </svg>
    `;
  }

  if (style.shape === "hexPulse") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <polygon points="14,2.5 23,8 23,20 14,25.5 5,20 5,8" fill="${primary}" fill-opacity="0.2" stroke="${primary}" stroke-width="1.8"></polygon>
        <circle cx="14" cy="14" r="4" fill="${accent}" fill-opacity="0.78"></circle>
        <circle cx="14" cy="14" r="7" fill="none" stroke="${primary}" stroke-width="1.2" stroke-opacity="0.7"></circle>
      </svg>
    `;
  }

  if (style.shape === "power") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r="9" fill="${primary}" fill-opacity="0.18" stroke="${primary}" stroke-width="1.8"></circle>
        <polyline points="14,7 10.5,14 14.2,14 12.6,21 18,12.8 14.1,12.8" fill="${accent}" stroke="${accent}" stroke-width="1.1" stroke-linejoin="round"></polyline>
      </svg>
    `;
  }

  if (style.shape === "gridSquare") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <rect x="5" y="5" width="18" height="18" rx="2.4" fill="${primary}" fill-opacity="0.18" stroke="${primary}" stroke-width="1.8"></rect>
        <line x1="10" y1="7.8" x2="10" y2="20.2" stroke="${accent}" stroke-width="1.2"></line>
        <line x1="18" y1="7.8" x2="18" y2="20.2" stroke="${accent}" stroke-width="1.2"></line>
        <line x1="7.8" y1="10" x2="20.2" y2="10" stroke="${accent}" stroke-width="1.2"></line>
        <line x1="7.8" y1="18" x2="20.2" y2="18" stroke="${accent}" stroke-width="1.2"></line>
      </svg>
    `;
  }

  if (style.shape === "triangle") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <polygon points="14,4 24,23 4,23" fill="${primary}" fill-opacity="0.22" stroke="${primary}" stroke-width="1.8"></polygon>
        <line x1="14" y1="9" x2="14" y2="17.8" stroke="${accent}" stroke-width="1.5" stroke-linecap="round"></line>
        <circle cx="14" cy="20.3" r="1.25" fill="${accent}"></circle>
      </svg>
    `;
  }

  if (style.shape === "hourglass") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M7 5 H21 M7 23 H21 M8.5 6.5 C9.6 9.8 12.1 11.5 14 14 C15.9 16.5 18.4 18.2 19.5 21.5 M19.5 6.5 C18.4 9.8 15.9 11.5 14 14 C12.1 16.5 9.6 18.2 8.5 21.5" fill="none" stroke="${primary}" stroke-width="1.8" stroke-linecap="round"></path>
        <circle cx="14" cy="14" r="1.9" fill="${accent}"></circle>
      </svg>
    `;
  }

  if (style.shape === "shield") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M14 3.5 L23 7 V13.3 C23 19 18.8 22.9 14 24.6 C9.2 22.9 5 19 5 13.3 V7 Z" fill="${primary}" fill-opacity="0.2" stroke="${primary}" stroke-width="1.8"></path>
        <circle cx="14" cy="13" r="3.3" fill="none" stroke="${accent}" stroke-width="1.4"></circle>
      </svg>
    `;
  }

  if (style.shape === "bracket") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M9 7 H6 V21 H9 M19 7 H22 V21 H19" fill="none" stroke="${primary}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>
        <circle cx="14" cy="14" r="3.2" fill="${accent}"></circle>
      </svg>
    `;
  }

  if (style.shape === "doubleRing") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r="8.3" fill="none" stroke="${primary}" stroke-width="1.8"></circle>
        <circle cx="14" cy="14" r="5.2" fill="none" stroke="${accent}" stroke-width="1.4"></circle>
        <circle cx="21.3" cy="9.2" r="1.65" fill="${primary}"></circle>
      </svg>
    `;
  }

  if (style.shape === "orbitalSite") {
    return `
      <svg class="seed-marker-svg" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r="3.1" fill="${accent}"></circle>
        <ellipse cx="14" cy="14" rx="9" ry="5.3" fill="none" stroke="${primary}" stroke-width="1.6"></ellipse>
        <ellipse cx="14" cy="14" rx="5.3" ry="9" fill="none" stroke="${primary}" stroke-opacity="0.65" stroke-width="1.2"></ellipse>
      </svg>
    `;
  }

  if (style.shape === "chevron") {
    return `
      <svg class="seed-marker-svg seed-marker-svg-rotating" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M6 15 L15.5 7 L21.8 14 L15.5 21 Z" fill="${primary}" fill-opacity="0.9" stroke="${primary}" stroke-width="1.4"></path>
        <path d="M4.2 12.2 L8.7 14 M3.5 15.5 L8.4 16.9" fill="none" stroke="${accent}" stroke-width="1.25" stroke-linecap="round"></path>
      </svg>
    `;
  }

  if (style.shape === "aircraft") {
    return `
      <svg class="seed-marker-svg seed-marker-svg-rotating" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M14 4 L16.7 12.4 L23.6 14 L16.7 15.6 L14 24 L11.3 15.6 L4.4 14 L11.3 12.4 Z" fill="${primary}" fill-opacity="0.82" stroke="${primary}" stroke-width="1.2"></path>
        <circle cx="14" cy="14" r="8.5" fill="none" stroke="${accent}" stroke-opacity="0.55" stroke-width="1.2"></circle>
      </svg>
    `;
  }

  return `
    <svg class="seed-marker-svg seed-marker-svg-rotating" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="3.1" fill="${accent}"></circle>
      <path d="M6 15 Q14 3 22 12" fill="none" stroke="${primary}" stroke-width="1.8" stroke-linecap="round"></path>
      <path d="M8 19 Q14 14 22 16" fill="none" stroke="${primary}" stroke-opacity="0.72" stroke-width="1.2" stroke-linecap="round"></path>
    </svg>
  `;
}

function buildSeedIcon(asset = {}) {
  const style = seedStyleForAsset(asset);
  const confidence = Math.max(0.26, Math.min(0.92, Number(asset.confidence || 0.35)));
  const rotation = Number.isFinite(Number(asset.heading)) ? Number(asset.heading) : 0;
  const html = `
    <div
      class="seed-marker-shell seed-marker-shell-${escapeHtml(asset.assetType || "static")} seed-status-${escapeHtml(asset.status || "seeded")}"
      style="--seed-primary:${escapeHtml(style.primary)};--seed-accent:${escapeHtml(style.accent)};--seed-glow:${escapeHtml(
        style.glow
      )};--seed-confidence:${confidence};--seed-rotation:${rotation}deg;"
    >
      ${renderSeedSvg(style, asset)}
    </div>
  `;

  return L.divIcon({
    className: `seed-marker seed-marker-${asset.assetType || "static"}`,
    html,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14]
  });
}

function buildSeedPopup(asset = {}) {
  const signalHeadline = asset.headline ? `<div>Latest: ${escapeHtml(asset.headline)}</div>` : "";
  const evidenceSummary = (asset.evidenceSummary || []).length
    ? `<div>Signals: ${escapeHtml(asset.evidenceSummary.join(" | "))}</div>`
    : "";
  const positionMode = asset.assetType === "moving" ? `<div>Position mode: ${escapeHtml(asset.positionMode || "synthetic")}</div>` : "";

  return `
    <div class="small">
      <strong>${escapeHtml(asset.title || "Seed asset")}</strong><br/>
      Layer: ${escapeHtml(asset.layerLabel || asset.layerId || "seed")}<br/>
      Country: ${escapeHtml(asset.country || "--")}<br/>
      Status: <strong>${escapeHtml(humanizeStatus(asset.status))}</strong><br/>
      Confidence: ${Math.round(numericValue(asset.confidence, 0) * 100)}%<br/>
      Activity: ${numericValue(asset.activityScore)}<br/>
      Linked signals: ${numericValue(asset.linkedArticleCount)}<br/>
      Last evidence: ${formatTimestamp(asset.lastEvidenceAt)}<br/>
      ${positionMode}
      ${signalHeadline}
      ${evidenceSummary}
    </div>
  `;
}

export function getLevelColor(level = "Stable") {
  return LEVEL_COLORS[level] || LEVEL_COLORS.Stable;
}

export class HotspotMap {
  constructor(elementId) {
    this.elementId = elementId;
    this.map = null;
    this.baseLayer = null;
    this.hotspotLayer = null;
    this.eventLayer = null;
    this.watchlistLayer = null;
    this.seedStaticLayer = null;
    this.seedMovingLayer = null;
    this.countryIndex = new Map();
    this.eventPoints = [];
    this.lastFitSignature = null;
    this.legendElement = null;
    this.controlsElement = null;
    this.resizeObserver = null;
    this.visibility = {
      hotspots: true,
      newsSignals: true,
      watchlist: true
    };
    this.lastContext = {
      hotspots: [],
      news: [],
      watchlist: [],
      mapAssets: {
        staticPoints: [],
        movingSeeds: []
      }
    };
    this.handleResize = () => {
      this.map?.invalidateSize?.(false);
    };
    this.handleControlsClick = (event) => {
      const trigger = event.target.closest("[data-map-toggle]");
      if (!trigger) {
        return;
      }

      const key = trigger.dataset.mapToggle;
      if (!Object.prototype.hasOwnProperty.call(this.visibility, key)) {
        return;
      }

      this.visibility[key] = !this.visibility[key];
      this.renderControls();
      this.rerender();
    };
  }

  init() {
    const mapContainer = document.getElementById(this.elementId);
    if (!mapContainer) {
      return;
    }

    const panel = mapContainer.closest(".panel");
    panel?.querySelector(".map-toolbar-shell")?.remove();
    panel?.querySelector(".map-mobile-sheet")?.remove();

    this.map = L.map(this.elementId, {
      zoomControl: true,
      minZoom: 2,
      maxZoom: 9,
      worldCopyJump: true,
      zoomSnap: 0.5
    }).setView([20, 5], 2);

    this.baseLayer = L.tileLayer(CARTO_DARK_MATTER_URL, {
      maxZoom: 9,
      minZoom: 2,
      subdomains: "abcd",
      attribution: CARTO_ATTRIBUTION
    }).addTo(this.map);

    this.watchlistLayer = L.layerGroup().addTo(this.map);
    this.seedStaticLayer = L.layerGroup().addTo(this.map);
    this.seedMovingLayer = L.layerGroup().addTo(this.map);
    this.eventLayer = L.layerGroup().addTo(this.map);
    this.hotspotLayer = L.layerGroup().addTo(this.map);

    this.ensureControls();
    this.ensureLegend();
    this.renderControls();
    this.renderLegend();

    this.map.on("zoomend", () => {
      this.renderEventLayer();
    });

    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => {
        this.map?.invalidateSize?.(false);
      });
      this.resizeObserver.observe(mapContainer);
    }

    window.addEventListener("resize", this.handleResize);
    window.setTimeout(() => this.map?.invalidateSize?.(false), 80);
  }

  destroy() {
    window.removeEventListener("resize", this.handleResize);
    this.controlsElement?.removeEventListener("click", this.handleControlsClick);
    this.resizeObserver?.disconnect?.();
    this.resizeObserver = null;
    this.map?.remove?.();
    this.map = null;
  }

  ensureControls() {
    const mapContainer = document.getElementById(this.elementId);
    if (!mapContainer) {
      return;
    }

    let controls = mapContainer.querySelector(".map-overlay-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "map-overlay-controls";
      controls.addEventListener("click", this.handleControlsClick);
      mapContainer.appendChild(controls);
    }

    this.controlsElement = controls;
  }

  ensureLegend() {
    const mapContainer = document.getElementById(this.elementId);
    if (!mapContainer) {
      return;
    }

    let legend = mapContainer.querySelector(".map-legend-floating");
    if (!legend) {
      legend = document.createElement("div");
      legend.className = "map-legend map-legend-floating";
      mapContainer.appendChild(legend);
    }

    this.legendElement = legend;
  }

  renderControls() {
    if (!this.controlsElement) {
      return;
    }

    const toggleButton = (key, label) => `
      <button
        type="button"
        class="map-overlay-chip ${this.visibility[key] ? "active" : "muted"}"
        data-map-toggle="${key}"
      >
        ${escapeHtml(label)}
      </button>
    `;

    this.controlsElement.innerHTML = `
      <div class="map-overlay-heading">Overlays</div>
      <div class="map-overlay-chip-row">
        <span class="map-overlay-chip always-on">Static Seeds</span>
        <span class="map-overlay-chip always-on">Moving Seeds</span>
        ${toggleButton("hotspots", "Hotspots")}
        ${toggleButton("newsSignals", "News Signals")}
        ${toggleButton("watchlist", "Watchlist")}
      </div>
    `;
  }

  renderLegend() {
    if (!this.legendElement) {
      return;
    }

    this.legendElement.innerHTML = `
      <div class="map-legend-heading">Operational Layers</div>
      <div class="map-legend-items">
        <span class="map-legend-pill">
          <span class="map-legend-swatch" style="background:${STATIC_SEED_COLOR}"></span>
          <span>Static Seeds</span>
        </span>
        <span class="map-legend-pill">
          <span class="map-legend-swatch" style="background:${MOVING_SEED_COLOR}"></span>
          <span>Moving Seeds</span>
        </span>
        <span class="map-legend-pill">
          <span class="map-legend-swatch" style="background:${LEVEL_COLORS.Critical}"></span>
          <span>Hotspots</span>
        </span>
        <span class="map-legend-pill">
          <span class="map-legend-swatch" style="background:${EVENT_COLOR}"></span>
          <span>News Signals</span>
        </span>
        <span class="map-legend-pill">
          <span class="map-legend-swatch" style="background:${WATCHLIST_COLOR}"></span>
          <span>Watchlist</span>
        </span>
      </div>
    `;
  }

  buildCountryIndex(hotspots = []) {
    this.countryIndex = new Map(
      (hotspots || [])
        .filter((hotspot) => Number.isFinite(Number(hotspot?.lat)) && Number.isFinite(Number(hotspot?.lng)))
        .map((hotspot) => [
          String(hotspot.iso2 || "").toUpperCase(),
          {
            lat: Number(hotspot.lat),
            lng: Number(hotspot.lng),
            country: hotspot.country || hotspot.iso2 || "Unknown"
          }
        ])
    );
  }

  renderWatchlist(hotspots = [], watchlist = []) {
    if (!this.watchlistLayer) {
      return;
    }

    this.watchlistLayer.clearLayers();
    if (!this.visibility.watchlist) {
      return;
    }

    const watchlistSet = new Set((watchlist || []).map((iso2) => String(iso2 || "").toUpperCase()));

    for (const hotspot of hotspots || []) {
      if (!watchlistSet.has(String(hotspot.iso2 || "").toUpperCase())) {
        continue;
      }
      if (!Number.isFinite(Number(hotspot?.lat)) || !Number.isFinite(Number(hotspot?.lng))) {
        continue;
      }

      const radius = Math.min(22, Math.max(13, 10 + numericValue(hotspot.score) / 18));
      L.circleMarker([Number(hotspot.lat), Number(hotspot.lng)], {
        radius,
        color: WATCHLIST_COLOR,
        fillColor: WATCHLIST_COLOR,
        fillOpacity: 0.05,
        opacity: 0.9,
        weight: 2,
        className: "map-watchlist-halo"
      }).addTo(this.watchlistLayer);
    }
  }

  renderHotspots(hotspots = [], watchlist = []) {
    if (!this.hotspotLayer) {
      return;
    }

    this.hotspotLayer.clearLayers();
    if (!this.visibility.hotspots) {
      return;
    }

    const watchlistSet = new Set((watchlist || []).map((iso2) => String(iso2 || "").toUpperCase()));

    for (const hotspot of hotspots || []) {
      if (!Number.isFinite(Number(hotspot?.lat)) || !Number.isFinite(Number(hotspot?.lng))) {
        continue;
      }

      const lat = Number(hotspot.lat);
      const lng = Number(hotspot.lng);
      const color = getLevelColor(hotspot.level);
      const radius = Math.min(18, Math.max(6, 6 + numericValue(hotspot.score) / 14));
      const watchlistFlag = watchlistSet.has(String(hotspot.iso2 || "").toUpperCase()) ? "Yes" : "No";
      const marker = L.circleMarker([lat, lng], {
        radius,
        color,
        fillColor: color,
        fillOpacity: 0.72,
        opacity: 0.98,
        weight: 1.2
      });

      const tags = hotspot.topTags?.length
        ? hotspot.topTags.map((tag) => `${escapeHtml(tag.tag)} (${numericValue(tag.count)})`).join(", ")
        : "none";

      marker.bindPopup(`
        <div class="small">
          <strong>${escapeHtml(hotspot.country || hotspot.iso2 || "Unknown")}</strong><br/>
          Level: <strong>${escapeHtml(hotspot.level || "Stable")}</strong><br/>
          Score: <strong>${numericValue(hotspot.score).toFixed(1)}</strong><br/>
          News volume: ${numericValue(hotspot.metrics?.newsVolume)}<br/>
          Negative sentiment: ${numericValue(hotspot.metrics?.negativeSentiment)}<br/>
          Conflict weight: ${numericValue(hotspot.metrics?.conflictTagWeight)}<br/>
          Watchlist: ${watchlistFlag}<br/>
          Top tags: ${tags}<br/>
          Updated: ${formatTimestamp(hotspot.updatedAt)}
        </div>
      `);

      marker.addTo(this.hotspotLayer);
    }
  }

  buildEventPoints(news = []) {
    const eventPoints = [];

    for (const article of news || []) {
      const mentions = Array.isArray(article.countryMentions) ? article.countryMentions : [];
      if (!mentions.length) {
        continue;
      }

      const conflictWeight = numericValue(article.conflict?.totalWeight);
      const negative = String(article.sentiment?.label || "").toLowerCase() === "negative" ? 2 : 0;
      const intensity = Math.min(1, (conflictWeight + negative) / 10);

      if (intensity <= 0.05) {
        continue;
      }

      for (const iso2Raw of mentions) {
        const iso2 = String(iso2Raw || "").toUpperCase();
        const country = this.countryIndex.get(iso2);
        if (!country) {
          continue;
        }

        const seed = `${article.id || article.title || "event"}:${iso2}`;
        eventPoints.push({
          lat: country.lat + stableOffset(`${seed}:lat`, 0.07),
          lng: country.lng + stableOffset(`${seed}:lng`, 0.07),
          baseLat: country.lat,
          baseLng: country.lng,
          iso2,
          country: country.country,
          title: article.title,
          sourceName: article.sourceName,
          intensity,
          publishedAt: article.publishedAt
        });
      }
    }

    return eventPoints;
  }

  buildHeatBuckets() {
    const buckets = new Map();

    for (const point of this.eventPoints) {
      const key = point.iso2;
      const current = buckets.get(key) || {
        iso2: point.iso2,
        country: point.country,
        lat: point.baseLat,
        lng: point.baseLng,
        count: 0,
        intensity: 0,
        latestPublishedAt: point.publishedAt
      };
      current.count += 1;
      current.intensity += point.intensity;
      if (new Date(point.publishedAt || 0).getTime() > new Date(current.latestPublishedAt || 0).getTime()) {
        current.latestPublishedAt = point.publishedAt;
      }
      buckets.set(key, current);
    }

    return [...buckets.values()];
  }

  renderEventLayer() {
    if (!this.eventLayer || !this.map) {
      return;
    }

    this.eventLayer.clearLayers();
    if (!this.visibility.newsSignals) {
      return;
    }

    if ((this.map.getZoom() || 2) <= HEAT_ZOOM_THRESHOLD) {
      const buckets = this.buildHeatBuckets();
      for (const bucket of buckets) {
        const radius = Math.max(7, Math.min(24, 6 + bucket.count * 1.5 + bucket.intensity * 3.5));
        const marker = L.circleMarker([bucket.lat, bucket.lng], {
          radius,
          color: EVENT_COLOR,
          fillColor: EVENT_COLOR,
          fillOpacity: Math.min(0.66, 0.16 + bucket.intensity * 0.18),
          opacity: 0.92,
          weight: 1.2
        });

        marker.bindPopup(`
          <div class="small">
            <strong>News signal density</strong><br/>
            Country: <strong>${escapeHtml(bucket.country)}</strong><br/>
            Signals: ${bucket.count}<br/>
            Weighted intensity: ${bucket.intensity.toFixed(2)}<br/>
            Latest: ${formatTimestamp(bucket.latestPublishedAt)}
          </div>
        `);

        marker.addTo(this.eventLayer);
      }
      return;
    }

    for (const event of this.eventPoints.slice(0, 180)) {
      const radius = Math.max(3.5, 3.5 + event.intensity * 6.5);
      const marker = L.circleMarker([event.lat, event.lng], {
        radius,
        color: EVENT_COLOR,
        fillColor: EVENT_COLOR,
        fillOpacity: 0.18 + event.intensity * 0.52,
        opacity: 0.95,
        dashArray: "3 2",
        weight: 1
      });

      marker.bindPopup(`
        <div class="small">
          <strong>Active news signal</strong><br/>
          Country: <strong>${escapeHtml(event.country)}</strong><br/>
          Source: ${escapeHtml(event.sourceName || "Unknown")}<br/>
          Headline: ${escapeHtml(event.title || "N/A")}<br/>
          Published: ${formatTimestamp(event.publishedAt)}
        </div>
      `);

      marker.addTo(this.eventLayer);
    }
  }

  renderSeedAssets(layer, items = []) {
    if (!layer) {
      return;
    }

    layer.clearLayers();

    for (const asset of items || []) {
      if (!Number.isFinite(Number(asset?.lat)) || !Number.isFinite(Number(asset?.lng))) {
        continue;
      }

      const marker = L.marker([Number(asset.lat), Number(asset.lng)], {
        icon: buildSeedIcon(asset),
        keyboard: false
      });
      marker.bindPopup(buildSeedPopup(asset));
      marker.addTo(layer);
    }
  }

  renderSeedLayers(mapAssets = { staticPoints: [], movingSeeds: [] }) {
    this.renderSeedAssets(this.seedStaticLayer, mapAssets.staticPoints || []);
    this.renderSeedAssets(this.seedMovingLayer, mapAssets.movingSeeds || []);
  }

  fitToVisibleData(hotspots = [], mapAssets = {}) {
    if (!this.map) {
      return;
    }

    const hotspotCoordinates = (hotspots || [])
      .filter((hotspot) => Number.isFinite(Number(hotspot?.lat)) && Number.isFinite(Number(hotspot?.lng)))
      .map((hotspot) => [Number(hotspot.lat), Number(hotspot.lng)]);
    const eventCoordinates = this.eventPoints.slice(0, 80).map((event) => [event.baseLat, event.baseLng]);
    const fallbackSeedCoordinates = !hotspotCoordinates.length && !eventCoordinates.length
      ? [
          ...(mapAssets.movingSeeds || []).slice(0, 20).map((asset) => [Number(asset.lat), Number(asset.lng)]),
          ...(mapAssets.staticPoints || []).slice(0, 12).map((asset) => [Number(asset.lat), Number(asset.lng)])
        ]
      : [];
    const coordinates = [...hotspotCoordinates, ...eventCoordinates, ...fallbackSeedCoordinates];

    if (!coordinates.length) {
      return;
    }

    const bounds = L.latLngBounds(coordinates);
    if (!bounds.isValid()) {
      return;
    }

    const signature = `${coordinates.length}:${Math.round(bounds.getSouth() * 10)}:${Math.round(bounds.getWest() * 10)}:${Math.round(
      bounds.getNorth() * 10
    )}:${Math.round(bounds.getEast() * 10)}`;

    if (this.lastFitSignature === signature && currentViewContainsBounds(this.map, bounds)) {
      return;
    }

    if (!currentViewContainsBounds(this.map, bounds)) {
      this.map.fitBounds(bounds.pad(0.22), { maxZoom: 5, animate: false });
    }

    this.lastFitSignature = signature;
  }

  rerender() {
    const { hotspots, news, watchlist, mapAssets } = this.lastContext;
    this.renderWatchlist(hotspots, watchlist);
    this.renderSeedLayers(mapAssets);
    this.eventPoints = this.buildEventPoints(news);
    this.renderEventLayer();
    this.renderHotspots(hotspots, watchlist);
  }

  render(hotspots = [], news = [], watchlist = [], mapAssets = { staticPoints: [], movingSeeds: [] }) {
    if (!this.map) {
      return;
    }

    this.lastContext = {
      hotspots,
      news,
      watchlist,
      mapAssets: mapAssets || { staticPoints: [], movingSeeds: [] }
    };
    this.buildCountryIndex(hotspots);
    this.rerender();
    this.fitToVisibleData(hotspots, mapAssets || { staticPoints: [], movingSeeds: [] });
  }
}
