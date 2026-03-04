import test from "node:test";
import assert from "node:assert/strict";
import { classifyRisk, computeCountryRisk } from "../services/riskEngineService.js";

test("classifyRisk respects threshold boundaries", () => {
  assert.equal(classifyRisk(20), "Stable");
  assert.equal(classifyRisk(21), "Monitoring");
  assert.equal(classifyRisk(40), "Monitoring");
  assert.equal(classifyRisk(41), "Elevated");
  assert.equal(classifyRisk(70), "Elevated");
  assert.equal(classifyRisk(71), "Critical");
});

test("computeCountryRisk applies deterministic formula", () => {
  const articles = [
    {
      countryMentions: ["RU"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 3, tags: [{ tag: "Military", count: 1 }] }
    },
    {
      countryMentions: ["RU"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 3, tags: [{ tag: "Military", count: 1 }] }
    },
    {
      countryMentions: ["RU"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 3, tags: [{ tag: "Military", count: 1 }] }
    },
    {
      countryMentions: ["RU"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 3, tags: [{ tag: "Military", count: 1 }] }
    },
    {
      countryMentions: ["RU"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 3, tags: [{ tag: "Military", count: 1 }] }
    }
  ];

  const result = computeCountryRisk({ articles });
  const russia = result.countries.RU;

  assert.equal(russia.metrics.newsVolume, 5);
  assert.equal(russia.metrics.negativeSentiment, 5);
  assert.equal(russia.metrics.conflictTagWeight, 15);
  assert.equal(russia.score, 85);
  assert.equal(russia.level, "Critical");
});
