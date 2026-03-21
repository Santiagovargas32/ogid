import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOsintEvents } from "../services/intel/osintFusion.js";
import { computeCountryInstability } from "../services/intel/countryInstabilityService.js";
import { computeHotspotEscalation } from "../services/intel/hotspotEscalationService.js";

test("fusion normalizes events and hotspot escalation ranks convergent countries", () => {
  const now = new Date().toISOString();
  const snapshot = {
    market: {
      updatedAt: now,
      quotes: {
        GD: { price: 200, changePct: 2.2, asOf: now, source: "twelve", synthetic: false }
      }
    },
    predictions: {
      updatedAt: now,
      tickers: [{ ticker: "GD", sector: "defense", confidence: 70, predictionScore: 8, direction: "Bullish" }]
    },
    signalCorpus: [
      {
        id: "sig-1",
        title: "Troop deployment intensifies near Kyiv",
        countryMentions: ["UA"],
        sourceName: "Reuters",
        publishedAt: now,
        conflict: { totalWeight: 5 }
      }
    ],
    countries: {
      UA: { score: 64, metrics: { conflictTagWeight: 5 } }
    }
  };

  const aggregateNews = {
    items: [
      {
        id: "rss-1",
        title: "Cyber incident and protest activity reported in Kyiv",
        countryMentions: ["UA"],
        sourceName: "BBC News",
        publishedAt: now,
        topicTags: ["cyber", "civil_unrest"],
        threatScore: 6,
        credibilityScore: 0.9
      }
    ]
  };

  const events = normalizeOsintEvents({ snapshot, aggregateNews, maxEvents: 50 });
  assert.ok(events.length >= 3);

  const countryInstability = computeCountryInstability({ snapshot, aggregateNews });
  const hotspots = computeHotspotEscalation({ fusedEvents: events, countryInstability });
  assert.ok(hotspots[0].hotspotScore >= 0);
});
