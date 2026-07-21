function toFinite(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

export const GEO_CONVERGENCE_METHODOLOGY = Object.freeze({
  version: "country-signal-convergence-v2",
  normalization: "100*(1-exp(-log1p(value)/log1p(reference)))",
  semantics: "country-centroid signal convergence; not subnational geolocation",
  minimumEventTypes: 3,
  minimumArticles: 2,
  weights: Object.freeze({ diversity: 0.35, activity: 0.35, averageSeverity: 0.3 }),
  references: Object.freeze({ diversity: 5, activityPerHour: 1 })
});

function normalizeLocation(event = {}) {
  const lat = toFinite(event.location?.lat);
  const lng = toFinite(event.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { lat, lng };
}

function cellId(lat, lng, gridSize = 1) {
  const latBucket = Math.floor(lat / gridSize) * gridSize;
  const lngBucket = Math.floor(lng / gridSize) * gridSize;
  return `${latBucket}:${lngBucket}:${gridSize}`;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function normalizeLog(value, reference) {
  const numeric = Math.max(0, Number(value || 0));
  const ceiling = Math.max(0.0001, Number(reference || 1));
  return clamp(100 * (1 - Math.exp(-Math.log1p(numeric) / Math.log1p(ceiling))));
}

export function buildGeoEventIndex(events = [], { gridSize = 1, windowHours = 24, now = Date.now() } = {}) {
  const resolvedWindowHours = Math.max(1, Number(windowHours || 24));
  const thresholdMs = Number(now) - resolvedWindowHours * 60 * 60 * 1_000;
  const cells = new Map();

  for (const event of events) {
    const timestampMs = new Date(event.timestamp || 0).getTime();
    const location = normalizeLocation(event);
    if (!Number.isFinite(timestampMs) || timestampMs < thresholdMs || timestampMs > Number(now) + 5 * 60 * 1_000 || !location) {
      continue;
    }

    const key = cellId(location.lat, location.lng, gridSize);
    const current = cells.get(key) || {
      cellId: key,
      bounds: {
        south: Math.floor(location.lat / gridSize) * gridSize,
        west: Math.floor(location.lng / gridSize) * gridSize,
        north: Math.floor(location.lat / gridSize) * gridSize + gridSize,
        east: Math.floor(location.lng / gridSize) * gridSize + gridSize
      },
      center: {
        lat: Math.floor(location.lat / gridSize) * gridSize + gridSize / 2,
        lng: Math.floor(location.lng / gridSize) * gridSize + gridSize / 2
      },
      countries: new Set(),
      eventTypes: new Set(),
      articleIds: new Set(),
      articleSeverity: new Map(),
      eventCount: 0,
      latestTimestamp: event.timestamp
    };

    current.eventCount += 1;
    current.eventTypes.add(event.event_type || "unknown");
    const articleId = event.metadata?.articleId || event.id || "unknown";
    current.articleIds.add(articleId);
    current.articleSeverity.set(articleId, Math.max(
      Number(current.articleSeverity.get(articleId) || 0),
      Number(event.severity || 0)
    ));
    if (event.country) {
      current.countries.add(event.country);
    }
    if (new Date(event.timestamp || 0).getTime() > new Date(current.latestTimestamp || 0).getTime()) {
      current.latestTimestamp = event.timestamp;
    }
    cells.set(key, current);
  }

  return [...cells.values()].map((cell) => {
    const diversity = normalizeLog(
      Math.max(0, cell.eventTypes.size - 1),
      GEO_CONVERGENCE_METHODOLOGY.references.diversity
    );
    const activityRatePerHour = cell.eventCount / resolvedWindowHours;
    const activity = normalizeLog(activityRatePerHour, GEO_CONVERGENCE_METHODOLOGY.references.activityPerHour);
    const averageSeverity = clamp(
      [...cell.articleSeverity.values()].reduce((sum, value) => sum + Number(value || 0), 0) /
      Math.max(1, cell.articleSeverity.size)
    );
    const weights = GEO_CONVERGENCE_METHODOLOGY.weights;
    const geoConvergence = clamp(
      diversity * weights.diversity + activity * weights.activity + averageSeverity * weights.averageSeverity
    );
    const { articleIds, articleSeverity, ...serializableCell } = cell;
    return {
      ...serializableCell,
      countries: [...cell.countries],
      eventTypes: [...cell.eventTypes],
      articleCount: articleIds.size,
      geoConvergence: Number(geoConvergence.toFixed(2)),
      components: {
        diversity: Number(diversity.toFixed(2)),
        activity: Number(activity.toFixed(2)),
        averageSeverity: Number(averageSeverity.toFixed(2)),
        activityRatePerHour: Number(activityRatePerHour.toFixed(3))
      }
    };
  });
}

export function detectGeoConvergence(events = [], options = {}) {
  return buildGeoEventIndex(events, options)
    .filter((cell) =>
      cell.eventTypes.length >= GEO_CONVERGENCE_METHODOLOGY.minimumEventTypes &&
      cell.articleCount >= GEO_CONVERGENCE_METHODOLOGY.minimumArticles
    )
    .sort((left, right) => {
      if (right.geoConvergence !== left.geoConvergence) {
        return right.geoConvergence - left.geoConvergence;
      }
      return right.eventCount - left.eventCount;
    });
}
