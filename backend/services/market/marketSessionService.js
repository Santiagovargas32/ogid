import { createLogger } from "../../utils/logger.js";

const log = createLogger("backend/services/market/marketSessionService");
const NY_TZ = "America/New_York";
const BAND_PRIORITY = {
  GREEN: 0,
  YELLOW: 1,
  RED: 2,
  CRITICAL: 3
};

function parseTimeParts(date = new Date(), timeZone = NY_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: map.weekday,
    hour: Number.parseInt(map.hour, 10),
    minute: Number.parseInt(map.minute, 10)
  };
}

function isWeekday(weekday) {
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
}

function minutesFromMidnight(hour, minute) {
  return hour * 60 + minute;
}

function isWithinSession(minutes) {
  const openMin = 9 * 60 + 30;
  const closeMin = 16 * 60;
  return minutes >= openMin && minutes <= closeMin;
}

export function isMarketOpenEt(date = new Date()) {
  const parts = parseTimeParts(date, NY_TZ);
  if (!isWeekday(parts.weekday)) {
    return false;
  }
  return isWithinSession(minutesFromMidnight(parts.hour, parts.minute));
}

export function resolveMarketIntervalMs({
  now = new Date(),
  activeIntervalMs = 120_000,
  offHoursIntervalMs = 600_000,
  quotaRemaining = null,
  quotaBand = "GREEN",
  bandIntervals = {}
} = {}) {
  const open = isMarketOpenEt(now);
  let intervalMs = open ? activeIntervalMs : offHoursIntervalMs;

  const normalizedBand = String(quotaBand || "GREEN").toUpperCase();
  const fromBand = bandIntervals?.[normalizedBand];
  if (fromBand) {
    const mapped = open ? fromBand.activeIntervalMs : fromBand.offHoursIntervalMs;
    if (Number.isFinite(mapped) && mapped > 0) {
      intervalMs = mapped;
    }
  }

  if (Number.isFinite(quotaRemaining)) {
    if (BAND_PRIORITY[normalizedBand] <= BAND_PRIORITY.GREEN && quotaRemaining <= 25) {
      intervalMs = Math.max(intervalMs, 10 * 60_000);
    } else if (BAND_PRIORITY[normalizedBand] <= BAND_PRIORITY.GREEN && quotaRemaining <= 75) {
      intervalMs = Math.max(intervalMs, 5 * 60_000);
    }
  }

  log.debug("market_interval_resolved", {
    open,
    intervalMs,
    quotaRemaining: Number.isFinite(quotaRemaining) ? quotaRemaining : null
  });

  return intervalMs;
}
