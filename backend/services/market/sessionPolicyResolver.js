const FIVE_MINUTES_MS = 5 * 60_000;
const CASH_OPEN_MINUTE = 9 * 60 + 30;
const CASH_CLOSE_MINUTE = 16 * 60;
const FX_WEEKLY_OPEN_MINUTE = 17 * 60;
const FX_WEEKLY_CLOSE_MINUTE = 17 * 60;
const FUTURES_OPEN_MINUTE = 17 * 60;
const FUTURES_CLOSE_MINUTE = 16 * 60;
const FUTURES_BREAK_START_MINUTE = 16 * 60;
const FUTURES_BREAK_END_MINUTE = 17 * 60;

const WEEKDAY_INDEX = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
const CASH_ASSET_TYPES = new Set(["equity", "etf", "fund", "index"]);
const FUTURE_ASSET_TYPES = new Set(["future", "futures"]);
const CURRENCY_ASSET_TYPES = new Set(["currency", "forex", "fx"]);

const POLICY_ALIASES = Object.freeze({
  "24/7": "24x7",
  continuous: "24x7",
  continuous_utc: "24x7",
  "24/5": "24x5",
  fx_24x5: "24x5",
  "fx-24x5": "24x5",
  currency_hours: "24x5",
  "currency-hours": "24x5",
  provider_hours: "provider-futures-hours",
  "provider-hours": "provider-futures-hours",
  futures_hours: "provider-futures-hours",
  "futures-hours": "provider-futures-hours",
  provider_futures_hours: "provider-futures-hours",
  regular_hours: "exchange-hours",
  "regular-hours": "exchange-hours"
});

function normalizedAssetType(instrument = {}) {
  const value = String(instrument.assetType || instrument.quoteType || "").trim().toLowerCase();
  return ({ cryptocurrency: "crypto", mutualfund: "fund", money_market: "fund" })[value] || value;
}

function normalizedPolicy(value) {
  const policy = String(value || "").trim().toLowerCase();
  return POLICY_ALIASES[policy] || policy;
}

function finiteMinute(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 24 * 60 ? parsed : fallback;
}

function floorTimestamp(timestamp, intervalMs = FIVE_MINUTES_MS) {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}

function localParts(value, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(new Date(value));
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekday = WEEKDAY_INDEX[map.weekday];
    if (!Number.isInteger(weekday)) return null;
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      date: `${map.year}-${map.month}-${map.day}`,
      weekday,
      hour: Number(map.hour) % 24,
      minute: Number(map.minute),
      second: Number(map.second)
    };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function calendarDate(parts, offsetDays = 0) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    weekday: value.getUTCDay(),
    date: value.toISOString().slice(0, 10)
  };
}

function zonedDateTimeIso(parts, timeZone) {
  const targetWallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let candidate = targetWallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localParts(candidate, timeZone);
    if (!actual) return null;
    const actualWallClock = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const correction = targetWallClock - actualWallClock;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
}

function dateAtWeekday(parts, targetWeekday, direction) {
  const current = calendarDate(parts);
  let distance;
  if (direction < 0) {
    distance = -((current.weekday - targetWeekday + 7) % 7 || 7);
  } else {
    distance = (targetWeekday - current.weekday + 7) % 7 || 7;
  }
  return calendarDate(parts, distance);
}

function adjacentWeekday(parts, direction) {
  for (let offset = direction; Math.abs(offset) <= 7; offset += direction) {
    const candidate = calendarDate(parts, offset);
    if (candidate.weekday >= 1 && candidate.weekday <= 5) return candidate;
  }
  return null;
}

function localBoundary(date, minute, timeZone) {
  if (!date) return null;
  return zonedDateTimeIso({
    ...date,
    hour: Math.floor(minute / 60),
    minute: minute % 60
  }, timeZone);
}

function cashSchedule(parts, timeZone, asOfMs, intervalMs) {
  const minute = parts.hour * 60 + parts.minute;
  const weekday = parts.weekday >= 1 && parts.weekday <= 5;
  const eligible = weekday && minute >= CASH_OPEN_MINUTE && minute < CASH_CLOSE_MINUTE;
  let expectedLatestCandleAt;
  if (weekday && minute >= CASH_OPEN_MINUTE + intervalMs / 60_000 && minute < CASH_CLOSE_MINUTE) {
    expectedLatestCandleAt = new Date(floorTimestamp(asOfMs, intervalMs)).toISOString();
  } else if (weekday && minute >= CASH_CLOSE_MINUTE) {
    expectedLatestCandleAt = localBoundary(calendarDate(parts), CASH_CLOSE_MINUTE, timeZone);
  } else {
    expectedLatestCandleAt = localBoundary(adjacentWeekday(parts, -1), CASH_CLOSE_MINUTE, timeZone);
  }

  let nextEligibleAt = null;
  if (!eligible) {
    if (weekday && minute < CASH_OPEN_MINUTE) {
      nextEligibleAt = localBoundary(calendarDate(parts), CASH_OPEN_MINUTE, timeZone);
    } else {
      const next = adjacentWeekday(parts, 1);
      nextEligibleAt = localBoundary(next, CASH_OPEN_MINUTE, timeZone);
    }
  }

  return {
    eligible,
    sessionState: eligible ? "open" : "closed",
    sessionId: eligible ? parts.date : null,
    minute,
    sessionOpenMinute: CASH_OPEN_MINUTE,
    sessionCloseMinute: CASH_CLOSE_MINUTE,
    expectedLatestCandleAt,
    nextEligibleAt
  };
}

function fxTradingWeek(parts) {
  const sundayOffset = parts.weekday === 0 ? 0 : -parts.weekday;
  return calendarDate(parts, sundayOffset).date;
}

function fxSchedule(parts, timeZone, asOfMs, intervalMs) {
  const minute = parts.hour * 60 + parts.minute;
  const eligible = (parts.weekday >= 1 && parts.weekday <= 4)
    || (parts.weekday === 0 && minute >= FX_WEEKLY_OPEN_MINUTE)
    || (parts.weekday === 5 && minute < FX_WEEKLY_CLOSE_MINUTE);
  let expectedLatestCandleAt;
  let nextEligibleAt = null;
  if (eligible) {
    expectedLatestCandleAt = new Date(floorTimestamp(asOfMs, intervalMs)).toISOString();
  } else {
    const friday = parts.weekday === 5 && minute >= FX_WEEKLY_CLOSE_MINUTE
      ? calendarDate(parts)
      : dateAtWeekday(parts, 5, -1);
    expectedLatestCandleAt = localBoundary(friday, FX_WEEKLY_CLOSE_MINUTE, timeZone);
    const sunday = parts.weekday === 0 && minute < FX_WEEKLY_OPEN_MINUTE
      ? calendarDate(parts)
      : dateAtWeekday(parts, 0, 1);
    nextEligibleAt = localBoundary(sunday, FX_WEEKLY_OPEN_MINUTE, timeZone);
  }
  return {
    eligible,
    sessionState: eligible ? "open" : "closed",
    sessionId: eligible ? `fx-week:${fxTradingWeek(parts)}` : null,
    minute,
    sessionOpenMinute: null,
    sessionCloseMinute: null,
    expectedLatestCandleAt,
    nextEligibleAt
  };
}

function futuresProfile(instrument = {}) {
  const profile = instrument.sessionProfile || instrument.providerSession || {};
  return {
    timeZone: profile.timezone || "America/Chicago",
    weeklyOpenMinute: finiteMinute(profile.weeklyOpenMinute, FUTURES_OPEN_MINUTE),
    weeklyCloseMinute: finiteMinute(profile.weeklyCloseMinute, FUTURES_CLOSE_MINUTE),
    breakStartMinute: finiteMinute(profile.breakStartMinute, FUTURES_BREAK_START_MINUTE),
    breakEndMinute: finiteMinute(profile.breakEndMinute, FUTURES_BREAK_END_MINUTE),
    verified: profile.verified === true
  };
}

function futuresSchedule(parts, timeZone, profile, asOfMs, intervalMs) {
  const minute = parts.hour * 60 + parts.minute;
  const beforeBreak = minute < profile.breakStartMinute;
  const afterBreak = minute >= profile.breakEndMinute;
  const eligible = (parts.weekday === 0 && minute >= profile.weeklyOpenMinute)
    || (parts.weekday >= 1 && parts.weekday <= 4 && (beforeBreak || afterBreak))
    || (parts.weekday === 5 && minute < profile.weeklyCloseMinute);
  const segmentDate = eligible && afterBreak
    ? calendarDate(parts, 1).date
    : eligible
      ? parts.date
      : null;

  let expectedLatestCandleAt;
  let nextEligibleAt = null;
  if (eligible) {
    expectedLatestCandleAt = new Date(floorTimestamp(asOfMs, intervalMs)).toISOString();
  } else if (parts.weekday >= 1 && parts.weekday <= 4 && minute >= profile.breakStartMinute && minute < profile.breakEndMinute) {
    expectedLatestCandleAt = localBoundary(calendarDate(parts), profile.breakStartMinute, timeZone);
    nextEligibleAt = localBoundary(calendarDate(parts), profile.breakEndMinute, timeZone);
  } else {
    const friday = parts.weekday === 5 && minute >= profile.weeklyCloseMinute
      ? calendarDate(parts)
      : dateAtWeekday(parts, 5, -1);
    expectedLatestCandleAt = localBoundary(friday, profile.weeklyCloseMinute, timeZone);
    const sunday = parts.weekday === 0 && minute < profile.weeklyOpenMinute
      ? calendarDate(parts)
      : dateAtWeekday(parts, 0, 1);
    nextEligibleAt = localBoundary(sunday, profile.weeklyOpenMinute, timeZone);
  }

  return {
    eligible,
    sessionState: eligible ? "open" : "closed",
    sessionId: segmentDate ? `futures-session:${segmentDate}` : null,
    minute,
    sessionOpenMinute: null,
    sessionCloseMinute: null,
    expectedLatestCandleAt,
    nextEligibleAt
  };
}

export class SessionPolicyResolver {
  canonicalPolicy(instrument = {}) {
    const assetType = normalizedAssetType(instrument);
    if (assetType === "crypto") return "24x7";
    if (CURRENCY_ASSET_TYPES.has(assetType)) return "24x5";
    if (FUTURE_ASSET_TYPES.has(assetType)) return "provider-futures-hours";
    const legacy = normalizedPolicy(instrument.sessionPolicy);
    if (legacy) return legacy;
    if (CASH_ASSET_TYPES.has(assetType)) return "exchange-hours";
    return "unknown";
  }

  defaultPolicyForAssetType(assetType) {
    return this.canonicalPolicy({ assetType });
  }

  providerCapability(instrument = {}, providerId = "configured") {
    const policyId = this.canonicalPolicy(instrument);
    const assetType = normalizedAssetType(instrument);
    const supported = ["24x7", "24x5", "provider-futures-hours"].includes(policyId)
      || (["nyse-equities", "exchange-hours"].includes(policyId) && CASH_ASSET_TYPES.has(assetType));
    const sessionPolicyPartial = policyId === "provider-futures-hours"
      && !(instrument.sessionProfile?.verified === true || instrument.providerSession?.verified === true);
    return {
      providerId,
      intradayCandlesSupported: supported,
      automaticIngestionSupported: supported,
      sessionPolicyPartial
    };
  }

  projectedActiveMinutes(instrument = {}, { cashSessionMinutes = 390 } = {}) {
    const policyId = this.canonicalPolicy(instrument);
    if (["24x7", "24x5"].includes(policyId)) return 1_440;
    if (policyId === "provider-futures-hours") {
      const profile = futuresProfile(instrument);
      const breakMinutes = Math.max(0, profile.breakEndMinute - profile.breakStartMinute);
      return Math.max(1, 1_440 - breakMinutes);
    }
    return Math.max(1, Number(cashSessionMinutes) || 390);
  }

  quality(instrument = {}) {
    const policyId = this.canonicalPolicy(instrument);
    if (policyId === "24x7") {
      return { policyId, sessionCalendar: "continuous_utc", sessionPolicyPartial: false, limitations: [] };
    }
    if (policyId === "24x5") {
      return {
        policyId,
        sessionCalendar: "fx_24x5_new_york",
        sessionPolicyPartial: false,
        limitations: ["Provider holidays and exceptional FX closures require an explicit calendar."]
      };
    }
    if (policyId === "provider-futures-hours") {
      const profile = futuresProfile(instrument);
      return {
        policyId,
        sessionCalendar: profile.verified ? "provider_futures_hours" : "provider_futures_hours_approximation",
        sessionPolicyPartial: !profile.verified,
        limitations: profile.verified
          ? []
          : ["Futures hours use a provider-session approximation; product holidays, maintenance and early closes may differ."]
      };
    }
    if (["nyse-equities", "exchange-hours"].includes(policyId)) {
      return {
        policyId,
        sessionCalendar: "weekday_exchange_hours_approximation",
        sessionPolicyPartial: false,
        limitations: ["Exchange holidays and early closes require an explicit calendar."]
      };
    }
    return {
      policyId,
      sessionCalendar: "unresolved",
      sessionPolicyPartial: true,
      limitations: ["The trading-session policy could not be resolved."]
    };
  }

  resolve(instrument = {}, value = new Date(), { intervalMs = FIVE_MINUTES_MS } = {}) {
    const asOfMs = new Date(value).getTime();
    if (!Number.isFinite(asOfMs)) throw new TypeError("invalid-session-policy-as-of");
    const quality = this.quality(instrument);
    const capability = this.providerCapability(instrument);
    if (quality.policyId === "24x7") {
      return {
        ...quality,
        ...capability,
        eligible: true,
        sessionState: "continuous",
        sessionId: "24x7",
        minute: null,
        sessionOpenMinute: null,
        sessionCloseMinute: null,
        expectedLatestCandleAt: new Date(floorTimestamp(asOfMs, intervalMs)).toISOString(),
        nextEligibleAt: null,
        timezone: "UTC"
      };
    }

    let timeZone = instrument.timezone || "America/New_York";
    let schedule;
    if (quality.policyId === "24x5") {
      timeZone = "America/New_York";
      const parts = localParts(asOfMs, timeZone);
      schedule = parts ? fxSchedule(parts, timeZone, asOfMs, intervalMs) : null;
    } else if (quality.policyId === "provider-futures-hours") {
      const profile = futuresProfile(instrument);
      timeZone = profile.timeZone;
      const parts = localParts(asOfMs, timeZone);
      schedule = parts ? futuresSchedule(parts, timeZone, profile, asOfMs, intervalMs) : null;
    } else if (["nyse-equities", "exchange-hours"].includes(quality.policyId)) {
      timeZone = quality.policyId === "nyse-equities" ? "America/New_York" : timeZone;
      const parts = localParts(asOfMs, timeZone);
      schedule = parts ? cashSchedule(parts, timeZone, asOfMs, intervalMs) : null;
    }

    if (!schedule) {
      return {
        ...quality,
        ...capability,
        eligible: false,
        sessionState: "unknown",
        sessionId: null,
        minute: null,
        sessionOpenMinute: null,
        sessionCloseMinute: null,
        expectedLatestCandleAt: null,
        nextEligibleAt: null,
        timezone: timeZone
      };
    }
    return { ...quality, ...capability, ...schedule, timezone: timeZone };
  }

  resolveCandle(instrument = {}, value) {
    return this.resolve(instrument, value, { intervalMs: FIVE_MINUTES_MS });
  }

  gapBetween(previous, current, { intervalMs, instrument = {} } = {}) {
    if (!(Number(intervalMs) > 0)) return null;
    const previousMs = Date.parse(previous?.openTime);
    const currentMs = Date.parse(current?.openTime);
    if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs)) {
      return { reason: "session_unresolved", missingCandles: null };
    }
    const previousSession = this.resolve(instrument, previousMs, { intervalMs });
    const currentSession = this.resolve(instrument, currentMs, { intervalMs });
    if (!previousSession.eligible || !currentSession.eligible) {
      return { reason: "session_unresolved", after: previous.closeTime, before: current.openTime, missingCandles: null };
    }
    if (previousSession.policyId !== "24x7" && previousSession.sessionId !== currentSession.sessionId) return null;
    const delta = currentMs - previousMs;
    if (delta <= intervalMs) return null;
    return {
      reason: "missing_candles",
      after: previous.closeTime,
      before: current.openTime,
      missingCandles: Math.max(1, Math.round(delta / intervalMs) - 1),
      session: currentSession.sessionId
    };
  }

  rollupBucket(candle, instrument = {}, { sourceIntervalMs, targetIntervalMs } = {}) {
    const openMs = Date.parse(candle?.openTime);
    if (!Number.isFinite(openMs) || !(Number(sourceIntervalMs) > 0) || !(Number(targetIntervalMs) > 0)) return null;
    const session = this.resolve(instrument, openMs, { intervalMs: sourceIntervalMs });
    if (!session.eligible) return null;
    let startMs;
    if (["nyse-equities", "exchange-hours"].includes(session.policyId)) {
      const targetMinutes = targetIntervalMs / 60_000;
      const offsetMinutes = session.minute - session.sessionOpenMinute;
      const bucketIndex = Math.floor(offsetMinutes / targetMinutes);
      const bucketStartMinute = session.sessionOpenMinute + bucketIndex * targetMinutes;
      const minuteRemainder = session.minute - bucketStartMinute;
      startMs = openMs - (minuteRemainder * 60 + (new Date(candle.openTime).getUTCSeconds() || 0)) * 1_000
        - new Date(candle.openTime).getUTCMilliseconds();
    } else {
      startMs = Math.floor(openMs / targetIntervalMs) * targetIntervalMs;
    }
    const candidateEndMs = startMs + targetIntervalMs;
    const expectedOpenTimes = [];
    for (let timestamp = startMs; timestamp < candidateEndMs; timestamp += sourceIntervalMs) {
      if (this.resolve(instrument, timestamp, { intervalMs: sourceIntervalMs }).eligible) expectedOpenTimes.push(timestamp);
    }
    if (!expectedOpenTimes.includes(openMs) || expectedOpenTimes.length === 0) return null;
    const expectedEndMs = expectedOpenTimes.at(-1) + sourceIntervalMs;
    return {
      key: `${session.sessionId}:${startMs}`,
      startMs,
      expectedEndMs,
      expectedOpenTimes,
      expectedMinutes: expectedOpenTimes.length * sourceIntervalMs / 60_000,
      sessionId: session.sessionId,
      partialSessionBucket: expectedOpenTimes.length * sourceIntervalMs < targetIntervalMs
    };
  }
}

export const sessionPolicyResolver = Object.freeze(new SessionPolicyResolver());
