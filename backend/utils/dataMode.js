export const DATA_MODES = Object.freeze({
  OBSERVED: "observed",
  DERIVED: "derived",
  SEEDED: "seeded",
  SYNTHETIC: "synthetic",
  STALE: "stale"
});

const ALIASES = Object.freeze({
  live: DATA_MODES.OBSERVED,
  "web-delayed": DATA_MODES.OBSERVED,
  "historical-eod": DATA_MODES.STALE,
  "router-stale": DATA_MODES.STALE,
  "synthetic-fallback": DATA_MODES.SYNTHETIC,
  fallback: DATA_MODES.SYNTHETIC
});

export function normalizeDataMode(value, fallback = DATA_MODES.DERIVED) {
  const normalized = String(value || "").trim().toLowerCase();
  if (Object.values(DATA_MODES).includes(normalized)) return normalized;
  return ALIASES[normalized] || fallback;
}
