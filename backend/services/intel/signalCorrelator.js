import { dirname } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createLogger } from "../../utils/logger.js";

const SIGNAL_TYPES = Object.freeze(["news", "military", "market", "cyber", "satellite", "prediction"]);
const PERSISTENCE_VERSION = 3;
const METHODOLOGY_VERSION = "signal-anomaly-v3";
const log = createLogger("backend/services/intel/signalCorrelator");

export const SIGNAL_ANOMALY_METHODOLOGY = Object.freeze({
  version: METHODOLOGY_VERSION,
  bucketMinutes: 60,
  valueSemantics: "hourly-news-incidence-and-hourly-market-signal-gauges",
  retentionDays: 30,
  defaultAdvancedActiveWindowHours: 24,
  legacyAdapterActiveWindowHours: 2,
  defaultBaselineDays: 7,
  minimumBaselineSamples: 24,
  minimumBaselineSpanHours: 23,
  scoreFormula: "clamp(50 + zScore*15, 0, 100)",
  anomalyThreshold: "current>baselineMean and zScore>=1.2",
  zeroVarianceRule: "score=82 when current>=baselineMean+2"
});

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function welfordVariance(values = []) {
  let count = 0;
  let meanValue = 0;
  let m2 = 0;
  for (const rawValue of values) {
    const value = Number(rawValue || 0);
    count += 1;
    const delta = value - meanValue;
    meanValue += delta / count;
    m2 += delta * (value - meanValue);
  }
  const variance = count > 1 ? m2 / (count - 1) : 0;
  return { count, mean: meanValue, variance, stddev: Math.sqrt(Math.max(0, variance)) };
}

function validTimestampMs(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function hourlyTimestamp(value, fallbackMs = Date.now()) {
  const timestampMs = validTimestampMs(value) ?? fallbackMs;
  return new Date(Math.floor(timestampMs / (60 * 60 * 1_000)) * 60 * 60 * 1_000).toISOString();
}

function trimHistory(history = [], maxAgeMs = 30 * 24 * 60 * 60 * 1_000, nowMs = Date.now()) {
  const thresholdMs = nowMs - maxAgeMs;
  return history.filter((entry) => {
    const timestampMs = validTimestampMs(entry?.timestamp);
    return timestampMs !== null && timestampMs >= thresholdMs && timestampMs <= nowMs + 5 * 60 * 1_000;
  });
}

function articleKey(item = {}) {
  const url = String(item.url || "").trim().toLowerCase().replace(/[?#].*$/, "");
  if (url) return `url:${url}`;
  const title = String(item.title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `title:${title}`;
}

function uniqueNewsItems(snapshot = {}, aggregateNews = { items: [] }, { fromMs = null, toMs = null } = {}) {
  const seen = new Set();
  const referenceMs = validTimestampMs(snapshot.meta?.lastRefreshAt) ?? Date.now();
  const thresholdMs = Number.isFinite(Number(fromMs)) ? Number(fromMs) : referenceMs - 24 * 60 * 60 * 1_000;
  const upperMs = Number.isFinite(Number(toMs)) ? Number(toMs) : referenceMs + 5 * 60 * 1_000;
  return [...(snapshot.signalCorpus || []), ...(aggregateNews.items || [])].filter((item) => {
    const timestampMs = validTimestampMs(item.publishedAt || item.timestamp);
    if (timestampMs === null || timestampMs < thresholdMs || timestampMs > upperMs) return false;
    const key = articleKey(item);
    if (key === "title:" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countMatching(items = [], predicate) {
  return items.filter(predicate).length;
}

function countryCounts(items = [], predicate = () => true) {
  const counts = {};
  for (const item of items) {
    if (!predicate(item)) continue;
    for (const iso2 of new Set(item.countryMentions || [])) counts[iso2] = (counts[iso2] || 0) + 1;
  }
  return counts;
}

function increment(record, key, amount = 1) {
  if (key) record[key] = (record[key] || 0) + amount;
}

export function deriveSignalSnapshot(snapshot = {}, aggregateNews = { items: [] }, options = {}) {
  const newsItems = uniqueNewsItems(snapshot, aggregateNews, options);
  const impactItems = snapshot.impact?.items || [];
  const predictionItems = snapshot.predictions?.tickers || [];
  return {
    news: newsItems.length,
    military: countMatching(newsItems, (item) =>
      Number(item.conflict?.totalWeight || 0) > 0 || (item.topicTags || []).includes("conflict")
    ),
    market:
      countMatching(impactItems, (item) => Number(item.impactScore || 0) > 0) +
      countMatching(Object.values(snapshot.market?.quotes || {}), (quote) => Math.abs(Number(quote.changePct || 0)) >= 1),
    cyber: countMatching(newsItems, (item) =>
      (item.topicTags || []).includes("cyber") ||
      (item.conflict?.tags || []).some((tag) => tag.tag === "Cyber Operations")
    ),
    satellite: countMatching(newsItems, (item) =>
      (item.topicTags || []).includes("space") || /satellite|rocket|launch/i.test(`${item.title || ""} ${item.description || ""}`)
    ),
    prediction: countMatching(predictionItems, (item) => Number(item.predictionScore || 0) > 0)
  };
}

export function deriveCountrySignalSnapshot(snapshot = {}, aggregateNews = { items: [] }, options = {}) {
  const newsItems = uniqueNewsItems(snapshot, aggregateNews, options);
  const byType = {
    news: countryCounts(newsItems),
    military: countryCounts(newsItems, (item) =>
      Number(item.conflict?.totalWeight || 0) > 0 || (item.topicTags || []).includes("conflict")
    ),
    cyber: countryCounts(newsItems, (item) =>
      (item.topicTags || []).includes("cyber") ||
      (item.conflict?.tags || []).some((tag) => tag.tag === "Cyber Operations")
    ),
    satellite: countryCounts(newsItems, (item) =>
      (item.topicTags || []).includes("space") || /satellite|rocket|launch/i.test(`${item.title || ""} ${item.description || ""}`)
    ),
    market: {},
    prediction: {}
  };
  for (const item of snapshot.impact?.items || []) {
    if (Number(item.impactScore || 0) <= 0) continue;
    for (const iso2 of new Set(item.linkedCountries || ["US"])) increment(byType.market, iso2);
  }
  for (const quote of Object.values(snapshot.market?.quotes || {})) {
    if (Math.abs(Number(quote.changePct || 0)) >= 1) increment(byType.market, "US");
  }
  for (const item of snapshot.predictions?.tickers || []) {
    if (Number(item.predictionScore || 0) > 0) increment(byType.prediction, item.sector === "energy" ? "IR" : "US");
  }
  return byType;
}

function scopedEntryValue(entry = {}, countries = []) {
  if (!countries.length) return Number(entry.value || 0);
  if (!entry.byCountry || typeof entry.byCountry !== "object") return null;
  return countries.reduce((sum, iso2) => sum + Number(entry.byCountry[iso2] || 0), 0);
}

function sampleSpanHours(entries = []) {
  const timestamps = entries.map((entry) => validTimestampMs(entry.timestamp)).filter(Number.isFinite);
  if (timestamps.length < 2) return 0;
  return (Math.max(...timestamps) - Math.min(...timestamps)) / (60 * 60 * 1_000);
}

export class SignalCorrelatorService {
  constructor({
    baselineDays = 30,
    persistencePath = null,
    minBaselineSamples = 24,
    minBaselineSpanHours = 23,
    now = () => Date.now()
  } = {}) {
    this.baselineDays = Math.max(1, Math.min(30, Number.parseInt(String(baselineDays ?? 30), 10) || 30));
    this.persistencePath = persistencePath || null;
    this.minBaselineSamples = Math.max(2, Number.parseInt(String(minBaselineSamples ?? 24), 10) || 24);
    this.minBaselineSpanHours = Math.max(1, Number(minBaselineSpanHours || 23));
    this.now = now;
    this.history = Object.fromEntries(SIGNAL_TYPES.map((type) => [type, []]));
    this.hydrate();
  }

  hydrate() {
    if (!this.persistencePath) return false;
    try {
      const payload = JSON.parse(readFileSync(this.persistencePath, "utf8"));
      if (payload?.version !== PERSISTENCE_VERSION || payload.methodologyVersion !== METHODOLOGY_VERSION || !payload.history) return false;
      const maxAgeMs = this.baselineDays * 24 * 60 * 60 * 1_000;
      this.history = Object.fromEntries(SIGNAL_TYPES.map((type) => [
        type,
        trimHistory(Array.isArray(payload.history[type]) ? payload.history[type] : [], maxAgeMs, this.now())
      ]));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      log.warn("signal_history_hydration_failed", { message: error.message });
      return false;
    }
  }

  persist() {
    if (!this.persistencePath) return;
    mkdirSync(dirname(this.persistencePath), { recursive: true });
    const temporary = `${this.persistencePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      version: PERSISTENCE_VERSION,
      methodologyVersion: METHODOLOGY_VERSION,
      savedAt: new Date(this.now()).toISOString(),
      history: this.history
    }), { mode: 0o600 });
    renameSync(temporary, this.persistencePath);
  }

  recordSnapshot(snapshot = {}, aggregateNews = { items: [] }) {
    const refreshMs = validTimestampMs(snapshot.meta?.lastRefreshAt) ?? this.now();
    const timestamp = hourlyTimestamp(refreshMs, this.now());
    const bucketStartMs = validTimestampMs(timestamp);
    const bucketWindow = { fromMs: bucketStartMs, toMs: refreshMs + 5 * 60 * 1_000 };
    const values = deriveSignalSnapshot(snapshot, aggregateNews, bucketWindow);
    const countryValues = deriveCountrySignalSnapshot(snapshot, aggregateNews, bucketWindow);
    const maxAgeMs = this.baselineDays * 24 * 60 * 60 * 1_000;
    let changed = false;
    for (const type of SIGNAL_TYPES) {
      const history = this.history[type] || [];
      const existing = history.find((entry) => entry.timestamp === timestamp);
      if (existing) {
        if (existing.value !== values[type] || JSON.stringify(existing.byCountry || {}) !== JSON.stringify(countryValues[type] || {})) {
          existing.value = Number(values[type] || 0);
          existing.byCountry = countryValues[type] || {};
          changed = true;
        }
        continue;
      }
      history.push({ timestamp, value: Number(values[type] || 0), byCountry: countryValues[type] || {} });
      this.history[type] = trimHistory(history, maxAgeMs, this.now())
        .sort((left, right) => validTimestampMs(left.timestamp) - validTimestampMs(right.timestamp));
      changed = true;
    }
    if (changed) this.persist();
  }

  getAnomalies({ activeWindowHours = 2, baselineDays = 7, countries = [] } = {}) {
    const nowMs = this.now();
    const resolvedActiveHours = Math.max(1, Math.min(48, Number(activeWindowHours || 2)));
    const resolvedBaselineDays = Math.max(1, Math.min(this.baselineDays, Number(baselineDays || 7)));
    const activeThresholdMs = nowMs - resolvedActiveHours * 60 * 60 * 1_000;
    const baselineThresholdMs = nowMs - resolvedBaselineDays * 24 * 60 * 60 * 1_000;
    const normalizedCountries = [...new Set((countries || []).map((iso2) => String(iso2 || "").toUpperCase()).filter(Boolean))];
    const minimumBaselineDays = Math.ceil((resolvedActiveHours + this.minBaselineSamples) / 24);
    const configurationValid = resolvedBaselineDays >= minimumBaselineDays;
    const items = SIGNAL_TYPES.map((type) => {
      const history = (this.history[type] || []).filter((entry) => {
        const timestampMs = validTimestampMs(entry.timestamp);
        return timestampMs !== null && timestampMs >= baselineThresholdMs && timestampMs <= nowMs + 5 * 60 * 1_000;
      });
      const activeEntries = history.filter((entry) => validTimestampMs(entry.timestamp) >= activeThresholdMs);
      const baselineEntries = history.filter((entry) => validTimestampMs(entry.timestamp) < activeThresholdMs);
      const activeValues = activeEntries.map((entry) => scopedEntryValue(entry, normalizedCountries)).filter(Number.isFinite);
      const baselineValues = baselineEntries.map((entry) => scopedEntryValue(entry, normalizedCountries)).filter(Number.isFinite);
      const baseline = welfordVariance(baselineValues);
      const scopedBaselineEntries = baselineEntries.filter((entry) => Number.isFinite(scopedEntryValue(entry, normalizedCountries)));
      const baselineSpan = sampleSpanHours(scopedBaselineEntries);
      const currentValue = activeValues.length ? Number(mean(activeValues).toFixed(2)) : null;
      const sufficientBaseline = configurationValid && activeValues.length > 0 && baseline.count >= this.minBaselineSamples && baselineSpan >= this.minBaselineSpanHours;
      if (!sufficientBaseline) {
        const status = !configurationValid ? "invalid_window" : activeValues.length ? "insufficient_baseline" : "insufficient_current_data";
        return {
          signalType: type,
          status,
          currentValue,
          baselineMean: baseline.count ? Number(baseline.mean.toFixed(2)) : null,
          baselineStddev: baseline.count ? Number(baseline.stddev.toFixed(2)) : null,
          zScore: null,
          anomalyScore: null,
          isAnomalous: false,
          samples: {
            active: activeValues.length,
            baseline: baseline.count,
            baselineSpanHours: Number(baselineSpan.toFixed(2)),
            requiredBaseline: this.minBaselineSamples,
            requiredSpanHours: this.minBaselineSpanHours
          }
        };
      }
      const zScore = baseline.stddev > 0 ? Number(((currentValue - baseline.mean) / baseline.stddev).toFixed(2)) : 0;
      const zeroVarianceSpike = baseline.stddev === 0 && currentValue >= baseline.mean + 2;
      const anomalyScore = Number(Math.max(0, Math.min(100, zeroVarianceSpike ? 82 : 50 + zScore * 15)).toFixed(2));
      return {
        signalType: type,
        status: "ready",
        currentValue,
        baselineMean: Number(baseline.mean.toFixed(2)),
        baselineStddev: Number(baseline.stddev.toFixed(2)),
        zScore,
        anomalyScore,
        isAnomalous: currentValue > baseline.mean && (zScore >= 1.2 || zeroVarianceSpike),
        samples: {
          active: activeValues.length,
          baseline: baseline.count,
          baselineSpanHours: Number(baselineSpan.toFixed(2)),
          requiredBaseline: this.minBaselineSamples,
          requiredSpanHours: this.minBaselineSpanHours
        }
      };
    }).sort((left, right) => {
      if (left.anomalyScore === null && right.anomalyScore !== null) return 1;
      if (right.anomalyScore === null && left.anomalyScore !== null) return -1;
      return Number(right.anomalyScore || 0) - Number(left.anomalyScore || 0);
    });
    const overallStatus = items.every((item) => item.status === "invalid_window")
      ? "invalid_window"
      : items.some((item) => item.status === "ready")
      ? "ready"
      : items.every((item) => item.status === "insufficient_current_data")
        ? "insufficient_current_data"
        : "insufficient_baseline";
    return {
      generatedAt: new Date(nowMs).toISOString(),
      latestBucketAt: SIGNAL_TYPES.flatMap((type) => this.history[type] || [])
        .map((entry) => entry.timestamp)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
      status: overallStatus,
      methodologyVersion: METHODOLOGY_VERSION,
      scope: normalizedCountries.length ? { type: "countries", countries: normalizedCountries } : { type: "global", countries: [] },
      window: { activeWindowHours: resolvedActiveHours, baselineDays: resolvedBaselineDays },
      configuration: {
        valid: configurationValid,
        minimumBaselineDays,
        reason: configurationValid ? null : "baseline-window-too-short-for-required-samples"
      },
      requirements: {
        minBaselineSamples: this.minBaselineSamples,
        minBaselineSpanHours: this.minBaselineSpanHours,
        retentionDays: this.baselineDays
      },
      methodology: SIGNAL_ANOMALY_METHODOLOGY,
      items
    };
  }
}
