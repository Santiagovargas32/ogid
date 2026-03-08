import { BaseMapEngine } from "./mapEngine.js";
import { SmartPollLoop } from "../smartPollLoop.js";
import { TileProviderManager } from "../mapTheme/tileProviderManager.js";

const CATEGORY_COLORS = Object.freeze({
  security: "#ff5d73",
  infrastructure: "#6fb1ff",
  society: "#f4c542",
  environment: "#55d79f",
  cyber: "#49d6c5",
  economics: "#ff8c42",
  space: "#b59aff",
  logistics: "#7bd3ff",
  humanitarian: "#ffd07d",
  energy: "#ff9b5d",
  political: "#d4b6ff",
  health: "#9fe28e",
  information: "#90d7ff"
});

const SEVERITY_COLORS = Object.freeze({
  critical: "#ff4d4f",
  elevated: "#ff8c42",
  monitoring: "#f4c542",
  low: "#38c172",
  stable: "#38c172"
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function boundsToBbox(bounds) {
  if (!bounds?.isValid?.()) {
    return "";
  }
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
    .map((value) => value.toFixed(4))
    .join(",");
}

function layerColor(layer = {}, properties = {}) {
  const severity = String(properties.severity || properties.level || "").toLowerCase();
  return SEVERITY_COLORS[severity] || CATEGORY_COLORS[layer.category] || "#49d6c5";
}

function featureLatLng(feature) {
  if (feature.geometry?.type !== "Point") {
    return null;
  }
  const [lng, lat] = feature.geometry.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return [lat, lng];
}

function clusterPointFeatures(features = [], zoom = 2) {
  const divisor = Math.max(2, 8 - Math.floor(zoom || 2));
  const grid = new Map();
  const pointFeatures = features.filter((feature) => feature.geometry?.type === "Point");

  for (const feature of pointFeatures) {
    const [lng, lat] = feature.geometry.coordinates;
    const key = `${Math.round(lat * divisor)}:${Math.round(lng * divisor)}`;
    const current = grid.get(key) || {
      feature,
      features: [],
      latSum: 0,
      lngSum: 0
    };
    current.features.push(feature);
    current.latSum += lat;
    current.lngSum += lng;
    grid.set(key, current);
  }

  return [...grid.values()].map((entry) => ({
    feature: entry.feature,
    count: entry.features.length,
    lat: entry.latSum / Math.max(1, entry.features.length),
    lng: entry.lngSum / Math.max(1, entry.features.length),
    features: entry.features
  }));
}

function featurePopup(feature = {}, layer = {}) {
  const properties = feature.properties || {};
  return `
    <div class="small">
      <strong>${escapeHtml(feature.title || layer.label || layer.id || "Intel layer")}</strong><br/>
      Layer: ${escapeHtml(layer.label || layer.id || "layer")}<br/>
      Severity: ${escapeHtml(String(properties.severity || properties.level || "monitoring"))}<br/>
      Source: ${escapeHtml(properties.source || "unknown")}<br/>
      ${properties.country ? `Country: ${escapeHtml(properties.country)}<br/>` : ""}
      ${feature.timestamp ? `Time: ${escapeHtml(new Date(feature.timestamp).toLocaleString())}<br/>` : ""}
      ${properties.url ? `<a href="${escapeHtml(properties.url)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ""}
    </div>
  `;
}

export class LeafletEngine extends BaseMapEngine {
  constructor(options = {}) {
    super(options);
    this.map = null;
    this.baseLayer = null;
    this.layerGroups = new Map();
    this.watchlistLayer = null;
    this.controlsElement = null;
    this.mobileSheet = null;
    this.stateUnsubscribe = null;
    this.themeUnsubscribe = null;
    this.tileProviderManager = new TileProviderManager();
    this.tileErrors = [];
    this.cachedBundle = null;
    this.pollLoop = null;
    this.legendElement = null;
    this.containerResizeObserver = null;
    this.invalidateSizeTimer = null;
    this.handleWindowResize = () => {
      this.scheduleInvalidateSize(40);
    };
  }

  init() {
    const preset = (this.stateStore.config?.presets || []).find((item) => item.id === this.stateStore.getState().preset);
    this.map = L.map(this.elementId, {
      zoomControl: true,
      minZoom: 2,
      maxZoom: 10,
      worldCopyJump: true,
      inertia: true,
      zoomSnap: 0.5
    }).setView(preset?.center || [20, 5], preset?.zoom || 2);

    this.watchlistLayer = L.layerGroup().addTo(this.map);
    this.mobileSheet = this.ensureMobileSheet();
    this.controlsElement = this.ensureControlsHost();
    this.legendElement = this.ensureLegend();

    this.applyBaseLayer(this.themeManager.getSelection());
    this.renderControls();
    this.renderLegend();
    this.observeMapContainer();
    this.scheduleInvalidateSize(80);

    this.stateUnsubscribe = this.stateStore.subscribe((state, previousState = {}) => {
      if (state.preset !== previousState.preset) {
        const nextPreset = (this.stateStore.config?.presets || []).find((item) => item.id === state.preset);
        if (nextPreset?.center) {
          this.map.setView(nextPreset.center, nextPreset.zoom || this.map.getZoom(), { animate: true });
        }
      }
      this.renderControls();
      this.scheduleInvalidateSize(40);
      this.scheduleRefresh(80);
    });

    this.themeUnsubscribe = this.themeManager.subscribe((selection) => {
      this.applyBaseLayer(selection);
      this.renderControls();
      this.renderLegend();
      this.scheduleInvalidateSize(40);
      this.renderFetchedLayers();
      this.renderWatchlist();
    });

    this.map.on("moveend zoomend", () => {
      this.renderFetchedLayers();
      this.renderWatchlist();
      this.scheduleRefresh(120);
    });

    this.pollLoop = new SmartPollLoop({
      task: () => this.fetchLayers(),
      onData: (bundle) => {
        this.cachedBundle = bundle;
        this.renderFetchedLayers();
      },
      onError: (error) => {
        console.error("Failed to load map intelligence layers:", error);
      },
      intervalMs: 45_000,
      hiddenIntervalMs: 120_000
    });
    this.pollLoop.start();
  }

  destroy() {
    this.pollLoop?.stop();
    this.stateUnsubscribe?.();
    this.themeUnsubscribe?.();
    this.containerResizeObserver?.disconnect?.();
    this.containerResizeObserver = null;
    window.removeEventListener("resize", this.handleWindowResize);
    clearTimeout(this.invalidateSizeTimer);
    this.invalidateSizeTimer = null;
    this.map?.remove();
  }

  renderContext(context = {}) {
    super.renderContext(context);
    this.renderWatchlist();
  }

  ensureControlsHost() {
    if (!this.controlsHost) {
      return null;
    }
    let element = this.controlsHost.querySelector(".map-engine-controls");
    if (!element) {
      element = document.createElement("div");
      element.className = "map-engine-controls";
      this.controlsHost.appendChild(element);
    }
    return element;
  }

  ensureMobileSheet() {
    const mapContainer = document.getElementById(this.elementId);
    if (!mapContainer?.parentElement) {
      return null;
    }
    let sheet = mapContainer.parentElement.querySelector(".map-mobile-sheet");
    if (!sheet) {
      sheet = document.createElement("div");
      sheet.className = "map-mobile-sheet";
      mapContainer.parentElement.appendChild(sheet);
    }
    return sheet;
  }

  ensureLegend() {
    const mapContainer = document.getElementById(this.elementId);
    if (!mapContainer) {
      return null;
    }

    let legend = mapContainer.querySelector(".map-legend-floating");
    if (!legend) {
      legend = document.createElement("div");
      legend.className = "map-legend map-legend-floating";
      mapContainer.appendChild(legend);
    }

    return legend;
  }

  observeMapContainer() {
    const mapContainer = document.getElementById(this.elementId);
    if (!mapContainer) {
      return;
    }

    window.addEventListener("resize", this.handleWindowResize);
    if (typeof window.ResizeObserver !== "function") {
      return;
    }

    this.containerResizeObserver = new window.ResizeObserver(() => {
      this.scheduleInvalidateSize(40);
    });
    this.containerResizeObserver.observe(mapContainer);
  }

  applyBaseLayer(selection) {
    if (!this.map) {
      return;
    }

    if (this.baseLayer) {
      this.baseLayer.off("tileerror");
      this.map.removeLayer(this.baseLayer);
    }

    this.tileErrors = [];
    this.baseLayer = this.tileProviderManager.createLeafletLayer(L, selection);
    this.baseLayer.on("tileerror", () => {
      const fallbackRules = this.stateStore.config?.themes?.rules?.fallback || {};
      const intervalMs = Number(fallbackRules.intervalMs || 10_000);
      const threshold = Number(fallbackRules.errorThreshold || 2);
      const now = Date.now();
      this.tileErrors = this.tileErrors.filter((timestamp) => now - timestamp <= intervalMs);
      this.tileErrors.push(now);

      if (this.tileErrors.length >= threshold && selection.provider === "PMTiles") {
        const fallback = this.themeManager.resolveFallback(selection);
        console.warn("Tile provider fallback activated");
        this.themeManager.setProvider(fallback.provider);
        this.themeManager.setTheme(fallback.theme);
      }
    });
    this.baseLayer.addTo(this.map);
  }

  scheduleRefresh(delayMs = 0) {
    this.pollLoop?.trigger(delayMs);
  }

  scheduleInvalidateSize(delayMs = 0) {
    clearTimeout(this.invalidateSizeTimer);
    this.invalidateSizeTimer = window.setTimeout(() => {
      this.map?.invalidateSize?.(false);
    }, Math.max(0, Number(delayMs || 0)));
  }

  async fetchLayers() {
    const state = this.stateStore.getState();
    return this.api.getMapLayers({
      layers: state.activeLayers.join(","),
      timeWindow: state.timeWindow,
      preset: state.preset,
      bbox: boundsToBbox(this.map?.getBounds?.()),
      limit: 360
    });
  }

  renderControls() {
    if (!this.controlsElement) {
      return;
    }

    const state = this.stateStore.getState();
    const selection = this.themeManager.getSelection();
    const overlayStyle = this.themeManager.getOverlayStyle(selection);
    const providers = this.themeManager.getProviders();
    const themes = this.themeManager.getThemesForProvider(selection.provider);
    const presets = this.stateStore.config?.presets || [];
    const timeWindows = this.stateStore.config?.timeWindows || [];
    const layers = this.stateStore.config?.layers || [];

    this.controlsElement.innerHTML = `
      <div class="map-command-group map-command-group-preset">
        <label class="map-toolbar-label" for="map-preset-select">Preset</label>
        <select class="form-select form-select-sm map-toolbar-select" id="map-preset-select" data-map-action="preset" aria-label="Map preset">
          ${presets
            .map(
              (preset) =>
                `<option value="${preset.id}" ${preset.id === state.preset ? "selected" : ""}>${preset.label}</option>`
            )
            .join("")}
        </select>
      </div>
      <div class="map-command-group map-command-group-time">
        <label class="map-toolbar-label" for="map-time-window-select">Time Window</label>
        <select class="form-select form-select-sm map-toolbar-select" id="map-time-window-select" data-map-action="time-window" aria-label="Intel time window">
          ${timeWindows
            .map(
              (timeWindow) =>
                `<option value="${timeWindow.id}" ${timeWindow.id === state.timeWindow ? "selected" : ""}>${timeWindow.label}</option>`
            )
            .join("")}
        </select>
      </div>
      <details class="map-command-group map-command-group-layers map-layer-panel">
        <summary>
          <span class="map-toolbar-label">Intel Layers</span>
          <span class="map-layer-summary-value">${state.activeLayers.length}</span>
        </summary>
        <div class="map-layer-grid">
          ${layers
            .map((layer) => {
              const active = state.activeLayers.includes(layer.id) ? "active" : "";
              const capability = String(layer.capability || "intel").toUpperCase();
              const marker = active ? "ON" : "OFF";
              return `
                <button
                  class="map-layer-chip ${active}"
                  type="button"
                  data-map-action="toggle-layer"
                  data-value="${layer.id}"
                  title="${escapeHtml(layer.capability || "intel")}"
                  aria-pressed="${active ? "true" : "false"}"
                >
                  <span class="map-layer-chip-state" aria-hidden="true">${marker}</span>
                  <span class="map-layer-chip-copy">
                    <strong>${escapeHtml(layer.label)}</strong>
                    <small>${escapeHtml(capability)}</small>
                  </span>
                </button>
              `;
            })
            .join("")}
        </div>
      </details>
      <div class="map-command-group map-command-group-theme">
        <label class="map-toolbar-label" for="map-provider-select">Basemap</label>
        <div class="map-command-inline">
          <select class="form-select form-select-sm map-toolbar-select" id="map-provider-select" data-map-action="provider" aria-label="Basemap provider">
            ${providers
              .map(
                (provider) =>
                  `<option value="${provider.id}" ${provider.id === selection.provider ? "selected" : ""}>${provider.label}</option>`
              )
              .join("")}
          </select>
          <select class="form-select form-select-sm map-toolbar-select" data-map-action="theme" aria-label="Basemap theme">
            ${themes
              .map(
                (theme) =>
                  `<option value="${theme.id}" ${theme.id === selection.theme ? "selected" : ""}>${theme.id}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="map-toolbar-meta">Overlay opacity ${Math.round(overlayStyle.markerOpacity * 100)}%</div>
      </div>
      <div class="map-command-group map-command-group-gps">
        <label class="map-toolbar-label">Locate</label>
        <button class="map-toolbar-button" type="button" data-map-action="gps" aria-label="Center map on current position">GPS</button>
      </div>
    `;

    this.controlsElement.querySelectorAll("[data-map-action]").forEach((node) => {
      node.addEventListener("click", (event) => this.handleControlEvent(event));
      node.addEventListener("change", (event) => this.handleControlEvent(event));
    });
  }

  handleControlEvent(event) {
    const action = event.currentTarget?.dataset?.mapAction;
    const value = event.currentTarget?.dataset?.value || event.currentTarget?.value;

    if (action === "preset") {
      this.stateStore.applyPreset(value);
      return;
    }
    if (action === "provider") {
      this.themeManager.setProvider(value);
      return;
    }
    if (action === "theme") {
      this.themeManager.setTheme(value);
      return;
    }
    if (action === "time-window") {
      this.stateStore.setTimeWindow(value);
      return;
    }
    if (action === "toggle-layer") {
      this.stateStore.toggleLayer(value);
      return;
    }
    if (action === "gps") {
      this.centerOnGps();
    }
  }

  centerOnGps() {
    if (!navigator.geolocation || !this.map) {
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        this.map.setView([position.coords.latitude, position.coords.longitude], 6, { animate: true });
      },
      () => {},
      {
        enableHighAccuracy: true,
        maximumAge: 60_000,
        timeout: 8_000
      }
    );
  }

  renderLegend() {
    if (!this.legendElement) {
      return;
    }

    const items = [
      { label: "High Alert", color: SEVERITY_COLORS.critical },
      { label: "Elevated", color: SEVERITY_COLORS.elevated },
      { label: "Monitoring", color: SEVERITY_COLORS.monitoring },
      { label: "Watchlist", color: "#4ab4ff" },
      { label: "Live Signals", color: CATEGORY_COLORS.cyber }
    ];

    this.legendElement.innerHTML = `
      <div class="map-legend-heading">Legend</div>
      <div class="map-legend-items">
        ${items
          .map(
            (item) => `
              <span class="map-legend-pill">
                <span class="map-legend-swatch" style="background:${escapeHtml(item.color)}"></span>
                <span>${escapeHtml(item.label)}</span>
              </span>
            `
          )
          .join("")}
      </div>
    `;
  }

  ensureLayerGroup(layerId) {
    if (this.layerGroups.has(layerId)) {
      return this.layerGroups.get(layerId);
    }
    const group = L.layerGroup().addTo(this.map);
    this.layerGroups.set(layerId, group);
    return group;
  }

  showMobileSheet(html) {
    if (!this.mobileSheet || window.innerWidth > 768) {
      return;
    }
    this.mobileSheet.innerHTML = `
      <button class="map-mobile-sheet-close" type="button">Close</button>
      ${html}
    `;
    this.mobileSheet.classList.add("visible");
    this.mobileSheet.querySelector(".map-mobile-sheet-close")?.addEventListener("click", () => {
      this.mobileSheet.classList.remove("visible");
    });
  }

  renderPointFeatures(layer, features = [], overlayStyle) {
    const group = this.ensureLayerGroup(layer.id);
    const zoom = this.map.getZoom() || 2;
    const bounds = this.map.getBounds();
    const visibleFeatures = features.filter((feature) => {
      const latLng = featureLatLng(feature);
      return latLng ? bounds.contains(latLng) : false;
    });

    if (layer.clusterable && zoom <= 3) {
      const clusters = clusterPointFeatures(visibleFeatures, zoom);
      clusters.forEach((cluster) => {
        const color = layerColor(layer, cluster.feature.properties || {});
        const marker = L.circleMarker([cluster.lat, cluster.lng], {
          radius: Math.min(20, 6 + cluster.count * 1.15),
          color,
          fillColor: color,
          fillOpacity: Math.min(0.94, overlayStyle.markerOpacity + 0.08),
          opacity: 0.97,
          weight: 1.2
        });
        const popup = `<div class="small"><strong>${escapeHtml(layer.label)}</strong><br/>Cluster size: ${cluster.count}</div>`;
        marker.bindPopup(popup);
        marker.on("click", () => this.showMobileSheet(popup));
        marker.addTo(group);
      });
      return;
    }

    visibleFeatures.forEach((feature) => {
      const latLng = featureLatLng(feature);
      if (!latLng) {
        return;
      }
      const color = layerColor(layer, feature.properties || {});
      const marker = L.circleMarker(latLng, {
        radius: Math.max(3.2, Math.min(12, 4 + Number(feature.properties?.credibilityScore || 0.55) * 4.8)),
        color,
        fillColor: color,
        fillOpacity: Math.min(0.92, overlayStyle.markerOpacity + 0.06),
        opacity: 0.96,
        weight: 1.1
      });
      const popup = featurePopup(feature, layer);
      marker.bindPopup(popup);
      marker.on("click", () => this.showMobileSheet(popup));
      marker.addTo(group);
    });
  }

  renderLineFeatures(layer, features = [], overlayStyle) {
    const group = this.ensureLayerGroup(layer.id);
    features.forEach((feature) => {
      if (feature.geometry?.type !== "LineString") {
        return;
      }
      const color = layerColor(layer, feature.properties || {});
      const coordinates = (feature.geometry.coordinates || []).map(([lng, lat]) => [lat, lng]);
      const line = L.polyline(coordinates, {
        color,
        opacity: overlayStyle.lineOpacity,
        weight: 2.8,
        dashArray: "5 4"
      });
      const popup = featurePopup(feature, layer);
      line.bindPopup(popup);
      line.on("click", () => this.showMobileSheet(popup));
      line.addTo(group);
    });
  }

  renderFetchedLayers() {
    if (!this.cachedBundle?.layers?.length || !this.map) {
      return;
    }

    const overlayStyle = this.themeManager.getOverlayStyle(this.themeManager.getSelection());
    const activeIds = new Set(this.stateStore.getState().activeLayers);

    for (const [layerId, group] of this.layerGroups.entries()) {
      if (!activeIds.has(layerId)) {
        group.clearLayers();
      }
    }

    for (const layer of this.cachedBundle.layers) {
      if (!activeIds.has(layer.id)) {
        continue;
      }
      this.ensureLayerGroup(layer.id).clearLayers();
      const lineFeatures = (layer.features || []).filter((feature) => feature.geometry?.type === "LineString");
      const pointFeatures = (layer.features || []).filter((feature) => feature.geometry?.type === "Point");
      this.renderLineFeatures(layer, lineFeatures, overlayStyle);
      this.renderPointFeatures(layer, pointFeatures, overlayStyle);
    }
  }

  renderWatchlist() {
    if (!this.watchlistLayer || !this.map) {
      return;
    }

    const selection = this.themeManager.getSelection();
    const overlayStyle = this.themeManager.getOverlayStyle(selection);
    const watchlistSet = new Set((this.latestContext.watchlist || []).map((iso2) => String(iso2 || "").toUpperCase()));

    this.watchlistLayer.clearLayers();
    (this.latestContext.hotspots || []).forEach((hotspot) => {
      if (!watchlistSet.has(String(hotspot.iso2 || "").toUpperCase())) {
        return;
      }
      L.circleMarker([hotspot.lat, hotspot.lng], {
        radius: Math.max(14, 10 + Number(hotspot.score || 0) / 18),
        color: "#6fb1ff",
        fillColor: "#6fb1ff",
        fillOpacity: overlayStyle.haloOpacity,
        opacity: 0.95,
        weight: 2,
        className: "map-watchlist-halo"
      }).addTo(this.watchlistLayer);
    });
  }
}
