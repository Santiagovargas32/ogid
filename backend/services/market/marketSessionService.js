import { cashCalendarSchedule } from "./exchangeCalendar.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("backend/services/market/marketSessionService");
const NY_TZ = "America/New_York";
export function isMarketOpenEt(date = new Date()) {
  return isExchangeSessionOpen(date, NY_TZ);
}

export function isExchangeSessionOpen(date = new Date(), timeZone = NY_TZ) {
  const zone=timeZone||NY_TZ;
  const mic=({"America/New_York":"XNYS","Europe/Berlin":"XETR","Europe/Amsterdam":"XAMS","Europe/Rome":"XMIL"})[zone];
  return cashCalendarSchedule({mic,timezone:zone},date).eligible;
}

export function resolveMarketIntervalMs({
  now = new Date(),
  activeIntervalMs = null,
  offHoursIntervalMs = null,
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

  log.debug("market_interval_resolved", {
    open,
    intervalMs,
    quotaRemaining: Number.isFinite(quotaRemaining) ? quotaRemaining : null
  });

  return Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : null;
}
