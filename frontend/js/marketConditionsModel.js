export const MARKET_CONDITIONS_WINDOWS = Object.freeze([
  Object.freeze({ label: "15m", minutes: 15 }),
  Object.freeze({ label: "1h", minutes: 60 }),
  Object.freeze({ label: "4h", minutes: 240 }),
  Object.freeze({ label: "24h", minutes: 1440 })
]);

export const DEFAULT_MARKET_CONDITIONS_WINDOW_MIN = 240;

const WINDOW_MINUTES = new Set(MARKET_CONDITIONS_WINDOWS.map((item) => item.minutes));
const MARKET_BANDS = new Set(["favorable", "caution", "adverse", "insufficient"]);
const DIRECTION_BANDS = new Set(["positive", "neutral", "negative", "insufficient"]);
const AVAILABILITY_REASON_ALIASES = Object.freeze({
  market_closed: "market_closed",
  market_close: "market_closed",
  session_closed: "market_closed",
  off_hours: "market_closed",
  stale_local_data: "stale_local_data",
  stale_data: "stale_local_data",
  stale_candles: "stale_local_data",
  stale: "stale_local_data",
  no_5m_history: "no_5m_history",
  no_history: "no_5m_history",
  no_intraday_history: "no_5m_history",
  missing_5m_history: "no_5m_history",
  outside_intraday_limit: "outside_intraday_limit",
  outside_limit: "outside_intraday_limit",
  intraday_limit: "outside_intraday_limit",
  warming_up: "warming_up",
  warmup: "warming_up",
  insufficient_closed_candles: "warming_up",
  automatic_ingestion_unsupported: "automatic_ingestion_unsupported",
  unsupported_ingestion: "automatic_ingestion_unsupported",
  insufficient: "insufficient_data",
  insufficient_data: "insufficient_data"
});
const AVAILABILITY_REASON_DETAILS = Object.freeze({
  market_closed: Object.freeze({
    label: "Market closed",
    message: "No new closed candles are expected until the next eligible market session."
  }),
  stale_local_data: Object.freeze({
    label: "Stale local data",
    message: "One or more retained local observed inputs are too old or explicitly stale for current conditions."
  }),
  no_5m_history: Object.freeze({
    label: "No 5m history",
    message: "No local observed 5-minute candle history is available for this instrument."
  }),
  outside_intraday_limit: Object.freeze({
    label: "Outside intraday limit",
    message: "This instrument is outside the configured intraday analysis limit."
  }),
  warming_up: Object.freeze({
    label: "Warming up",
    message: "Local 5-minute ingestion is active, but the selected window does not yet contain enough closed candles."
  }),
  automatic_ingestion_unsupported: Object.freeze({
    label: "Ingestion unsupported",
    message: "Automatic 5-minute ingestion is not supported for this instrument session policy."
  }),
  insufficient_data: Object.freeze({
    label: "Unavailable",
    message: "There are not enough eligible local observations for this analysis window."
  })
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function isoTimestamp(value) {
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function finiteNumber(value, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeStringList(values, limit = 8) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map((value) => text(value)).filter(Boolean))].slice(0, limit);
}

function normalizedToken(value) {
  return text(value).toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

function normalizeAvailabilityReason(value) {
  const token = normalizedToken(value);
  return AVAILABILITY_REASON_ALIASES[token] || token || null;
}

function normalizeEnum(value, aliases, fallback = null) {
  const token = normalizedToken(value);
  return aliases[token] || fallback;
}

export function availabilityReasonDetails(value, { analyzable = false } = {}) {
  const reason = normalizeAvailabilityReason(value);
  if (!reason && analyzable) {
    return { code: null, label: "Available", message: "Enough eligible local observations are available for analysis." };
  }
  const details = AVAILABILITY_REASON_DETAILS[reason] || AVAILABILITY_REASON_DETAILS.insufficient_data;
  return { code: reason || "insufficient_data", ...details };
}

export function normalizeAvailability(value, { quality = {}, symbol = {} } = {}) {
  const source = isRecord(value) ? value : {};
  const hasContract = isRecord(value);
  const rawReasonCodes = Array.isArray(source.reasonCodes)
    ? source.reasonCodes
    : Array.isArray(source.reasons)
      ? source.reasons
      : Array.isArray(source.codes)
        ? source.codes
        : [];
  const reasonCodes = [...new Set(rawReasonCodes.map(normalizeAvailabilityReason).filter(Boolean))];
  let primaryReason = normalizeAvailabilityReason(source.primaryReason ?? source.reason ?? source.reasonCode ?? source.code);
  if (!primaryReason) primaryReason = reasonCodes[0] || null;
  if (primaryReason && !reasonCodes.includes(primaryReason)) reasonCodes.unshift(primaryReason);

  let analyzable;
  if (typeof source.analyzable === "boolean") {
    analyzable = source.analyzable;
  } else {
    const availabilityState = normalizedToken(source.status || source.state);
    if (["available", "analyzable", "ready"].includes(availabilityState)) analyzable = true;
    else if (["unavailable", "not_analyzable", "blocked"].includes(availabilityState) || primaryReason) analyzable = false;
    else {
      const hasScore = normalizeScore(symbol.operabilityScore) !== null || normalizeScore(symbol.directionScore, { signed: true }) !== null;
      analyzable = hasScore && (!hasContract ? normalizeInputStatus(quality.status) !== "insufficient" : true);
    }
  }
  if (!analyzable && !primaryReason) {
    primaryReason = "insufficient_data";
    reasonCodes.unshift(primaryReason);
  }

  const requiredClosedCandles = finiteNumber(source.requiredClosedCandles ?? source.requiredCandles, { minimum: 1 });
  const availableClosedCandles = finiteNumber(source.availableClosedCandles ?? source.availableCandles ?? source.closedCandleCount, { minimum: 0 });
  return {
    analyzable,
    primaryReason: analyzable && !primaryReason ? null : primaryReason,
    reasonCodes,
    sessionState: normalizeEnum(source.sessionState ?? source.session, {
      open: "open",
      market_open: "open",
      closed: "closed",
      market_closed: "closed",
      continuous: "continuous",
      continuous_utc: "continuous",
      "24x7": "continuous",
      unsupported: "unsupported",
      unknown: "unknown"
    }, "unknown"),
    ingestionState: normalizeEnum(source.ingestionState ?? source.ingestion, {
      enabled: "enabled",
      active: "enabled",
      disabled: "disabled",
      off: "disabled",
      unsupported: "unsupported",
      automatic_ingestion_unsupported: "unsupported",
      not_scheduled: "not_scheduled",
      unscheduled: "not_scheduled",
      outside_intraday_limit: "not_scheduled",
      ready: "enabled",
      warming_up: "enabled",
      no_5m_history: "enabled",
      stale_local_data: "enabled",
      market_closed: "enabled"
    }),
    lastCandleAt: isoTimestamp(source.lastCandleAt ?? source.lastObservedCandleAt ?? quality.latestCandleAt),
    expectedLatestCandleAt: isoTimestamp(source.expectedLatestCandleAt ?? source.expectedCandleAt),
    nextEligibleAt: isoTimestamp(source.nextEligibleAt ?? source.nextSessionAt),
    requiredClosedCandles: requiredClosedCandles === null ? 2 : Math.floor(requiredClosedCandles),
    availableClosedCandles: availableClosedCandles === null ? null : Math.floor(availableClosedCandles)
  };
}

export function normalizeInputStatus(value) {
  const status = text(value).toLowerCase().replaceAll("-", "_");
  if (["observed", "live"].includes(status)) return "observed";
  if (["partial", "mixed"].includes(status)) return "partial";
  if (["stale", "router_stale", "historical_eod"].includes(status)) return "stale";
  return "insufficient";
}

export function inputStatusLabel(value) {
  return `Inputs: ${normalizeInputStatus(value)}`;
}

export function normalizeScore(value, { signed = false } = {}) {
  return finiteNumber(value, signed ? { minimum: -100, maximum: 100 } : { minimum: 0, maximum: 100 });
}

function roundedPercentages(entries) {
  const rawTotal = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (!(rawTotal > 0)) {
    return null;
  }

  const scaled = entries.map((entry, index) => {
    const exact = (entry.value / rawTotal) * 100;
    return { ...entry, index, exact, rounded: Math.floor(exact) };
  });
  let remaining = 100 - scaled.reduce((sum, entry) => sum + entry.rounded, 0);
  scaled
    .sort((left, right) => (right.exact - right.rounded) - (left.exact - left.rounded) || left.index - right.index)
    .forEach((entry) => {
      if (remaining > 0) {
        entry.rounded += 1;
        remaining -= 1;
      }
    });

  return Object.fromEntries(scaled.sort((left, right) => left.index - right.index).map((entry) => [entry.key, entry.rounded]));
}

export function normalizePressure(value) {
  if (!isRecord(value)) {
    return null;
  }
  const entries = ["positive", "neutral", "negative"].map((key) => ({
    key,
    value: finiteNumber(value[key], { minimum: 0 }) ?? 0
  }));
  const percentages = roundedPercentages(entries);
  if (!percentages) {
    return null;
  }
  return {
    ...percentages,
    total: 100,
    positiveEnd: percentages.positive,
    neutralEnd: percentages.positive + percentages.neutral
  };
}

function normalizeQuality(value = {}) {
  const quality = isRecord(value) ? value : {};
  const status = normalizeInputStatus(quality.status || quality.inputStatus || quality.mode);
  return {
    status,
    coveragePct: finiteNumber(quality.coveragePct, { minimum: 0, maximum: 100 }),
    latestNewsAt: isoTimestamp(quality.latestNewsAt),
    latestCandleAt: isoTimestamp(quality.latestCandleAt || quality.lastCandleAt),
    latestNewsAgeMin: finiteNumber(quality.latestNewsAgeMin, { minimum: 0 }),
    latestCandleAgeMin: finiteNumber(quality.latestCandleAgeMin ?? quality.lastCandleAgeMin, { minimum: 0 }),
    limitations: normalizeStringList(quality.limitations, 12)
  };
}

function normalizeBand(value, score, qualityStatus) {
  let band = text(value).toLowerCase();
  if (!MARKET_BANDS.has(band)) {
    band = score === null ? "insufficient" : score >= 70 ? "favorable" : score >= 40 ? "caution" : "adverse";
  }
  if (band === "favorable" && ["partial", "stale"].includes(qualityStatus)) {
    return "caution";
  }
  if (score === null) {
    return "insufficient";
  }
  return band;
}

function normalizeDirectionBand(value, score) {
  const band = text(value).toLowerCase();
  if (DIRECTION_BANDS.has(band)) {
    return score === null ? "insufficient" : band;
  }
  if (score === null) return "insufficient";
  if (score >= 20) return "positive";
  if (score <= -20) return "negative";
  return "neutral";
}

function normalizeComponent(value, index) {
  const component = isRecord(value) ? value : {};
  const key = text(component.key || component.id, `factor-${index + 1}`);
  return {
    key,
    label: text(component.label || component.name, key.replaceAll("_", " ")),
    score: normalizeScore(component.score),
    status: normalizeInputStatus(component.status || component.quality?.status),
    summary: text(component.summary || component.description)
  };
}

function normalizeDriver(value, index) {
  if (typeof value === "string") {
    return { key: `driver-${index + 1}`, label: text(value), direction: "neutral", strength: null };
  }
  const driver = isRecord(value) ? value : {};
  const key = text(driver.key || driver.id, `driver-${index + 1}`);
  const label = text(driver.label || driver.title || driver.summary || driver.name, key.replaceAll(/[-_]+/g, " "));
  return {
    key,
    label,
    direction: text(driver.direction, "neutral").toLowerCase(),
    strength: normalizeScore(driver.strength ?? driver.score, { signed: true }),
    evidenceCount: finiteNumber(driver.evidenceCount, { minimum: 0 })
  };
}

function normalizeSymbol(value, index, marketQualityStatus) {
  const symbol = isRecord(value) ? value : {};
  const quality = normalizeQuality(symbol.quality);
  const resolvedQuality = symbol.quality ? quality : { ...quality, status: marketQualityStatus };
  const availability = normalizeAvailability(symbol.availability, { quality: resolvedQuality, symbol });
  const hasAvailabilityContract = isRecord(symbol.availability);
  const legacyScoresEligible = !hasAvailabilityContract && resolvedQuality.status !== "insufficient";
  const retainedStaleScores = availability.primaryReason === "stale_local_data";
  const marketClosed = hasAvailabilityContract && (
    availability.primaryReason === "market_closed" || availability.reasonCodes.includes("market_closed")
  );
  const scoreContextEligible = legacyScoresEligible || availability.analyzable || retainedStaleScores;
  const operabilityEligible = scoreContextEligible && !marketClosed;
  const directionEligible = scoreContextEligible || availability.primaryReason === "market_closed";
  const operabilityScore = operabilityEligible ? normalizeScore(symbol.operabilityScore) : null;
  const directionScore = directionEligible ? normalizeScore(symbol.directionScore, { signed: true }) : null;
  const scoreQualityStatus = availability.primaryReason === "stale_local_data" ? "stale" : resolvedQuality.status;
  const ticker = text(symbol.ticker || symbol.symbol || symbol.canonicalSymbol, `Instrument ${index + 1}`);
  const metrics = isRecord(symbol.metrics) ? symbol.metrics : {};
  const evidence = isRecord(symbol.evidence) ? symbol.evidence : {};

  return {
    instrumentId: text(symbol.instrumentId, ticker),
    ticker,
    displayName: text(symbol.displayName || symbol.name, ticker),
    assetType: text(symbol.assetType, "unknown").toLowerCase(),
    sector: text(symbol.sector || metrics.sector),
    availability,
    operabilityScore,
    operabilityBand: normalizeBand(symbol.operabilityBand, operabilityScore, scoreQualityStatus),
    directionScore,
    directionBand: normalizeDirectionBand(symbol.directionBand, directionScore),
    pressure: directionScore === null ? null : normalizePressure(symbol.pressure),
    metrics: {
      windowReturnPct: finiteNumber(metrics.windowReturnPct ?? metrics.returnPct),
      rsi: finiteNumber(metrics.rsi, { minimum: 0, maximum: 100 }),
      macdHistogram: finiteNumber(metrics.macdHistogram),
      atrPct: finiteNumber(metrics.atrPct, { minimum: 0 }),
      realizedVolatilityPct: finiteNumber(metrics.realizedVolatilityPct ?? metrics.realizedVolatility, { minimum: 0 }),
      linkedNewsCount: finiteNumber(metrics.linkedNewsCount, { minimum: 0 }),
      couplingCount: finiteNumber(metrics.couplingCount ?? metrics.observedCouplingCount, { minimum: 0 })
    },
    drivers: (Array.isArray(symbol.drivers) ? symbol.drivers : []).map(normalizeDriver).filter((driver) => driver.label).slice(0, 4),
    evidence: {
      articleIds: normalizeStringList(evidence.articleIds, 20),
      sourceSummary: Array.isArray(evidence.sourceSummary)
        ? evidence.sourceSummary.slice(0, 8)
        : Array.isArray(evidence.sources)
          ? evidence.sources.slice(0, 8)
          : []
    },
    quality: resolvedQuality
  };
}

function normalizeCountryItem(value, index) {
  const country = isRecord(value) ? value : {};
  const drivers = Array.isArray(country.drivers)
    ? country.drivers.map((driver) => typeof driver === "string" ? text(driver) : text(driver?.label || driver?.title || driver?.summary)).filter(Boolean)
    : [];
  return {
    iso2: text(country.iso2 || country.code, `C${index + 1}`).toUpperCase(),
    country: text(country.country || country.name, "Unknown country"),
    level: text(country.level, "Stable"),
    trend: text(country.trend, "Flat"),
    summary: text(country.summary, "No current country context summary."),
    drivers: drivers.slice(0, 2)
  };
}

export function normalizeMarketConditions(payload = {}) {
  const source = isRecord(payload) ? payload : {};
  const requestedWindow = Number(source.window?.minutes ?? source.windowMin);
  const windowMinutes = WINDOW_MINUTES.has(requestedWindow) ? requestedWindow : DEFAULT_MARKET_CONDITIONS_WINDOW_MIN;
  const quality = normalizeQuality(source.quality);
  const marketSource = isRecord(source.market) ? source.market : {};
  const marketScore = quality.status === "insufficient" ? null : normalizeScore(marketSource.stabilityScore ?? marketSource.score);
  const symbols = (Array.isArray(source.symbols) ? source.symbols : []).map((symbol, index) => normalizeSymbol(symbol, index, quality.status));
  const countryContext = isRecord(source.countryContext) ? source.countryContext : {};
  const contractIssues = [];
  const generatedAt = isoTimestamp(source.generatedAt);

  if (!text(source.schemaVersion)) contractIssues.push("Missing schemaVersion.");
  if (!text(source.methodVersion)) contractIssues.push("Missing methodVersion.");
  if (!generatedAt) contractIssues.push("Missing or invalid generatedAt.");
  if (!WINDOW_MINUTES.has(requestedWindow)) contractIssues.push("Unsupported or missing analysis window; displaying 4h.");

  return {
    schemaVersion: text(source.schemaVersion, "market-conditions-snapshot-v1"),
    methodVersion: text(source.methodVersion, "market-conditions-v1.1"),
    generatedAt,
    revisions: isRecord(source.revisions) ? { ...source.revisions } : {},
    window: {
      minutes: windowMinutes,
      label: text(source.window?.label, MARKET_CONDITIONS_WINDOWS.find((item) => item.minutes === windowMinutes)?.label || "4h"),
      from: isoTimestamp(source.window?.from),
      to: isoTimestamp(source.window?.to),
      indicatorInterval: text(source.window?.indicatorInterval) || null
    },
    quality,
    market: {
      stabilityScore: marketScore,
      band: normalizeBand(marketSource.band, marketScore, quality.status),
      components: (Array.isArray(marketSource.components) ? marketSource.components : []).map(normalizeComponent).slice(0, 8),
      drivers: (Array.isArray(marketSource.drivers) ? marketSource.drivers : []).map(normalizeDriver).filter((driver) => driver.label).slice(0, 6)
    },
    symbols,
    countryContext: {
      contextWindow: text(countryContext.contextWindow, "current-intelligence-cycle"),
      items: (Array.isArray(countryContext.items) ? countryContext.items : []).map(normalizeCountryItem).slice(0, 20)
    },
    sourceSummary: Array.isArray(source.sourceSummary) ? source.sourceSummary.slice(0, 16) : [],
    limitations: [...normalizeStringList(source.limitations, 16), ...contractIssues],
    contractValid: contractIssues.length === 0
  };
}

export function scoreAriaLabel(label, score, band, { signed = false } = {}) {
  const normalizedScore = normalizeScore(score, { signed });
  if (normalizedScore === null) {
    return `${label}: insufficient data`;
  }
  const scoreLabel = signed && normalizedScore > 0 ? `plus ${Math.round(normalizedScore)}` : String(Math.round(normalizedScore));
  return signed
    ? `${label}: ${scoreLabel} on a minus 100 to 100 scale, ${band}`
    : `${label}: ${scoreLabel} out of 100, ${band}`;
}

export function scoreDisplay(score, { signed = false } = {}) {
  const normalized = normalizeScore(score, { signed });
  if (normalized === null) return "--";
  const rounded = Math.round(normalized);
  return signed && rounded > 0 ? `+${rounded}` : String(rounded);
}
