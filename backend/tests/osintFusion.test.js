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

test("fusion deduplicates by article-country-type before enforcing the common window", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const shared = {
    id: "pipeline-id",
    title: "Cyber alert in Washington",
    url: "https://example.com/shared",
    publishedAt: "2026-07-21T11:00:00.000Z",
    countryMentions: ["US"],
    topicTags: ["cyber"]
  };
  const events = normalizeOsintEvents({
    snapshot: {
      signalCorpus: [shared],
      market: { quotes: {} },
      predictions: { tickers: [] }
    },
    aggregateNews: {
      items: [
        { ...shared, id: "rss-id" },
        { ...shared, id: "old", url: "https://example.com/old", publishedAt: "2026-07-18T11:00:00.000Z" }
      ]
    },
    maxEvents: 50,
    windowHours: 24,
    now
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].country, "US");
  assert.equal(events[0].event_type, "cyber");
});

test("fusion preserves distinct article-country event types and normalizes news severity", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const shared = {
    title: "Cyber and conflict alert",
    url: "https://example.com/multi-type",
    publishedAt: new Date(now).toISOString(),
    countryMentions: ["US"],
    topicTags: ["cyber", "conflict"],
    threatScore: 8
  };
  const events = normalizeOsintEvents({
    snapshot: { signalCorpus: [shared], market: { quotes: {} }, predictions: { tickers: [] } },
    windowHours: 24,
    now
  });
  assert.deepEqual(events.map((item) => item.event_type).sort(), ["conflict", "cyber"]);
  assert.equal(events.every((item) => item.severity >= 60 && item.severity <= 100), true);
});
