const SIGNAL_TYPES = Object.freeze(["news", "military", "market", "cyber", "satellite", "prediction"]);

function mean(values = []) {
  if (!values.length) {
    return 0;
  }
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
    const delta2 = value - meanValue;
    m2 += delta * delta2;
  }

  const variance = count > 1 ? m2 / (count - 1) : 0;
  return {
    count,
    mean: meanValue,
    variance,
    stddev: Math.sqrt(Math.max(0, variance))
  };
}

function trimHistory(history = [], maxAgeMs = 7 * 24 * 60 * 60 * 1_000) {
  const thresholdMs = Date.now() - maxAgeMs;
  return history.filter((entry) => new Date(entry.timestamp || 0).getTime() >= thresholdMs);
}

function countMatching(items = [], predicate) {
  return items.filter(predicate).length;
}

export function deriveSignalSnapshot(snapshot = {}, aggregateNews = { items: [] }) {
  const signalCorpus = snapshot.signalCorpus || [];
  const impactItems = snapshot.impact?.items || [];
  const predictionItems = snapshot.predictions?.tickers || [];
  const aggregateItems = aggregateNews.items || [];

  return {
    news: signalCorpus.length + aggregateItems.length,
    military:
      countMatching(signalCorpus, (item) => Number(item.conflict?.totalWeight || 0) > 0) +
      countMatching(aggregateItems, (item) => (item.topicTags || []).includes("conflict")),
    market:
      countMatching(impactItems, (item) => Number(item.impactScore || 0) > 0) +
      countMatching(Object.values(snapshot.market?.quotes || {}), (quote) => Math.abs(Number(quote.changePct || 0)) >= 1),
    cyber:
      countMatching(signalCorpus, (item) => (item.conflict?.tags || []).some((tag) => tag.tag === "Cyber Operations")) +
      countMatching(aggregateItems, (item) => (item.topicTags || []).includes("cyber")),
    satellite:
      countMatching(aggregateItems, (item) => (item.topicTags || []).includes("space")) +
      countMatching(signalCorpus, (item) => /satellite|rocket|launch/i.test(`${item.title || ""} ${item.description || ""}`)),
    prediction: countMatching(predictionItems, (item) => Number(item.predictionScore || 0) > 0)
  };
}

export class SignalCorrelatorService {
  constructor({ baselineDays = 7 } = {}) {
    this.baselineDays = Math.max(1, Number.parseInt(String(baselineDays ?? 7), 10) || 7);
    this.history = Object.fromEntries(SIGNAL_TYPES.map((type) => [type, []]));
  }

  recordSnapshot(snapshot = {}, aggregateNews = { items: [] }) {
    const timestamp = snapshot.meta?.lastRefreshAt || new Date().toISOString();
    const values = deriveSignalSnapshot(snapshot, aggregateNews);

    for (const type of SIGNAL_TYPES) {
      const history = this.history[type] || [];
      const latest = history.at(-1);
      if (latest?.timestamp === timestamp && latest?.value === values[type]) {
        continue;
      }

      history.push({
        timestamp,
        value: Number(values[type] || 0)
      });
      this.history[type] = trimHistory(history, this.baselineDays * 24 * 60 * 60 * 1_000);
    }
  }

  getAnomalies({ activeWindowHours = 2, baselineDays = this.baselineDays } = {}) {
    const nowMs = Date.now();
    const activeThresholdMs = nowMs - Math.max(1, activeWindowHours) * 60 * 60 * 1_000;
    const baselineThresholdMs = nowMs - Math.max(1, baselineDays) * 24 * 60 * 60 * 1_000;

    const items = SIGNAL_TYPES.map((type) => {
      const history = (this.history[type] || []).filter((entry) => {
        const timestampMs = new Date(entry.timestamp || 0).getTime();
        return Number.isFinite(timestampMs) && timestampMs >= baselineThresholdMs;
      });
      const activeValues = history
        .filter((entry) => new Date(entry.timestamp || 0).getTime() >= activeThresholdMs)
        .map((entry) => Number(entry.value || 0));
      const baselineValues = history
        .filter((entry) => new Date(entry.timestamp || 0).getTime() < activeThresholdMs)
        .map((entry) => Number(entry.value || 0));
      const baseline = welfordVariance(baselineValues);
      const currentValue = Number(mean(activeValues).toFixed(2));
      const zScore = baseline.stddev > 0 ? Number(((currentValue - baseline.mean) / baseline.stddev).toFixed(2)) : 0;
      const zeroVarianceSpike = baseline.stddev === 0 && baseline.count > 0 && currentValue >= baseline.mean + 2;
      const anomalyScore = Number(
        Math.max(0, Math.min(100, zeroVarianceSpike ? 82 : 50 + zScore * 15)).toFixed(2)
      );

      return {
        signalType: type,
        currentValue,
        baselineMean: Number(baseline.mean.toFixed(2)),
        baselineStddev: Number(baseline.stddev.toFixed(2)),
        zScore,
        anomalyScore,
        isAnomalous:
          currentValue > baseline.mean &&
          (zScore >= 1.2 || zeroVarianceSpike || (baseline.count < 2 && currentValue >= 2)),
        samples: {
          active: activeValues.length,
          baseline: baseline.count
        }
      };
    })
      .filter((item) => item.samples.active > 0 || item.samples.baseline > 0)
      .sort((left, right) => right.anomalyScore - left.anomalyScore);

    return {
      generatedAt: new Date().toISOString(),
      window: {
        activeWindowHours,
        baselineDays
      },
      items
    };
  }
}
