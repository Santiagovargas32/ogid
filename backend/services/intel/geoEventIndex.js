function toFinite(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

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

export function buildGeoEventIndex(events = [], { gridSize = 1, windowHours = 24 } = {}) {
  const thresholdMs = Date.now() - Math.max(1, windowHours) * 60 * 60 * 1_000;
  const cells = new Map();

  for (const event of events) {
    const timestampMs = new Date(event.timestamp || 0).getTime();
    const location = normalizeLocation(event);
    if (!Number.isFinite(timestampMs) || timestampMs < thresholdMs || !location) {
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
      eventCount: 0,
      latestTimestamp: event.timestamp,
      severitySum: 0
    };

    current.eventCount += 1;
    current.severitySum += Number(event.severity || 0);
    current.eventTypes.add(event.event_type || "unknown");
    if (event.country) {
      current.countries.add(event.country);
    }
    if (new Date(event.timestamp || 0).getTime() > new Date(current.latestTimestamp || 0).getTime()) {
      current.latestTimestamp = event.timestamp;
    }
    cells.set(key, current);
  }

  return [...cells.values()].map((cell) => ({
    ...cell,
    countries: [...cell.countries],
    eventTypes: [...cell.eventTypes],
    geoConvergence: Math.min(
      100,
      Math.round(cell.eventTypes.size * 18 + cell.eventCount * 6 + cell.severitySum / Math.max(1, cell.eventCount))
    )
  }));
}

export function detectGeoConvergence(events = [], options = {}) {
  return buildGeoEventIndex(events, options)
    .filter((cell) => cell.eventTypes.length >= 3)
    .sort((left, right) => {
      if (right.geoConvergence !== left.geoConvergence) {
        return right.geoConvergence - left.geoConvergence;
      }
      return right.eventCount - left.eventCount;
    });
}
