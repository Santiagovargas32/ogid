import test from "node:test";
import assert from "node:assert/strict";
import { buildEscalationHotspotsHtml } from "../../frontend/js/intelligence/escalationHotspots.js";
import { buildCountryInstabilityHtml } from "../../frontend/js/intelligence/riskEngine.js";
import { buildSignalAnomaliesHtml } from "../../frontend/js/intelligence/signalAnomalies.js";
import { buildWorldBriefHtml } from "../../frontend/js/intelligence/worldBrief.js";

test("advanced UI renders hotspot components and the CII explanation", () => {
  const payload = {
    window: { label: "last 24h" },
    corpus: { eventCount: 4, availableEventCount: 4 },
    hotspots: [{
      country: "United States",
      hotspotScore: 95.2,
      components: {
        news: { score: 100 },
        cii: { score: 80.8 },
        geo: { score: 100 },
        military: { score: 100 }
      },
      explanation: ["Weighted composite"]
    }],
    countryInstability: {
      sampleSize: 4,
      ranking: [{
        country: "United States",
        cii: 80.8,
        components: { baselineRisk: 70, unrestSignals: 80, securitySignals: 90, informationFlow: 85 },
        metrics: { sampleSize: 4 },
        explanation: { windowHours: 24, formula: "baselineRisk*0.40 + unrest*0.20 + security*0.20 + informationFlow*0.20" }
      }]
    }
  };
  const hotspotHtml = buildEscalationHotspotsHtml(payload);
  assert.match(hotspotHtml, /News 100\.0 .* CII 80\.8 .* Geo 100\.0 .* Military 100\.0/);
  assert.match(hotspotHtml, /Weighted composite/);
  const ciiHtml = buildCountryInstabilityHtml(payload);
  assert.match(ciiHtml, /4 country-linked articles/);
  assert.match(ciiHtml, /baselineRisk\*0\.40/);
});

test("advanced UI never renders an anomaly score before the baseline is ready", () => {
  const items = ["news", "military", "market", "cyber", "satellite", "prediction"].map((signalType) => ({
    signalType,
    status: "insufficient_baseline",
    currentValue: 1,
    baselineMean: null,
    anomalyScore: null,
    samples: { baseline: 4, requiredBaseline: 24, baselineSpanHours: 3, requiredSpanHours: 23 }
  }));
  const html = buildSignalAnomaliesHtml({ anomalies: { window: { activeWindowHours: 24, baselineDays: 7 }, items } });
  assert.equal((html.match(/Baseline insuficiente/g) || []).length, 6);
  assert.equal((html.match(/<strong>/g) || []).length, 0);
  assert.match(html, /prediction/);
});

test("World Brief links only safe related article URLs", () => {
  const base = {
    window: { label: "last 24h" },
    worldBrief: {
      leader: { country: "United States" },
      summary: "United States leads escalation monitoring.",
      drivers: [{ key: "news", score: 80, weight: 0.35, contribution: 28 }],
      articles: [
        { title: "Safe headline", url: "https://example.com/story", sourceName: "Wire" },
        { title: "Unsafe <headline>", url: "javascript:alert(1)", sourceName: "Wire" }
      ]
    }
  };
  const html = buildWorldBriefHtml(base);
  assert.match(html, /href="https:\/\/example\.com\/story"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /Unsafe &lt;headline&gt;/);
  assert.match(html, /contribution 28\.0/);
});
