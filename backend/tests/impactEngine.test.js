import test from "node:test";
import assert from "node:assert/strict";
import { computeMarketImpact } from "../services/market/impactEngineService.js";

test("computeMarketImpact returns deterministic impact items", () => {
  const now = new Date().toISOString();
  const articles = [
    {
      id: "n1",
      title: "Israel conflict escalation impacts regional security",
      description: "Military incidents and sanctions concerns increase risk.",
      content: "Defense and oil markets monitor the situation.",
      publishedAt: now,
      countryMentions: ["IL", "IR"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 8 }
    }
  ];
  const countries = {
    IL: { level: "Critical" },
    IR: { level: "Elevated" }
  };
  const marketQuotes = {
    GD: { price: 280, changePct: 1.4, asOf: now, source: "fallback" },
    BA: { price: 200, changePct: -0.9, asOf: now, source: "fallback" }
  };

  const impact = computeMarketImpact({
    articles,
    countries,
    marketQuotes,
    tickers: ["GD", "BA"],
    countryFilter: ["IL", "IR"],
    windowMin: 120,
    inputMode: "mixed"
  });

  assert.equal(Array.isArray(impact.items), true);
  assert.equal(impact.items.length, 2);
  assert.ok(impact.items[0].impactScore >= impact.items[1].impactScore);
  assert.equal(Array.isArray(impact.sectorBreakdown), true);
  assert.equal(Array.isArray(impact.scatterPoints), true);
  assert.equal(impact.inputMode, "mixed");
});
