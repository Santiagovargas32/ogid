import { buildArticleInstrumentLinks } from "./impactEngineService.js";
import { buildMarketConditionSeries } from "./candleAggregationService.js";
import { classifyMarketConditionsAvailability } from "./marketConditionsAvailability.js";
import { calculateNewsPriceCouplingV2 } from "./newsPriceCoupling.js";
import { calculateTechnicalIndicators } from "./technicalIndicators.js";

export const MARKET_CONDITIONS_SCHEMA_VERSION = "market-conditions-snapshot-v1";
export const MARKET_CONDITIONS_METHOD_VERSION = "market-conditions-v1.1";
export const MARKET_CONDITIONS_WINDOWS = Object.freeze([15, 60, 240, 1_440]);

const GLOBAL_COMPONENT_WEIGHTS = Object.freeze({ news: 0.35, price: 0.30, events: 0.20, breadth: 0.15 });
const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);
const SYNTHETIC_MODES = new Set(["synthetic", "seeded", "fallback"]);
const STALE_MODES = new Set(["stale", "stale-if-error"]);
const MAX_CACHE_ENTRIES = 32;

const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const round = (value, digits = 2) => finite(value) ? Number(Number(value).toFixed(digits)) : null;
const clamp = (value, minimum = 0, maximum = 100) => Math.max(minimum, Math.min(maximum, Number(value)));
const average = (values = []) => values.length ? values.reduce((total, value) => total + Number(value), 0) / values.length : null;
const normalizeText = (value = "") => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const iso = (value) => { const timestamp = new Date(value).getTime(); return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null; };
const modeOf = (value = {}) => String(value.dataMode || value.mode || (value.synthetic ? "synthetic" : "observed")).toLowerCase();
const isSynthetic = (value = {}) => value.synthetic === true || SYNTHETIC_MODES.has(modeOf(value));
const isStale = (value = {}) => value.stale === true || STALE_MODES.has(modeOf(value)) || value.quality === "stale-if-error" || value.provenance?.stale === true;

export function normalizeMarketConditionsWindow(value = 240) {
  const parsed = Number(value);
  if (!MARKET_CONDITIONS_WINDOWS.includes(parsed)) {
    throw Object.assign(new RangeError("windowMin must be one of 15, 60, 240 or 1440."), { code: "INVALID_MARKET_CONDITIONS_WINDOW" });
  }
  return parsed;
}

export function classifyMarketStability(score, qualityStatus = "observed") {
  if (!finite(score) || qualityStatus === "synthetic") return "insufficient";
  const calculated = Number(score) >= 70 ? "favorable" : Number(score) >= 40 ? "caution" : "adverse";
  return calculated === "favorable" && ["partial", "stale"].includes(qualityStatus) ? "caution" : calculated;
}

export function classifyDirection(score) {
  if (!finite(score)) return "insufficient";
  if (Number(score) >= 20) return "positive";
  if (Number(score) <= -20) return "negative";
  return "neutral";
}

export function directionPressure(score) {
  if (!finite(score)) return null;
  const directional = Math.round(clamp(Math.abs(Number(score)), 0, 100));
  return Number(score) >= 0
    ? { positive: directional, neutral: 100 - directional, negative: 0 }
    : { positive: 0, neutral: 100 - directional, negative: directional };
}

export function canonicalMarketArticleUrl(value = "") {
  try {
    const parsed = new URL(String(value));
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function sourceIdentity(item = {}) {
  return normalizeText(item.sourceId || item.source?.sourceId || item.sourceName || item.source?.name || item.provider || "unknown");
}

function articleTimestamp(item = {}) {
  return iso(item.publishedAt || item.timestamp || item.receivedAt);
}

function sourceTitleTimeKey(item = {}) {
  const timestamp = Date.parse(articleTimestamp(item) || 0);
  const minute = Number.isFinite(timestamp) ? Math.floor(timestamp / 60_000) : "unknown";
  return `${sourceIdentity(item)}|${normalizeText(item.title)}|${minute}`;
}

function mergeDuplicateArticle(current, incoming) {
  const preferIncoming = String(current?.provider || "").toLowerCase() === "awareness" && String(incoming?.provider || "").toLowerCase() !== "awareness";
  const primary = preferIncoming ? incoming : current;
  const secondary = preferIncoming ? current : incoming;
  return {
    ...secondary,
    ...primary,
    id: primary.id || secondary.id,
    instrumentIds: [...new Set([...(current.instrumentIds || []), ...(incoming.instrumentIds || [])])],
    countryMentions: [...new Set([...(current.countryMentions || []), ...(incoming.countryMentions || [])])],
    domains: [...new Set([...(current.domains || []), ...(incoming.domains || [])])]
  };
}

function activeSourceIds(awareness = {}) {
  return new Set((awareness.sourceStatus || [])
    .filter((status) => String(status?.admissionState || "").toLowerCase() === "active" && status.enabled !== false)
    .map((status) => String(status.sourceId || "").toLowerCase())
    .filter(Boolean));
}

function isActiveAwarenessEvent(event, activeIds, hasStatusCatalog) {
  const sourceId = String(event?.source?.sourceId || event?.sourceId || "").toLowerCase();
  if (hasStatusCatalog) return Boolean(sourceId) && activeIds.has(sourceId);
  return String(event?.admissionState || event?.source?.admissionState || event?.provenance?.admissionState || "").toLowerCase() === "active";
}

function eventToArticle(event = {}) {
  return {
    id: event.eventId,
    provider: "awareness",
    sourceId: event.source?.sourceId || null,
    sourceName: event.source?.name || "Official awareness source",
    sourceRole: event.source?.role || "official",
    title: event.title,
    description: event.summary,
    content: event.summary,
    url: event.canonicalUrl,
    publishedAt: event.publishedAt,
    receivedAt: event.observedAt,
    countryMentions: event.countries || [],
    instrumentIds: event.instrumentIds || [],
    domains: event.domains || [],
    financialImportanceScore: event.importance === "high" ? 80 : event.importance === "medium" ? 55 : 30,
    sentiment: { label: "neutral", score: 0 },
    conflict: { totalWeight: 0, tags: [] },
    synthetic: false,
    dataMode: event.dataMode || "observed",
    provenance: event.provenance
  };
}

function countryRelevant(item = {}, countryFilter = []) {
  if (!countryFilter.length) return true;
  const selected = new Set(countryFilter.map((country) => String(country).toUpperCase()));
  const mentions = item.countryMentions || item.countries || [];
  if ((item.domains || []).includes("financial") || item.financial?.isFinancial === true || (item.instrumentIds || []).length) return true;
  return mentions.some((country) => selected.has(String(country).toUpperCase()));
}

/**
 * Builds the local Market Conditions news/event inputs. Awareness admission is
 * enforced again even when the caller already supplies a public projection.
 */
export function buildMarketConditionsCorpus({ articles = [], awareness = {}, windowMin = 240, countries = [], asOf = new Date().toISOString() } = {}) {
  const resolvedWindow = normalizeMarketConditionsWindow(windowMin);
  const asOfMs = Date.parse(asOf);
  const threshold = asOfMs - resolvedWindow * 60_000;
  const ids = activeSourceIds(awareness);
  const hasStatusCatalog = Array.isArray(awareness.sourceStatus) && awareness.sourceStatus.length > 0;
  const awarenessVisible = String(awareness.mode || "off").toLowerCase() === "visible";
  const activeRecent = awarenessVisible
    ? (awareness.recent || []).filter((event) => isActiveAwarenessEvent(event, ids, hasStatusCatalog)).map((event) => ({ ...event, marketConditionsProjection: "recent" }))
    : [];
  const activeUpcoming = awarenessVisible
    ? (awareness.upcoming || []).filter((event) => isActiveAwarenessEvent(event, ids, hasStatusCatalog)).map((event) => ({ ...event, marketConditionsProjection: "upcoming" }))
    : [];
  const activeEvents = [...activeRecent, ...activeUpcoming];
  const marketArticles = (articles || []).filter((article) => {
    if (String(article?.provider || "").toLowerCase() !== "awareness") return true;
    const sourceId = String(article.sourceId || article.provenance?.sourceId || "").toLowerCase();
    return hasStatusCatalog ? ids.has(sourceId) : false;
  });
  const releasedAwarenessArticles = activeEvents
    .filter((event) => ["released", "updated", "live"].includes(String(event.status || "").toLowerCase()) && event.publishedAt)
    .map(eventToArticle);
  const candidates = [...marketArticles, ...releasedAwarenessArticles]
    .filter((article) => countryRelevant(article, countries))
    .filter((article) => {
      const timestamp = Date.parse(articleTimestamp(article) || 0);
      return Number.isFinite(timestamp) && timestamp >= threshold && timestamp <= asOfMs + 5 * 60_000;
    });
  const deduplicated = [];
  const indexByUrl = new Map();
  const indexByFingerprint = new Map();
  for (const article of candidates) {
    const canonicalUrl = canonicalMarketArticleUrl(article.url || article.canonicalUrl || "");
    const urlKey = canonicalUrl ? `url:${canonicalUrl}` : null;
    const fingerprint = sourceTitleTimeKey(article);
    const existingIndex = (urlKey && indexByUrl.get(urlKey)) ?? indexByFingerprint.get(fingerprint);
    if (existingIndex != null) {
      deduplicated[existingIndex] = mergeDuplicateArticle(deduplicated[existingIndex], article);
      if (urlKey) indexByUrl.set(urlKey, existingIndex);
      indexByFingerprint.set(fingerprint, existingIndex);
      continue;
    }
    const index = deduplicated.length;
    deduplicated.push({ ...article, canonicalUrl: canonicalUrl || null });
    if (urlKey) indexByUrl.set(urlKey, index);
    indexByFingerprint.set(fingerprint, index);
  }
  return {
    articles: deduplicated.sort((left, right) => Date.parse(articleTimestamp(right) || 0) - Date.parse(articleTimestamp(left) || 0)),
    activeEvents: activeEvents.filter((event) => countryRelevant(event, countries)),
    activeSourceCount: ids.size,
    candidates: candidates.length,
    deduplicated: Math.max(0, candidates.length - deduplicated.length)
  };
}

export function deriveMarketConditionsSeries(baseCandles = [], windowMin = 240, asOf = new Date().toISOString(), instrument = null) {
  return buildMarketConditionSeries(baseCandles, { windowMin: normalizeMarketConditionsWindow(windowMin), instrument, asOf });
}

function windowReturn(candles, windowMin, asOf) {
  const threshold = Date.parse(asOf) - windowMin * 60_000;
  const withinWindow = candles.filter((candle) => Date.parse(candle.closeTime) >= threshold && Date.parse(candle.closeTime) <= Date.parse(asOf));
  if (withinWindow.length < 2) return null;
  const start = withinWindow[0];
  const end = withinWindow.at(-1);
  if (!finite(start.close) || !finite(end.close) || Number(start.close) === 0) return null;
  return Number(end.close) / Number(start.close) - 1;
}

function indicatorValue(technical, key, nested = null) {
  const value = technical?.indicators?.[key]?.value;
  return nested ? value?.[nested] : value;
}

function weightedAverage(entries = []) {
  const eligible = entries.filter((entry) => finite(entry.value) && finite(entry.weight) && Number(entry.weight) > 0);
  const totalWeight = eligible.reduce((total, entry) => total + Number(entry.weight), 0);
  return totalWeight ? eligible.reduce((total, entry) => total + Number(entry.value) * Number(entry.weight), 0) / totalWeight : null;
}

function technicalDirection({ technical, returnValue, lastClose }) {
  if (!finite(returnValue) || !finite(lastClose) || Number(lastClose) === 0) return { score: null, components: [] };
  const entries = [{ key: "return", value: clamp(Number(returnValue) * 1_000, -100, 100), weight: 0.35 }];
  const sma = indicatorValue(technical, "sma");
  const ema = indicatorValue(technical, "ema");
  const rsi = indicatorValue(technical, "rsi");
  const histogram = indicatorValue(technical, "macd", "histogram");
  const bollinger = indicatorValue(technical, "bollinger");
  if (finite(sma) && finite(ema)) entries.push({ key: "moving-averages", value: clamp(((Number(ema) - Number(sma)) / Number(lastClose)) * 4_000, -100, 100), weight: 0.20 });
  if (finite(rsi)) entries.push({ key: "rsi", value: clamp((Number(rsi) - 50) * 2, -100, 100), weight: 0.15 });
  if (finite(histogram)) entries.push({ key: "macd", value: clamp((Number(histogram) / Number(lastClose)) * 5_000, -100, 100), weight: 0.15 });
  if (finite(bollinger?.middle) && finite(bollinger?.upper) && finite(bollinger?.lower) && Number(bollinger.upper) !== Number(bollinger.lower)) {
    entries.push({ key: "bollinger", value: clamp(((Number(lastClose) - Number(bollinger.middle)) / ((Number(bollinger.upper) - Number(bollinger.lower)) / 2)) * 100, -100, 100), weight: 0.15 });
  }
  return { score: round(weightedAverage(entries)), components: entries.map((entry) => ({ key: entry.key, score: round(entry.value) })) };
}

function priceRisk({ technical, returnValue, lastClose }) {
  if (!finite(returnValue) || !finite(lastClose) || Number(lastClose) === 0) return null;
  const atrValue = indicatorValue(technical, "atr");
  const volatilityValue = indicatorValue(technical, "realizedVolatility");
  const signals = [{ value: Math.abs(Number(returnValue) * 100) * 8, weight: 0.35 }];
  if (finite(atrValue)) signals.push({ value: (Number(atrValue) / Number(lastClose)) * 100 * 12, weight: 0.35 });
  if (finite(volatilityValue)) signals.push({ value: Number(volatilityValue) * 100 * 20, weight: 0.30 });
  return round(clamp(weightedAverage(signals)));
}

function articleSeverity(article, asOfMs, windowMs) {
  const importance = Number(article.financialImportanceScore ?? article.financial?.importance?.score ?? 0);
  const conflict = clamp(Number(article.conflict?.totalWeight || 0) * 5);
  const sentiment = article.sentiment?.label === "negative" ? 65 : article.sentiment?.label === "neutral" ? 10 : 0;
  const base = weightedAverage([
    { value: clamp(importance), weight: 0.45 },
    { value: conflict, weight: 0.35 },
    { value: sentiment, weight: 0.20 }
  ]);
  const timestamp = Date.parse(articleTimestamp(article) || asOfMs);
  const ageFactor = clamp(1 - Math.max(0, asOfMs - timestamp) / Math.max(1, windowMs), 0, 1);
  return clamp(Number(base || 0) * (0.55 + ageFactor * 0.45));
}

function newsPressure(articles = [], asOf, windowMin) {
  const eligible = articles.filter((article) => !isSynthetic(article));
  if (!eligible.length) return null;
  const values = eligible.map((article) => articleSeverity(article, Date.parse(asOf), windowMin * 60_000));
  return round(clamp(Number(average(values) || 0) * 0.65 + Math.max(...values) * 0.35));
}

function eventStability(activeEvents = [], activeSourceCount, asOf, windowMin) {
  if (!activeSourceCount) return { score: null, used: [] };
  const asOfMs = Date.parse(asOf);
  const windowMs = windowMin * 60_000;
  const used = activeEvents.filter((event) => {
    if (event.source?.official === false || String(event.source?.role || "official").toLowerCase() !== "official") return false;
    const timestamp = Date.parse(event.scheduledAt || event.publishedAt || event.updatedAt || 0);
    if (!Number.isFinite(timestamp)) return false;
    return event.marketConditionsProjection === "upcoming"
      ? timestamp >= asOfMs && timestamp <= asOfMs + windowMs
      : timestamp >= asOfMs - windowMs && timestamp <= asOfMs;
  });
  if (!used.length) return { score: 100, used };
  const risks = used.map((event) => {
    const importance = event.importance === "high" ? 85 : event.importance === "medium" ? 55 : 30;
    const timestamp = Date.parse(event.scheduledAt || event.publishedAt || event.updatedAt);
    const proximity = clamp(1 - Math.abs(timestamp - asOfMs) / Math.max(1, windowMs), 0, 1);
    return importance * (0.65 + 0.35 * proximity);
  });
  const risk = clamp(Number(average(risks) || 0) * 0.6 + Math.max(...risks) * 0.4);
  return { score: round(100 - risk), used };
}

function linkedArticlesForInstrument(articles, instrument, instruments, quotes) {
  const ticker = String(instrument.canonicalSymbol || instrument.symbol || "").toUpperCase();
  return articles.filter((article) => buildArticleInstrumentLinks(article, { tickers: [ticker], instruments, marketQuotes: quotes }).length > 0);
}

function couplingReaction(couplings = [], instrumentId, windowMin) {
  const values = [];
  const evidence = [];
  for (const coupling of couplings.filter((item) => item?.instrumentId === instrumentId && item.dataQuality === "observed" && item.confounded !== true)) {
    const selected = (coupling.windows || []).find((window) => Number(window.windowMin) === Number(windowMin));
    if (!selected || Number(selected.dataCoverage || 0) < 2 / 3 || selected.confidenceMethod?.level === "insufficient") continue;
    const observedReturn = finite(selected.abnormalReturn) ? Number(selected.abnormalReturn) : finite(selected.rawReturn) ? Number(selected.rawReturn) : null;
    if (!finite(observedReturn)) continue;
    values.push(clamp(observedReturn * 1_500, -100, 100));
    evidence.push(coupling.newsId);
  }
  return { score: round(average(values)), evidence: [...new Set(evidence)] };
}

function symbolQuality({ candles, technical, quote, linkedArticles, directionScore, operabilityScore, availability = null, seriesQuality = {}, seriesGaps = [], incompleteBuckets = [] }) {
  const candleStatus = String(seriesQuality.status || "").toLowerCase();
  if (candles.some(isSynthetic) || isSynthetic(quote) || candleStatus === "synthetic") return { status: "synthetic", coveragePct: 0, candleStatus: candleStatus || "synthetic", gapDetected: false, openCandles: Number(seriesQuality.openCandles || 0), outsideSessionCandles: Number(seriesQuality.outsideSessionCandles || 0), incompleteBuckets: incompleteBuckets.length, limitations: ["Synthetic market inputs do not generate scores."] };
  if (!finite(directionScore) && !finite(operabilityScore)) return { status: "insufficient_data", coveragePct: 0, candleStatus: candleStatus || "insufficient_data", gapDetected: Boolean(seriesQuality.gapDetected || seriesGaps.length), openCandles: Number(seriesQuality.openCandles || 0), outsideSessionCandles: Number(seriesQuality.outsideSessionCandles || 0), incompleteBuckets: incompleteBuckets.length, limitations: ["Insufficient closed-candle coverage for this analysis window."] };
  const limitations = [];
  const stale = candles.some(isStale) || isStale(quote) || linkedArticles.some(isStale) || candleStatus === "stale" || availability?.reasonCodes?.includes("stale_local_data");
  if (stale) limitations.push("One or more retained local inputs are stale.");
  const gapDetected = Boolean(seriesQuality.gapDetected || seriesGaps.length || technical?.quality?.gapDetected);
  if (gapDetected) limitations.push("The closed-candle series contains gaps or incomplete rollups.");
  if (Number(seriesQuality.openCandles || 0) > 0) limitations.push("Open candles were excluded from the analysis.");
  if (Number(seriesQuality.outsideSessionCandles || 0) > 0) limitations.push("Candles outside the instrument session were excluded.");
  if (incompleteBuckets.length > 0) limitations.push("Incomplete rollup buckets were excluded.");
  if (["partial", "insufficient_data"].includes(candleStatus) && !gapDetected) limitations.push("Intraday candle coverage is partial.");
  const indicatorCount = Object.values(technical?.indicators || {}).filter((indicator) => indicator?.value != null).length;
  if (indicatorCount < 6) limitations.push("Some technical indicators are unavailable.");
  if (!linkedArticles.length) limitations.push("No symbol-linked news was observed in the selected window.");
  const seriesPenalty = (gapDetected ? 15 : 0) + (incompleteBuckets.length ? 5 : 0) + (["partial", "insufficient_data"].includes(candleStatus) ? 10 : 0);
  const coveragePct = Math.round(clamp((indicatorCount / 9) * 70 + (linkedArticles.length ? 20 : 0) + (finite(directionScore) ? 10 : 0) - seriesPenalty));
  return { status: stale ? "stale" : limitations.length ? "partial" : "observed", coveragePct, candleStatus: candleStatus || "observed", gapDetected, openCandles: Number(seriesQuality.openCandles || 0), outsideSessionCandles: Number(seriesQuality.outsideSessionCandles || 0), incompleteBuckets: incompleteBuckets.length, limitations };
}

function sourceSummary(articles = []) {
  const sources = new Map();
  for (const article of articles) {
    const provider = String(article.provider || "unknown").toLowerCase();
    const sourceName = article.sourceName || article.source?.name || provider;
    const key = `${provider}|${normalizeText(sourceName)}`;
    const current = sources.get(key) || { provider, sourceName, count: 0, latestAt: null };
    current.count += 1;
    if (!current.latestAt || Date.parse(articleTimestamp(article) || 0) > Date.parse(current.latestAt)) current.latestAt = articleTimestamp(article);
    sources.set(key, current);
  }
  return [...sources.values()].sort((left, right) => right.count - left.count || String(left.sourceName).localeCompare(String(right.sourceName))).slice(0, 12);
}

function condensedCountryContext(insights = [], countries = [], generatedAt = null) {
  const selected = new Set(countries.map((country) => String(country).toUpperCase()));
  const items = insights.filter((item) => !selected.size || selected.has(String(item.iso2 || "").toUpperCase())).slice(0, 8).map((item) => ({
    iso2: item.iso2 || null,
    country: item.country || null,
    level: item.level || null,
    trend: item.trend || null,
    summary: item.summary || null,
    drivers: (item.drivers || []).slice(0, 2),
    dataMode: item.dataMode || "derived"
  }));
  return { methodVersion: "country-risk-context-v1", generatedAt, windowIndependent: true, contextWindow: "current-intelligence-cycle", items };
}

function standardDeviation(values = []) {
  if (values.length < 2) return null;
  const mean = average(values);
  return Math.sqrt(values.reduce((total, value) => total + (Number(value) - mean) ** 2, 0) / values.length);
}

/** Pure snapshot builder. It performs no I/O and never calls a provider. */
export function buildMarketConditionsSnapshot({
  windowMin = 240,
  asOf = new Date().toISOString(),
  countries = [],
  articles = [],
  awareness = {},
  corpus = null,
  instruments = [],
  quotes = {},
  seriesByInstrument = {},
  couplings = [],
  countryInsights = [],
  revisions = {},
  sourceQuality = {},
  analysisLimit = 6,
  pollIntervalMs = 900_000,
  intradayCandlesEnabled = false
} = {}) {
  const resolvedWindow = normalizeMarketConditionsWindow(windowMin);
  const generatedAt = iso(asOf);
  if (!generatedAt) throw Object.assign(new TypeError("asOf must be a valid timestamp."), { code: "INVALID_MARKET_CONDITIONS_AS_OF" });
  const prepared = corpus || buildMarketConditionsCorpus({ articles, awareness, windowMin: resolvedWindow, countries, asOf: generatedAt });
  const allInstruments = instruments || [];
  const resolvedAnalysisLimit = Math.min(6, Math.max(1, Number(analysisLimit) || 6));
  const selectedInstruments = allInstruments.slice(0, resolvedAnalysisLimit);
  const symbolInternals = [];

  for (const instrument of selectedInstruments) {
    const instrumentId = instrument.instrumentId;
    const ticker = String(instrument.canonicalSymbol || instrument.symbol || "").toUpperCase();
    const entry = seriesByInstrument instanceof Map ? seriesByInstrument.get(instrumentId) : seriesByInstrument[instrumentId];
    const candles = Array.isArray(entry) ? entry : entry?.candles || [];
    const interval = Array.isArray(entry) ? candles[0]?.interval : entry?.interval || candles[0]?.interval;
    const seriesQuality = Array.isArray(entry) ? {} : entry?.quality || {};
    const seriesGaps = Array.isArray(entry) ? [] : entry?.gaps || [];
    const incompleteBuckets = Array.isArray(entry) ? [] : entry?.incompleteBuckets || [];
    const closedCandles = candles.filter((candle) => Date.parse(candle.closeTime) <= Date.parse(generatedAt)).sort((left, right) => Date.parse(left.openTime) - Date.parse(right.openTime));
    const quote = quotes[ticker] || quotes[instrumentId] || {};
    const availability = classifyMarketConditionsAvailability({
      instrument,
      baseCandles: Array.isArray(entry) || interval === "5min" ? closedCandles : entry?.baseCandles || [],
      base5m: Array.isArray(entry) ? null : entry?.base5m || null,
      seriesCandles: closedCandles,
      seriesInterval: interval || "5min",
      seriesQuality,
      seriesGaps,
      incompleteBuckets,
      windowMin: resolvedWindow,
      asOf: generatedAt,
      pollIntervalMs,
      automaticIngestionEnabled: intradayCandlesEnabled,
      quote
    });
    const syntheticMarket = closedCandles.some(isSynthetic) || isSynthetic(quote);
    const technical = !syntheticMarket && interval
      ? calculateTechnicalIndicators(closedCandles, { interval, calculatedAt: generatedAt })
      : { indicators: {}, quality: { reason: syntheticMarket ? "synthetic" : "insufficient_data", gapDetected: false }, sampleSize: closedCandles.length, lastCandleAt: closedCandles.at(-1)?.closeTime || null };
    const returnValue = syntheticMarket ? null : windowReturn(closedCandles, resolvedWindow, generatedAt);
    const lastClose = closedCandles.at(-1)?.close;
    const technicalResult = technicalDirection({ technical, returnValue, lastClose });
    const reaction = couplingReaction(couplings, instrumentId, resolvedWindow);
    const directionScore = finite(technicalResult.score)
      ? round(clamp(finite(reaction.score) ? Number(technicalResult.score) * 0.75 + Number(reaction.score) * 0.25 : technicalResult.score, -100, 100))
      : null;
    const risk = syntheticMarket ? null : priceRisk({ technical, returnValue, lastClose });
    const linkedArticles = linkedArticlesForInstrument(prepared.articles.filter((article) => !isSynthetic(article)), instrument, selectedInstruments, quotes);
    const informationRisk = linkedArticles.length ? newsPressure(linkedArticles, generatedAt, resolvedWindow) : prepared.articles.some((article) => !isSynthetic(article)) ? 0 : null;
    symbolInternals.push({ instrument, ticker, candles: closedCandles, quote, technical, returnValue, directionScore, technicalComponents: technicalResult.components, reaction, risk, linkedArticles, informationRisk, availability, seriesQuality, seriesGaps, incompleteBuckets });
  }

  const newsRisk = newsPressure(prepared.articles, generatedAt, resolvedWindow);
  const currentSessionInternals = symbolInternals.filter((item) => !item.availability.reasonCodes.includes("market_closed"));
  const priceRisks = currentSessionInternals.map((item) => item.risk).filter(finite);
  const priceStability = priceRisks.length ? round(100 - clamp(average(priceRisks))) : null;
  const events = eventStability(prepared.activeEvents, prepared.activeSourceCount, generatedAt, resolvedWindow);
  const returnsPct = currentSessionInternals.map((item) => finite(item.returnValue) ? Number(item.returnValue) * 100 : null).filter(finite);
  const dispersion = standardDeviation(returnsPct);
  const negativeBreadth = returnsPct.length ? returnsPct.filter((value) => value < 0).length / returnsPct.length : null;
  const breadthStress = returnsPct.length >= 2 ? clamp(Number(dispersion || 0) * 12 + Number(negativeBreadth || 0) * 35 + Number(average(returnsPct.map(Math.abs)) || 0) * 2) : null;
  const components = [
    { key: "news-pressure", label: "Market-linked information pressure", score: finite(newsRisk) ? round(100 - newsRisk) : null, evidenceCount: prepared.articles.filter((article) => !isSynthetic(article)).length, internalKey: "news" },
    { key: "price-stress", label: "Observed volatility and price stress", score: priceStability, evidenceCount: priceRisks.length, internalKey: "price" },
    { key: "official-events", label: "Recent and upcoming official-event risk", score: events.score, evidenceCount: events.used.length, internalKey: "events" },
    { key: "market-breadth", label: "Cross-symbol dispersion and breadth", score: finite(breadthStress) ? round(100 - breadthStress) : null, evidenceCount: returnsPct.length, internalKey: "breadth" }
  ];
  const weightedGlobalScore = round(weightedAverage(components.map((component) => ({ value: component.score, weight: GLOBAL_COMPONENT_WEIGHTS[component.internalKey] }))));
  const globalScore = finite(priceStability) ? weightedGlobalScore : null;
  const staleInputs = prepared.articles.some(isStale) || prepared.activeEvents.some(isStale) || symbolInternals.some((item) => item.candles.some(isStale) || isStale(item.quote) || item.seriesQuality?.status === "stale" || (finite(item.risk) && item.availability.reasonCodes.includes("stale_local_data")));
  const partialCandleInputs = symbolInternals.some((item) => item.seriesQuality?.status === "partial" || item.seriesQuality?.gapDetected || item.seriesGaps.length || item.incompleteBuckets.length || item.technical?.quality?.gapDetected);
  const syntheticInputs = prepared.articles.some(isSynthetic) || symbolInternals.some((item) => item.candles.some(isSynthetic) || isSynthetic(item.quote)) || sourceQuality.news?.synthetic === true || sourceQuality.market?.synthetic === true;
  const availableComponents = components.filter((component) => finite(component.score)).length;
  const qualityStatus = !finite(globalScore)
    ? syntheticInputs ? "synthetic" : "insufficient_data"
    : staleInputs ? "stale" : syntheticInputs || partialCandleInputs || availableComponents < components.length || symbolInternals.some((item) => !finite(item.risk)) ? "partial" : "observed";
  const qualityLimitations = [];
  if (qualityStatus === "synthetic") qualityLimitations.push("Synthetic inputs are excluded from all scores.");
  if (availableComponents < components.length) qualityLimitations.push("One or more market components lack local observed coverage.");
  if (staleInputs) qualityLimitations.push("Stale local inputs retain their numeric values but cannot produce favorable conditions.");
  if (partialCandleInputs) qualityLimitations.push("Intraday gaps or incomplete rollups reduce market coverage.");
  if (allInstruments.length > resolvedAnalysisLimit) qualityLimitations.push(`Only the first ${resolvedAnalysisLimit} hot instruments are analyzed; remaining watchlist instruments are reported as outside_intraday_limit.`);

  const symbols = symbolInternals.map((item) => {
    const operabilityEntries = [
      { value: globalScore, weight: 0.50 },
      { value: finite(item.risk) ? 100 - Number(item.risk) : null, weight: 0.30 },
      { value: finite(item.informationRisk) ? 100 - Number(item.informationRisk) : null, weight: 0.20 }
    ];
    let operabilityScore = round(weightedAverage(operabilityEntries));
    if (item.candles.some(isSynthetic) || isSynthetic(item.quote) || !finite(item.returnValue)) operabilityScore = null;
    if (item.availability.reasonCodes.includes("market_closed")) operabilityScore = null;
    const quality = symbolQuality({ candles: item.candles, technical: item.technical, quote: item.quote, linkedArticles: item.linkedArticles, directionScore: item.directionScore, operabilityScore, availability: item.availability, seriesQuality: item.seriesQuality, seriesGaps: item.seriesGaps, incompleteBuckets: item.incompleteBuckets });
    const metrics = {
      windowReturnPct: finite(item.returnValue) ? round(Number(item.returnValue) * 100, 3) : null,
      sma: round(indicatorValue(item.technical, "sma")),
      ema: round(indicatorValue(item.technical, "ema")),
      rsi: round(indicatorValue(item.technical, "rsi")),
      macdHistogram: round(indicatorValue(item.technical, "macd", "histogram"), 4),
      bollingerPosition: (() => {
        const bands = indicatorValue(item.technical, "bollinger");
        const lastClose = item.candles.at(-1)?.close;
        return finite(lastClose) && finite(bands?.upper) && finite(bands?.lower) && Number(bands.upper) !== Number(bands.lower)
          ? round((Number(lastClose) - Number(bands.lower)) / (Number(bands.upper) - Number(bands.lower)), 3)
          : null;
      })(),
      atrPct: finite(indicatorValue(item.technical, "atr")) && finite(item.candles.at(-1)?.close) ? round(Number(indicatorValue(item.technical, "atr")) / Number(item.candles.at(-1).close) * 100, 3) : null,
      realizedVolatilityPct: finite(indicatorValue(item.technical, "realizedVolatility")) ? round(Number(indicatorValue(item.technical, "realizedVolatility")) * 100, 3) : null,
      linkedNewsCount: item.linkedArticles.length,
      observedCouplingCount: item.reaction.evidence.length
    };
    const drivers = [
      ...item.technicalComponents.sort((left, right) => Math.abs(right.score) - Math.abs(left.score)).slice(0, 2).map((component) => ({ key: component.key, direction: classifyDirection(component.score), strength: round(Math.abs(component.score)) })),
      ...(finite(item.reaction.score) ? [{ key: "observed-news-price-reaction", direction: classifyDirection(item.reaction.score), strength: round(Math.abs(item.reaction.score)) }] : []),
      ...(finite(item.informationRisk) ? [{ key: "information-pressure", direction: "risk", strength: round(item.informationRisk) }] : [])
    ].slice(0, 4);
    return {
      instrumentId: item.instrument.instrumentId,
      ticker: item.ticker,
      displayName: item.instrument.displayName || item.ticker,
      assetType: item.instrument.assetType || null,
      sector: item.instrument.sector || null,
      operabilityScore,
      operabilityBand: classifyMarketStability(operabilityScore, quality.status),
      directionScore: item.directionScore,
      directionBand: classifyDirection(item.directionScore),
      pressure: directionPressure(item.directionScore),
      metrics,
      drivers,
      availability: item.availability,
      quality: {
        ...quality,
        lastCandleAt: item.candles.at(-1)?.closeTime || null,
        lastCandleAgeMin: item.candles.at(-1)?.closeTime ? Math.max(0, round((Date.parse(generatedAt) - Date.parse(item.candles.at(-1).closeTime)) / 60_000, 1)) : null
      },
      evidence: {
        articleIds: item.linkedArticles.map((article) => article.id).filter(Boolean).slice(0, 12),
        couplingArticleIds: item.reaction.evidence.slice(0, 12),
        sources: sourceSummary(item.linkedArticles).slice(0, 5)
      }
    };
  });
  for (const instrument of allInstruments.slice(resolvedAnalysisLimit)) {
    const ticker = String(instrument.canonicalSymbol || instrument.symbol || "").toUpperCase();
    const availability = classifyMarketConditionsAvailability({ instrument, windowMin: resolvedWindow, asOf: generatedAt, pollIntervalMs, automaticIngestionEnabled: intradayCandlesEnabled, outsideIntradayLimit: true });
    symbols.push({
      instrumentId: instrument.instrumentId,
      ticker,
      displayName: instrument.displayName || ticker,
      assetType: instrument.assetType || null,
      sector: instrument.sector || null,
      operabilityScore: null,
      operabilityBand: "insufficient",
      directionScore: null,
      directionBand: "insufficient",
      pressure: null,
      metrics: {
        windowReturnPct: null,
        sma: null,
        ema: null,
        rsi: null,
        macdHistogram: null,
        bollingerPosition: null,
        atrPct: null,
        realizedVolatilityPct: null,
        linkedNewsCount: 0,
        observedCouplingCount: 0
      },
      drivers: [],
      availability,
      quality: { status: "insufficient_data", coveragePct: 0, lastCandleAt: null, lastCandleAgeMin: null, limitations: ["outside_intraday_limit"] },
      evidence: { articleIds: [], couplingArticleIds: [], sources: [] }
    });
  }

  const marketDrivers = components.filter((component) => finite(component.score)).sort((left, right) => left.score - right.score).slice(0, 4).map((component) => ({
    key: component.key,
    label: component.label,
    direction: component.score < 40 ? "adverse" : component.score >= 70 ? "supportive" : "neutral",
    strength: round(Math.abs(50 - component.score) * 2),
    evidenceCount: component.evidenceCount
  }));
  const latestNewsAt = prepared.articles.map(articleTimestamp).filter(Boolean).sort().at(-1) || null;
  const latestCandleAt = symbolInternals.map((item) => item.candles.at(-1)?.closeTime).filter(Boolean).sort().at(-1) || null;
  return {
    schemaVersion: MARKET_CONDITIONS_SCHEMA_VERSION,
    methodVersion: MARKET_CONDITIONS_METHOD_VERSION,
    generatedAt,
    revisions: {
      news: revisions.news ?? null,
      market: revisions.market ?? null,
      awareness: revisions.awareness ?? awareness.revision ?? 0,
      watchlist: revisions.watchlist ?? null,
      candles: revisions.candles ?? null
    },
    window: {
      minutes: resolvedWindow,
      label: resolvedWindow === 1_440 ? "24h" : resolvedWindow >= 60 ? `${resolvedWindow / 60}h` : `${resolvedWindow}m`,
      from: new Date(Date.parse(generatedAt) - resolvedWindow * 60_000).toISOString(),
      to: generatedAt,
      indicatorInterval: resolvedWindow === 15 ? "5min" : resolvedWindow === 60 ? "15min" : "1h"
    },
    filters: { countries: [...countries] },
    market: {
      stabilityScore: globalScore,
      band: classifyMarketStability(globalScore, qualityStatus),
      components: components.map(({ internalKey: _internalKey, ...component }) => component),
      drivers: marketDrivers,
      evidence: {
        articleIds: prepared.articles.filter((article) => !isSynthetic(article)).map((article) => article.id).filter(Boolean).slice(0, 20),
        awarenessEventIds: events.used.map((event) => event.eventId).filter(Boolean).slice(0, 20),
        sources: sourceSummary(prepared.articles).slice(0, 8)
      }
    },
    symbols,
    countryContext: condensedCountryContext(countryInsights, countries, revisions.countryRisk ?? null),
    quality: {
      status: qualityStatus,
      coveragePct: Math.round(availableComponents / components.length * 100),
      latestNewsAt,
      latestNewsAgeMin: latestNewsAt ? Math.max(0, round((Date.parse(generatedAt) - Date.parse(latestNewsAt)) / 60_000, 1)) : null,
      latestCandleAt,
      latestCandleAgeMin: latestCandleAt ? Math.max(0, round((Date.parse(generatedAt) - Date.parse(latestCandleAt)) / 60_000, 1)) : null,
      providers: [...new Set(prepared.articles.map((article) => article.provider).filter(Boolean))].sort(),
      limitations: [...new Set(qualityLimitations)]
    },
    sourceSummary: sourceSummary(prepared.articles),
    limitations: [
      "Deterministic decision support; not a price prediction or Buy/Sell/Hold recommendation.",
      "Country Risk is contextual output and is not an input to the market stability score.",
      "Observed news-price movement is temporal association, not causality."
    ],
    diagnostics: {
      corpusSize: prepared.articles.length,
      deduplicated: prepared.deduplicated,
      activeAwarenessSources: prepared.activeSourceCount,
      analyzedInstruments: selectedInstruments.length,
      selectedInstruments: allInstruments.length
    }
  };
}

function revisionKey(value) {
  if (value == null) return "none";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function selectedInstrumentsFrom({ marketWatchlistService, snapshot }) {
  const selected = marketWatchlistService?.selectedInstruments?.();
  if (Array.isArray(selected)) return selected;
  return marketWatchlistService?.snapshot?.()?.instruments || Object.values(snapshot.market?.quotes || {}).map((quote) => ({
    instrumentId: quote.instrumentId,
    canonicalSymbol: quote.canonicalSymbol || quote.symbol,
    displayName: quote.displayName || quote.symbol,
    assetType: quote.assetType,
    currency: quote.currency,
    timezone: quote.timezone,
    sessionPolicy: quote.sessionPolicy
  })).filter((instrument) => instrument.instrumentId && instrument.canonicalSymbol);
}

export class MarketConditionsService {
  constructor({ stateManager, candleStore, marketWatchlistService, newsPriceCouplingService = null, awarenessService = null, now = () => new Date(), seriesResolver = null, maxInstruments = 6, pollIntervalMs = 900_000, intradayCandlesEnabled = false } = {}) {
    this.stateManager = stateManager;
    this.candleStore = candleStore;
    this.marketWatchlistService = marketWatchlistService;
    this.newsPriceCouplingService = newsPriceCouplingService;
    this.awarenessService = awarenessService;
    this.now = now;
    this.seriesResolver = seriesResolver;
    this.maxInstruments = Math.min(6, Math.max(1, Number(maxInstruments) || 6));
    this.pollIntervalMs = Number.isFinite(Number(pollIntervalMs)) && Number(pollIntervalMs) > 0 ? Number(pollIntervalMs) : 900_000;
    this.intradayCandlesEnabled = intradayCandlesEnabled === true;
    this.cache = new Map();
  }

  #resolveSeries(instrument, windowMin, asOf) {
    const resolved = this.seriesResolver?.({ instrument, windowMin, asOf, store: this.candleStore });
    if (resolved) return resolved;
    const base = this.candleStore?.query?.({ instrumentId: instrument.instrumentId, interval: "5min", adjustmentMode: "splits", limit: 500 }) || [];
    const series = deriveMarketConditionsSeries(base, windowMin, asOf, instrument);
    const nonSynthetic = base.filter((candle) => !isSynthetic(candle));
    return {
      ...series,
      base5m: {
        count: base.length,
        nonSyntheticCount: nonSynthetic.length,
        lastCandleAt: nonSynthetic.at(-1)?.closeTime || null,
        explicitlyStale: nonSynthetic.some(isStale)
      }
    };
  }

  #buildCouplings({ corpus, instruments, seriesByInstrument, windowMin, asOf }) {
    if (typeof this.newsPriceCouplingService?.calculateFromSeries === "function") {
      return this.newsPriceCouplingService.calculateFromSeries({ articles: corpus.articles, instruments, seriesByInstrument, windowMin, asOf });
    }
    const benchmark = instruments.find((instrument) => ["index", "fund", "etf"].includes(String(instrument.assetType || "").toLowerCase())) || null;
    const benchmarkSeries = benchmark ? seriesByInstrument[benchmark.instrumentId]?.candles || [] : [];
    const results = [];
    for (const article of corpus.articles.filter((item) => !isSynthetic(item))) {
      for (const instrument of instruments) {
        const ticker = String(instrument.canonicalSymbol || instrument.symbol || "").toUpperCase();
        if (!buildArticleInstrumentLinks(article, { tickers: [ticker], instruments }).length) continue;
        results.push(calculateNewsPriceCouplingV2({
          news: article,
          instrument,
          candles: seriesByInstrument[instrument.instrumentId]?.candles || [],
          benchmarkInstrument: benchmark?.instrumentId === instrument.instrumentId ? null : benchmark,
          benchmarkCandles: benchmark?.instrumentId === instrument.instrumentId ? [] : benchmarkSeries,
          competingNews: corpus.articles,
          parameters: {
            interval: seriesByInstrument[instrument.instrumentId]?.interval || "15min",
            preEventWindowMin: Math.min(60, windowMin),
            postEventWindowsMin: [windowMin],
            adjustmentMode: "splits"
          },
          asOf
        }));
      }
    }
    return results;
  }

  getSnapshot({ windowMin = 240, countries = [] } = {}) {
    const resolvedWindow = normalizeMarketConditionsWindow(windowMin);
    const nowValue = this.now();
    const asOf = new Date(nowValue).toISOString();
    const snapshot = this.stateManager?.getSnapshot?.() || {};
    const awareness = this.awarenessService?.getSnapshot?.() || snapshot.awareness || {};
    const instruments = selectedInstrumentsFrom({ marketWatchlistService: this.marketWatchlistService, snapshot });
    const analyzedInstruments = instruments.slice(0, this.maxInstruments);
    const articles = this.stateManager?.getMarketSignalCorpus?.() || [];
    const normalizedCountries = [...new Set((countries || []).map((country) => String(country).trim().toUpperCase()).filter(Boolean))].sort();
    const corpus = buildMarketConditionsCorpus({ articles, awareness, windowMin: resolvedWindow, countries: normalizedCountries, asOf });
    const seriesByInstrument = Object.fromEntries(analyzedInstruments.map((instrument) => [instrument.instrumentId, this.#resolveSeries(instrument, resolvedWindow, asOf)]));
    const latestCandleRevision = analyzedInstruments.map((instrument) => `${instrument.instrumentId}:${seriesByInstrument[instrument.instrumentId]?.candles?.at(-1)?.closeTime || "none"}`).join("|");
    const watchlistRevision = instruments.map((instrument) => instrument.instrumentId).join(",");
    const revisions = {
      news: snapshot.meta?.lastRefreshAt || snapshot.meta?.sourceMeta?.revision || null,
      market: snapshot.market?.revision || snapshot.market?.updatedAt || null,
      awareness: awareness.revision || 0,
      watchlist: watchlistRevision,
      candles: latestCandleRevision,
      countryRisk: snapshot.meta?.lastRefreshAt || null
    };
    const minuteBucket = Math.floor(Date.parse(asOf) / 60_000);
    const cacheKey = [resolvedWindow, normalizedCountries.join(","), ...Object.values(revisions).map(revisionKey), minuteBucket].join("::");
    if (this.cache.has(cacheKey)) return structuredClone(this.cache.get(cacheKey));
    const couplings = this.#buildCouplings({ corpus, instruments: analyzedInstruments, seriesByInstrument, windowMin: resolvedWindow, asOf });
    const result = buildMarketConditionsSnapshot({
      windowMin: resolvedWindow,
      asOf,
      countries: normalizedCountries,
      corpus,
      awareness,
      instruments,
      quotes: snapshot.market?.quotes || {},
      seriesByInstrument,
      couplings,
      countryInsights: snapshot.insights || [],
      revisions,
      sourceQuality: snapshot.meta?.dataQuality || {},
      analysisLimit: this.maxInstruments,
      pollIntervalMs: this.pollIntervalMs,
      intradayCandlesEnabled: this.intradayCandlesEnabled
    });
    this.cache.set(cacheKey, result);
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
    return structuredClone(result);
  }
}
