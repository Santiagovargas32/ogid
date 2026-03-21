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
  const dailyRemaining = toFinite(snapshot.effectiveRemainingDay) ?? toFinite(snapshot.effectiveRemaining);
  const minuteRemaining = toFinite(snapshot.effectiveRemainingMinute);
  const dailyRatio = toRatio(
    dailyRemaining,
    toFinite(snapshot.operationalDailyLimit) ??
      toFinite(snapshot.budgetDailyLimit) ??
      toFinite(snapshot.configuredDailyLimit) ??
      toFinite(snapshot.configuredLimit)
  );
  const minuteLimit =
    toFinite(snapshot.operationalMinuteLimit) ??
    toFinite(snapshot.budgetMinuteLimit) ??
    toFinite(snapshot.configuredMinuteLimit);
  const minuteRatio = Number.isFinite(minuteLimit) ? toRatio(minuteRemaining, minuteLimit) : null;

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
  fallbackIntervalMs = null,
  fallbackPageSize = null
} = {}) {
  const band = resolveBandByProviderSnapshots(providerSnapshots);
  const intervalMs = toFinite(intervalByBandMs[band]) ?? fallbackIntervalMs;
  const pageSize = toFinite(pageSizeByBand[band]) ?? fallbackPageSize;

  return {
    band,
    intervalMs: Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0 ? Number(intervalMs) : null,
    pageSize: Number.isFinite(Number(pageSize)) && Number(pageSize) > 0 ? Number(pageSize) : null
  };
}
