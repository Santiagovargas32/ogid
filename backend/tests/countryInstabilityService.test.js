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
});
