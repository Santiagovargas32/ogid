const LEVEL_COLORS = {
  Critical: "#ff4d4f",
  Elevated: "#ff8c42",
  Monitoring: "#f4c542",
  Stable: "#38c172"
};

const EVENT_COLOR = "#49d6c5";
const WATCHLIST_COLOR = "#6fb1ff";
const HEAT_ZOOM_THRESHOLD = 3;
const CARTO_DARK_MATTER_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const CARTO_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO";

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
    this.countryIndex = new Map();
    this.eventPoints = [];
    this.lastFitSignature = null;
    this.legendElement = null;
    this.resizeObserver = null;
    this.handleResize = () => {
      this.map?.invalidateSize?.(false);
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
    this.eventLayer = L.layerGroup().addTo(this.map);
    this.hotspotLayer = L.layerGroup().addTo(this.map);

    this.ensureLegend();
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
    this.resizeObserver?.disconnect?.();
    this.resizeObserver = null;
    this.map?.remove?.();
    this.map = null;
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

  renderLegend() {
    if (!this.legendElement) {
      return;
    }

    this.legendElement.innerHTML = `
      <div class="map-legend-heading">Operational Layers</div>
      <div class="map-legend-items">
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

  renderHotspots(hotspots = [], watchlist = []) {
    if (!this.hotspotLayer || !this.watchlistLayer) {
      return;
    }

    this.hotspotLayer.clearLayers();
    this.watchlistLayer.clearLayers();
    const watchlistSet = new Set((watchlist || []).map((iso2) => String(iso2 || "").toUpperCase()));

    for (const hotspot of hotspots || []) {
      if (!Number.isFinite(Number(hotspot?.lat)) || !Number.isFinite(Number(hotspot?.lng))) {
        continue;
      }

      const lat = Number(hotspot.lat);
      const lng = Number(hotspot.lng);
      const color = getLevelColor(hotspot.level);
      const radius = Math.min(18, Math.max(6, 6 + numericValue(hotspot.score) / 14));
      const iso2 = String(hotspot.iso2 || "").toUpperCase();

      if (watchlistSet.has(iso2)) {
        L.circleMarker([lat, lng], {
          radius: radius + 8,
          color: WATCHLIST_COLOR,
          fillColor: WATCHLIST_COLOR,
          fillOpacity: 0.05,
          opacity: 0.9,
          weight: 2,
          className: "map-watchlist-halo"
        }).addTo(this.watchlistLayer);
      }

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
      const watchlistFlag = watchlistSet.has(iso2) ? "Yes" : "No";

      marker.bindPopup(`
        <div class="small">
          <strong>${escapeHtml(hotspot.country || iso2 || "Unknown")}</strong><br/>
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

  fitToVisibleData(hotspots = []) {
    if (!this.map) {
      return;
    }

    const coordinates = [
      ...(hotspots || [])
        .filter((hotspot) => Number.isFinite(Number(hotspot?.lat)) && Number.isFinite(Number(hotspot?.lng)))
        .map((hotspot) => [Number(hotspot.lat), Number(hotspot.lng)]),
      ...this.eventPoints.slice(0, 80).map((event) => [event.baseLat, event.baseLng])
    ];

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

  render(hotspots = [], news = [], watchlist = []) {
    if (!this.map) {
      return;
    }

    this.buildCountryIndex(hotspots);
    this.renderHotspots(hotspots, watchlist);
    this.eventPoints = this.buildEventPoints(news);
    this.renderEventLayer();
    this.fitToVisibleData(hotspots);
  }
}
