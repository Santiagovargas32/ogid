import test from "node:test";
import assert from "node:assert/strict";
import { SignalCorrelatorService, welfordVariance } from "../services/intel/signalCorrelator.js";

test("welford variance returns stable statistics for rolling baselines", () => {
  const result = welfordVariance([1, 2, 3, 4, 5]);
  assert.equal(result.count, 5);
  assert.equal(Number(result.mean.toFixed(2)), 3);
  assert.ok(result.stddev > 0);
});

test("signal correlator flags spikes versus the 7-day baseline", () => {
  const service = new SignalCorrelatorService();
  const baseTimestamp = Date.now() - 3 * 60 * 60 * 1_000;

  for (let index = 0; index < 12; index += 1) {
    service.history.news.push({
      timestamp: new Date(baseTimestamp - index * 60 * 60 * 1_000).toISOString(),
      value: 1
    });
  }

  service.history.news.push({
    timestamp: new Date().toISOString(),
    value: 9
  });

  const anomalies = service.getAnomalies({ activeWindowHours: 2, baselineDays: 7 });
  const newsAnomaly = anomalies.items.find((item) => item.signalType === "news");
  assert.ok(newsAnomaly);
  assert.equal(newsAnomaly.isAnomalous, true);
  assert.ok(newsAnomaly.anomalyScore > 50);
});
