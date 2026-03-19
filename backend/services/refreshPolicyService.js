const BAND_PRIORITY = {
  GREEN: 0,
  YELLOW: 1,
  RED: 2,
  CRITICAL: 3
};

export const QUOTA_BANDS = Object.freeze({
  GREEN: "GREEN",
  YELLOW: "YELLOW",
  RED: "RED",
  CRITICAL: "CRITICAL"
});

function toFinite(value) {
  return Number.isFinite(value) ? value : null;
}

function toRatio(remaining, limit) {
  const safeRemaining = toFinite(remaining);
  const safeLimit = toFinite(limit);
  if (!Number.isFinite(safeRemaining) || !Number.isFinite(safeLimit) || safeLimit <= 0) {
    return null;
  }

  return Math.max(0, Math.min(1, safeRemaining / safeLimit));
}

function resolveSnapshotRatios(snapshot = {}) {
  const dailyRatio = toRatio(
    snapshot.effectiveRemainingDay,
    toFinite(snapshot.configuredDailyLimit) ?? toFinite(snapshot.configuredLimit)
  );
  const minuteRatio = toRatio(
    snapshot.effectiveRemainingMinute,
    toFinite(snapshot.configuredMinuteLimit) ?? toFinite(snapshot.headerLimit)
  );

  return [dailyRatio, minuteRatio].filter(Number.isFinite);
}

export function resolveQuotaBandFromSnapshot(snapshot = {}) {
  if (snapshot?.exhausted || snapshot?.exhaustedDay || snapshot?.exhaustedMinute) {
    return QUOTA_BANDS.CRITICAL;
  }

  const ratios = resolveSnapshotRatios(snapshot);
  if (!ratios.length) {
    return QUOTA_BANDS.GREEN;
  }

  const ratio = Math.min(...ratios);
  if (ratio <= 0.05) {
    return QUOTA_BANDS.CRITICAL;
  }
  if (ratio <= 0.15) {
    return QUOTA_BANDS.RED;
  }
  if (ratio <= 0.4) {
    return QUOTA_BANDS.YELLOW;
  }
  return QUOTA_BANDS.GREEN;
}

export function minQuotaBand(bands = []) {
  if (!Array.isArray(bands) || !bands.length) {
    return QUOTA_BANDS.GREEN;
  }

  return bands.reduce((worst, current) => {
    const candidate = BAND_PRIORITY[current] ?? BAND_PRIORITY.GREEN;
    const baseline = BAND_PRIORITY[worst] ?? BAND_PRIORITY.GREEN;
    return candidate > baseline ? current : worst;
  }, QUOTA_BANDS.GREEN);
}

export function resolveBandByProviderSnapshots(snapshots = []) {
  if (!Array.isArray(snapshots) || !snapshots.length) {
    return QUOTA_BANDS.GREEN;
  }

  return minQuotaBand(snapshots.map((snapshot) => resolveQuotaBandFromSnapshot(snapshot)));
}

export function resolveNewsPolicy({
  providerSnapshots = [],
  intervalByBandMs = {},
  pageSizeByBand = {},
  fallbackIntervalMs = 30_000,
  fallbackPageSize = 50
} = {}) {
  const band = resolveBandByProviderSnapshots(providerSnapshots);
  const intervalMs = toFinite(intervalByBandMs[band]) ?? fallbackIntervalMs;
  const pageSize = toFinite(pageSizeByBand[band]) ?? fallbackPageSize;

  return {
    band,
    intervalMs: Math.max(5_000, Number(intervalMs)),
    pageSize: Math.max(10, Number(pageSize))
  };
}
