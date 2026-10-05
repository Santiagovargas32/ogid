// Ingestion time is not an event date. Missing values must never reach Date.parse(0).
function instant(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sourceEventTiming(events = [], nowMs = Date.now()) {
  let latest = null;
  let latestPublished = null;
  let basis = null;
  for (const event of events) {
    const published = instant(event.publishedAt);
    const scheduled = instant(event.scheduledAt);
    const timestamp = published ?? scheduled;
    if (timestamp !== null && (latest === null || timestamp > latest)) {
      latest = timestamp;
      basis = published !== null ? "publishedAt" : "scheduledAt";
    }
    if (published !== null && (latestPublished === null || published > latestPublished)) latestPublished = published;
  }
  return {
    latestEventAt: latest === null ? null : new Date(latest).toISOString(),
    latestEventTimeKind: basis,
    lagMs: latestPublished === null ? null : Math.max(0, nowMs - latestPublished)
  };
}
