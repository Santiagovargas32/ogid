const LEVEL_COLORS = {
  Critical: "#ff4d4f",
  Elevated: "#ff8c42",
  Monitoring: "#f4c542",
  Stable: "#38c172"
};

const EVENT_COLOR = "#49d6c5";

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

export function getLevelColor(level = "Stable") {
  return LEVEL_COLORS[level] || LEVEL_COLORS.Stable;
}

export class HotspotMap {
  constructor(elementId) {
    this.elementId = elementId;
    this.map = null;
    this.hotspotLayer = null;
    this.eventLayer = null;
    this.countryIndex = new Map();
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
  }

  buildCountryIndex(hotspots = []) {
    this.countryIndex = new Map(
      hotspots.map((hotspot) => [
        hotspot.iso2,
        { lat: hotspot.lat, lng: hotspot.lng, country: hotspot.country }
      ])
    );
  }

  renderHotspots(hotspots = []) {
    if (!this.hotspotLayer) {
      return;
    }

    this.hotspotLayer.clearLayers();

    for (const hotspot of hotspots) {
      const color = getLevelColor(hotspot.level);
      const radius = Math.min(18, Math.max(6, 6 + hotspot.score / 10));

      const marker = L.circleMarker([hotspot.lat, hotspot.lng], {
        radius,
        color,
        fillColor: color,
        fillOpacity: 0.75,
        weight: 1.2
      });

      const tags = hotspot.topTags?.length
        ? hotspot.topTags.map((tag) => `${escapeHtml(tag.tag)} (${tag.count})`).join(", ")
        : "none";

      marker.bindPopup(`
        <div class="small">
          <strong>${escapeHtml(hotspot.country)}</strong><br/>
          Level: <strong>${escapeHtml(hotspot.level)}</strong><br/>
          Score: <strong>${hotspot.score}</strong><br/>
          News volume: ${hotspot.metrics?.newsVolume ?? 0}<br/>
          Negative sentiment: ${hotspot.metrics?.negativeSentiment ?? 0}<br/>
          Conflict weight: ${hotspot.metrics?.conflictTagWeight ?? 0}<br/>
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

        const jitter = ((article.id?.charCodeAt(0) || 10) % 7) * 0.08;
        eventPoints.push({
          lat: country.lat + jitter,
          lng: country.lng - jitter,
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

  renderEvents(news = []) {
    if (!this.eventLayer) {
      return;
    }

    this.eventLayer.clearLayers();
    const events = this.buildEventPoints(news).slice(0, 150);

    for (const event of events) {
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

  render(hotspots = [], news = []) {
    this.buildCountryIndex(hotspots);
    this.renderHotspots(hotspots);
    this.renderEvents(news);
  }
}
