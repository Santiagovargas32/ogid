import test from "node:test";
import assert from "node:assert/strict";
import { generatePredictions } from "../services/market/predictionEngineService.js";

test("generatePredictions builds deterministic sector and ticker outputs", () => {
  const now = new Date().toISOString();
  const articles = [
    {
      id: "a1",
      title: "Defense activity increases in region",
      description: "Military units move near disputed border.",
      content: "Markets monitor defense budget implications.",
      publishedAt: now,
      countryMentions: ["IL"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 8, tags: [{ tag: "Military", count: 2 }] }
    },
    {
      id: "a2",
      title: "Oil shipping routes face renewed pressure",
      description: "Tanker traffic slowed after security warnings.",
      content: "Oil traders react to route risks.",
      publishedAt: now,
      countryMentions: ["IR"],
      sentiment: { label: "negative" },
      conflict: { totalWeight: 6, tags: [{ tag: "Sanctions", count: 1 }] }
    }
  ];

  const predictions = generatePredictions({
    articles,
    countries: { IL: { level: "Critical" }, IR: { level: "Elevated" } },
    marketQuotes: {
      GD: { changePct: 1.2 },
      BA: { changePct: 0.8 },
      XOM: { changePct: -0.3 },
      SPY: { changePct: 0.1 }
    },
    tickers: ["GD", "BA", "XOM", "SPY"],
    inputMode: "mixed"
  });

  assert.equal(Array.isArray(predictions.sectors), true);
  assert.equal(Array.isArray(predictions.tickers), true);
  assert.equal(predictions.inputMode, "mixed");
  assert.ok(predictions.sectors.some((item) => item.sector === "defense"));
  assert.ok(predictions.tickers.some((item) => item.ticker === "GD"));
});
