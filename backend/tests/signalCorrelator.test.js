import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SignalCorrelatorService, welfordVariance } from "../services/intel/signalCorrelator.js";

test("welford variance returns stable statistics for rolling baselines", () => {
  const result = welfordVariance([1, 2, 3, 4, 5]);
  assert.equal(result.count, 5);
  assert.equal(Number(result.mean.toFixed(2)), 3);
  assert.ok(result.stddev > 0);
});

test("signal correlator withholds scores until the hourly baseline is sufficient", () => {
  const now = Date.now();
  const service = new SignalCorrelatorService({ now: () => now });
  const baseTimestamp = now - 3 * 60 * 60 * 1_000;

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
  assert.equal(newsAnomaly.status, "insufficient_baseline");
  assert.equal(newsAnomaly.isAnomalous, false);
  assert.equal(newsAnomaly.anomalyScore, null);
});

test("signal correlator rejects a baseline window that cannot contain the required buckets", () => {
  const now = Date.now();
  const service = new SignalCorrelatorService({ now: () => now });
  service.history.news.push({ timestamp: new Date(now).toISOString(), value: 2, byCountry: { US: 2 } });
  const anomalies = service.getAnomalies({ activeWindowHours: 2, baselineDays: 1, countries: ["US"] });
  const news = anomalies.items.find((item) => item.signalType === "news");
  assert.equal(anomalies.configuration.valid, false);
  assert.equal(news.status, "invalid_window");
  assert.equal(news.anomalyScore, null);
});

test("signal correlator flags a spike after 24 hourly baseline buckets", () => {
  const now = Date.now();
  const service = new SignalCorrelatorService({ now: () => now });
  for (let index = 0; index < 24; index += 1) {
    service.history.news.push({
      timestamp: new Date(now - (index + 3) * 60 * 60 * 1_000).toISOString(),
      value: 1,
      byCountry: { US: 1 }
    });
  }
  service.history.news.push({ timestamp: new Date(now).toISOString(), value: 9, byCountry: { US: 9 } });

  const newsAnomaly = service.getAnomalies({ activeWindowHours: 2, baselineDays: 7, countries: ["US"] })
    .items.find((item) => item.signalType === "news");
  assert.equal(newsAnomaly.status, "ready");
  assert.equal(newsAnomaly.isAnomalous, true);
  assert.ok(newsAnomaly.anomalyScore > 50);
});

test("signal correlator upserts one UTC hourly bucket and hydrates persisted history", () => {
  const root = mkdtempSync(join(tmpdir(), "ogid-signal-history-"));
  const persistencePath = join(root, "signal-history.json");
  const now = Date.parse("2026-07-21T12:55:00.000Z");
  try {
    const service = new SignalCorrelatorService({ persistencePath, now: () => now });
    service.recordSnapshot(
      { meta: { lastRefreshAt: "2026-07-21T12:10:00.000Z" }, signalCorpus: [] },
      { items: [{ id: "a", title: "First", url: "https://example.com/a", publishedAt: "2026-07-21T12:05:00.000Z", countryMentions: ["US"] }] }
    );
    service.recordSnapshot(
      { meta: { lastRefreshAt: "2026-07-21T12:50:00.000Z" }, signalCorpus: [] },
      { items: [
        { id: "old", title: "Previous hour", url: "https://example.com/old", publishedAt: "2026-07-21T11:50:00.000Z", countryMentions: ["US"] },
        { id: "a", title: "First", url: "https://example.com/a", publishedAt: "2026-07-21T12:05:00.000Z", countryMentions: ["US"] },
        { id: "b", title: "Second", url: "https://example.com/b", publishedAt: "2026-07-21T12:40:00.000Z", countryMentions: ["US"] }
      ] }
    );
    assert.equal(service.history.news.length, 1);
    assert.equal(service.history.news[0].value, 2);

    const hydrated = new SignalCorrelatorService({ persistencePath, now: () => now });
    assert.equal(hydrated.history.news.length, 1);
    assert.equal(hydrated.history.news[0].byCountry.US, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("signal correlator distinguishes 7-day and 30-day persisted baselines", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const service = new SignalCorrelatorService({ now: () => now });
  for (let offsetHours = 3; offsetHours < 51; offsetHours += 1) {
    service.history.news.push({
      timestamp: new Date(now - offsetHours * 60 * 60 * 1_000).toISOString(),
      value: 1,
      byCountry: { US: 1 }
    });
  }
  for (let offsetHours = 10 * 24; offsetHours < 11 * 24; offsetHours += 1) {
    service.history.news.push({
      timestamp: new Date(now - offsetHours * 60 * 60 * 1_000).toISOString(),
      value: 5,
      byCountry: { US: 5 }
    });
  }
  service.history.news.push({ timestamp: new Date(now).toISOString(), value: 10, byCountry: { US: 10 } });

  const sevenDays = service.getAnomalies({ countries: ["US"], baselineDays: 7 }).items.find((item) => item.signalType === "news");
  const thirtyDays = service.getAnomalies({ countries: ["US"], baselineDays: 30 }).items.find((item) => item.signalType === "news");
  assert.equal(sevenDays.status, "ready");
  assert.equal(thirtyDays.status, "ready");
  assert.equal(sevenDays.samples.baseline, 48);
  assert.equal(thirtyDays.samples.baseline, 72);
  assert.notEqual(sevenDays.baselineMean, thirtyDays.baselineMean);
  assert.notEqual(sevenDays.anomalyScore, thirtyDays.anomalyScore);
});
