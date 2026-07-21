import test from "node:test";
import assert from "node:assert/strict";
import { computeCountryInstability } from "../services/intel/countryInstabilityService.js";

test("country instability computes additive CII alongside the legacy country score", () => {
  const now = new Date().toISOString();
  const result = computeCountryInstability({
    snapshot: {
      countries: {
        IL: {
          score: 72,
          metrics: {
            conflictTagWeight: 6
          }
        }
      },
      signalCorpus: [
        {
          countryMentions: ["IL"],
          conflict: { totalWeight: 4 }
        }
      ]
    },
    aggregateNews: {
      items: [
        {
          countryMentions: ["IL"],
          credibilityScore: 0.92,
          threatScore: 8,
          topicTags: ["conflict", "civil_unrest"]
        }
      ]
    }
  });

  assert.ok(result.countries.IL.cii > 0);
  assert.equal(result.countries.IL.currentRiskScore, 72);
  assert.ok(result.countries.IL.components.baselineRisk > 0);
  assert.ok(result.countries.IL.components.securitySignals > 0);
  assert.equal(result.countries.IL.metrics.newsVelocity, 2);
});

test("country instability uses logarithmic normalization and the requested article window", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const result = computeCountryInstability({
    snapshot: { countries: { US: { score: 1530, metrics: {} } } },
    articles: [
      {
        title: "Recent conflict update",
        publishedAt: "2026-07-21T11:00:00.000Z",
        countryMentions: ["US"],
        topicTags: ["conflict"],
        credibilityScore: 0.9,
        threatScore: 6
      },
      {
        title: "Old conflict update",
        publishedAt: "2026-07-18T11:00:00.000Z",
        countryMentions: ["US"],
        topicTags: ["conflict"],
        credibilityScore: 0.9,
        threatScore: 6
      }
    ],
    windowHours: 24,
    now
  });

  assert.equal(result.countries.US.metrics.newsVelocity, 1);
  assert.ok(result.countries.US.components.baselineRisk < 100);
  assert.equal(result.windowHours, 24);
});
