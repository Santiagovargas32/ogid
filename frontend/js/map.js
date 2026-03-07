const LEVEL_COLORS = {
  Critical: "#ff4d4f",
  Elevated: "#ff8c42",
  Monitoring: "#f4c542",
  Stable: "#38c172"
};

const EVENT_COLOR = "#49d6c5";
const WATCHLIST_COLOR = "#6fb1ff";
const HEAT_ZOOM_THRESHOLD = 3;

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

export function getLevelColor(level = "Stable") {
  return LEVEL_COLORS[level] || LEVEL_COLORS.Stable;
}

export class HotspotMap {
  constructor(elementId) {
    this.elementId = elementId;
    this.map = null;
    this.hotspotLayer = null;
    this.eventLayer = null;
    this.watchlistLayer = null;
    this.countryIndex = new Map();
    this.eventPoints = [];
    this.lastFitSignature = null;
    this.layerControl = null;
    this.legendControl = null;
  }

  init() {
    this.map = L.map(this.elementId, {
      zoomControl: true,
      minZoom: 2
    }).setView([20, 5], 2);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 8,
      minZoom: 2,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(this.map);

    this.hotspotLayer = L.layerGroup().addTo(this.map);
    this.eventLayer = L.layerGroup().addTo(this.map);
    this.watchlistLayer = L.layerGroup().addTo(this.map);

    this.layerControl = L.control.layers(
      null,
      {
        Hotspots: this.hotspotLayer,
        "Event Signals": this.eventLayer,
        Watchlist: this.watchlistLayer
      },
      { collapsed: false }
    ).addTo(this.map);

    this.legendControl = L.control({ position: "bottomright" });
    this.legendControl.onAdd = () => {
      const element = L.DomUtil.create("div", "map-legend");
      element.innerHTML = `
        <h3>Map Layers</h3>
        <div class="map-legend-row"><span class="map-legend-swatch" style="background:${LEVEL_COLORS.Critical}"></span><span>Critical hotspot</span></div>
        <div class="map-legend-row"><span class="map-legend-swatch" style="background:${LEVEL_COLORS.Elevated}"></span><span>Elevated hotspot</span></div>
        <div class="map-legend-row"><span class="map-legend-swatch" style="background:${EVENT_COLOR}"></span><span>Event signal / density</span></div>
        <div class="map-legend-row"><span class="map-legend-swatch" style="background:${WATCHLIST_COLOR}"></span><span>Watchlist halo</span></div>
      `;
      return element;
    };
    this.legendControl.addTo(this.map);

    this.map.on("zoomend", () => {
      this.renderEventLayer();
    });
    this.map.on("overlayadd", (event) => {
      if (event.layer === this.eventLayer) {
        this.renderEventLayer();
      }
    });
  }

  buildCountryIndex(hotspots = []) {
    this.countryIndex = new Map(
      hotspots.map((hotspot) => [
        hotspot.iso2,
        { lat: hotspot.lat, lng: hotspot.lng, country: hotspot.country }
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

    for (const hotspot of hotspots) {
      const color = getLevelColor(hotspot.level);
      const radius = Math.min(20, Math.max(7, 7 + hotspot.score / 12));

      if (watchlistSet.has(String(hotspot.iso2 || "").toUpperCase())) {
        L.circleMarker([hotspot.lat, hotspot.lng], {
          radius: radius + 8,
          color: WATCHLIST_COLOR,
          fillColor: WATCHLIST_COLOR,
          fillOpacity: 0.05,
          opacity: 0.95,
          weight: 2,
          className: "map-watchlist-halo"
        }).addTo(this.watchlistLayer);
      }

      const marker = L.circleMarker([hotspot.lat, hotspot.lng], {
        radius,
        color,
        fillColor: color,
        fillOpacity: 0.75,
        weight: 1.4
      });

      const tags = hotspot.topTags?.length
        ? hotspot.topTags.map((tag) => `${escapeHtml(tag.tag)} (${tag.count})`).join(", ")
        : "none";
      const watchlistFlag = watchlistSet.has(String(hotspot.iso2 || "").toUpperCase()) ? "Yes" : "No";

      marker.bindPopup(`
        <div class="small">
          <strong>${escapeHtml(hotspot.country)}</strong><br/>
          Level: <strong>${escapeHtml(hotspot.level)}</strong><br/>
          Score: <strong>${hotspot.score}</strong><br/>
          News volume: ${hotspot.metrics?.newsVolume ?? 0}<br/>
          Negative sentiment: ${hotspot.metrics?.negativeSentiment ?? 0}<br/>
          Conflict weight: ${hotspot.metrics?.conflictTagWeight ?? 0}<br/>
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

    for (const article of news) {
      const mentions = article.countryMentions || [];
      if (!mentions.length) {
        continue;
      }

      const conflictWeight = article.conflict?.totalWeight ?? 0;
      const negative = article.sentiment?.label === "negative" ? 2 : 0;
      const intensity = Math.min(1, (conflictWeight + negative) / 10);

      if (intensity <= 0.05) {
        continue;
      }

      for (const iso2 of mentions) {
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
    if (!this.map.hasLayer(this.eventLayer)) {
      return;
    }

    if ((this.map.getZoom() || 2) <= HEAT_ZOOM_THRESHOLD) {
      const buckets = this.buildHeatBuckets();
      for (const bucket of buckets) {
        const radius = Math.max(8, Math.min(26, 6 + bucket.count * 1.6 + bucket.intensity * 4));
        const marker = L.circleMarker([bucket.lat, bucket.lng], {
          radius,
          color: EVENT_COLOR,
          fillColor: EVENT_COLOR,
          fillOpacity: Math.min(0.72, 0.18 + bucket.intensity * 0.18),
          weight: 1.4
        });

        marker.bindPopup(`
          <div class="small">
            <strong>Event density</strong><br/>
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
      const radius = Math.max(4, 4 + event.intensity * 8);
      const marker = L.circleMarker([event.lat, event.lng], {
        radius,
        color: EVENT_COLOR,
        fillColor: EVENT_COLOR,
        fillOpacity: 0.18 + event.intensity * 0.55,
        dashArray: "3 2",
        weight: 1
      });

      marker.bindPopup(`
        <div class="small">
          <strong>Active event signal</strong><br/>
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
      ...hotspots.map((hotspot) => [hotspot.lat, hotspot.lng]),
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
    this.buildCountryIndex(hotspots);
    this.renderHotspots(hotspots, watchlist);
    this.eventPoints = this.buildEventPoints(news);
    this.renderEventLayer();
    this.fitToVisibleData(hotspots);
  }
}
