import test from "node:test";
import assert from "node:assert/strict";
import { MapLayerService } from "../services/map/mapLayerService.js";

function buildStateSnapshot() {
  const now = new Date().toISOString();
  return {
    meta: { lastRefreshAt: now },
    hotspots: [
      {
        iso2: "IL",
        country: "Israel",
        lat: 31.7683,
        lng: 35.2137,
        score: 76,
        level: "Critical",
        updatedAt: now,
        metrics: { newsVolume: 8, negativeSentiment: 4, conflictTagWeight: 7 },
        topTags: [{ tag: "Military", count: 3 }]
      }
    ],
    signalCorpus: [
      {
        id: "article-1",
        title: "Large protest erupts in Tel Aviv",
        description: "Security forces monitor demonstrations.",
        countryMentions: ["IL"],
        sourceName: "BBC News",
        provider: "newsapi",
        publishedAt: now,
        conflict: { totalWeight: 2, tags: [] },
        sentiment: { label: "negative" }
      },
      {
        id: "article-2",
        title: "Cyber attack disrupts Kyiv infrastructure",
        description: "Officials investigate the intrusion.",
        countryMentions: ["UA"],
        sourceName: "Reuters",
        provider: "newsapi",
        publishedAt: now,
        conflict: { totalWeight: 0, tags: [{ tag: "Cyber Operations", count: 1 }] },
        sentiment: { label: "negative" }
      },
      {
        id: "article-3",
        title: "Carrier strike group sighted near Hormuz",
        description: "Naval assets continue patrol operations in the Gulf.",
        countryMentions: ["IR"],
        sourceName: "Reuters",
        provider: "rss",
        publishedAt: now,
        lat: 26.7,
        lng: 56.1,
        topicTags: ["conflict", "shipping"],
        credibilityScore: 0.97,
        conflict: { totalWeight: 3, tags: [{ tag: "Maritime", count: 1 }] },
        sentiment: { label: "negative" }
      }
    ],
    news: []
  };
}

test("map layer service exposes the registry-first 45-layer config", () => {
  const service = new MapLayerService({
    stateManager: {
      getSnapshot: () => buildStateSnapshot(),
      getSignalCorpus: () => buildStateSnapshot().signalCorpus
    },
    rssAggregator: {
      getSnapshot: async () => ({ items: [], meta: {} })
    }
  });

  const config = service.getConfig();
  assert.equal(config.engine.default, "leaflet");
  assert.equal(config.layers.length, 45);
  assert.ok(config.presets.some((preset) => preset.id === "MENA"));
  assert.ok(config.timeWindows.some((window) => window.id === "7d"));
});

test("map layer service resolves live and seeded bundles without hitting the network", async () => {
  const service = new MapLayerService({
    stateManager: {
      getSnapshot: () => buildStateSnapshot(),
      getSignalCorpus: () => buildStateSnapshot().signalCorpus
    },
    rssAggregator: {
      getSnapshot: async () => ({
        items: [
          {
            id: "rss-1",
            title: "Missile test raises tensions",
            countryMentions: ["IR"],
            sourceName: "Reuters",
            credibilityScore: 0.98,
            threatLevel: "critical",
            publishedAt: new Date().toISOString(),
            topicTags: ["conflict"]
          }
        ],
        meta: {}
      })
    }
  });

  const bundle = await service.getLayerBundle({
    layerIds: ["conflicts", "protests", "cyber_incidents", "military_bases"],
    timeWindow: "24h"
  });

  assert.equal(bundle.layers.length, 4);
  assert.ok(bundle.layers.find((layer) => layer.id === "conflicts")?.featureCount > 0);
  assert.ok(bundle.layers.find((layer) => layer.id === "protests")?.featureCount > 0);
  assert.ok(bundle.layers.find((layer) => layer.id === "cyber_incidents")?.featureCount > 0);
  assert.ok(bundle.layers.find((layer) => layer.id === "military_bases")?.featureCount > 0);
});

test("map seeds use confirmed country codes and never label synthetic scaffolds as live", async () => {
  const service = new MapLayerService({
    stateManager: { getSnapshot: () => ({ ...buildStateSnapshot(), signalCorpus: [], news: [] }) },
    rssAggregator: { getSnapshot: async () => ({ items: [], meta: {} }) }
  });
  const bundle = await service.getLayerBundle({ layerIds: ["datacenters", "strategic_ports", "airports", "ports_congestion", "protests"], timeWindow: "24h" });
  const datacenters = bundle.layers.find((layer) => layer.id === "datacenters");
  const countriesByName = Object.fromEntries(datacenters.features.map((feature) => [feature.title, feature.properties.country]));
  assert.equal(countriesByName["London Exchange Cluster"], "GB");
  assert.equal(countriesByName["Frankfurt IX Hub"], "DE");
  assert.equal(countriesByName["Singapore Digital Hub"], "SG");
  assert.equal(countriesByName["Dubai Cloud Corridor"], "AE");
  assert.equal(bundle.layers.find((layer) => layer.id === "strategic_ports").features.find((feature) => feature.title === "Port of Singapore").properties.country, "SG");
  assert.equal(bundle.layers.find((layer) => layer.id === "airports").features.find((feature) => feature.title === "Dubai Intl").properties.country, "AE");
  assert.equal(bundle.layers.find((layer) => layer.id === "ports_congestion").features.find((feature) => feature.title === "Singapore Queue").properties.country, "SG");
  assert.ok(datacenters.features.every((feature) => feature.properties.dataMode === "seeded"));
  assert.equal(bundle.layers.find((layer) => layer.id === "protests").implementation, "synthetic");
});

test("map layer service builds dashboard map assets with static and moving seeds", async () => {
  const snapshot = buildStateSnapshot();
  const service = new MapLayerService({
    stateManager: {
      getSnapshot: () => snapshot,
      getSignalCorpus: () => snapshot.signalCorpus
    },
    rssAggregator: {
      getSnapshot: async () => ({
        items: [
          {
            id: "rss-vessel",
            title: "Carrier strike group sighted near Hormuz",
            description: "Naval patrol activity intensifies in the Gulf.",
            countryMentions: ["IR"],
            sourceName: "Reuters",
            provider: "rss",
            publishedAt: snapshot.meta.lastRefreshAt,
            lat: 26.62,
            lng: 56.08,
            credibilityScore: 0.98,
            topicTags: ["conflict", "shipping"]
          }
        ],
        generatedAt: snapshot.meta.lastRefreshAt,
        meta: {}
      })
    }
  });

  const assets = await service.getDashboardMapAssets({ snapshot, signalCorpus: snapshot.signalCorpus });

  assert.ok(Array.isArray(assets.staticPoints));
  assert.ok(Array.isArray(assets.movingSeeds));
  assert.ok(assets.staticPoints.length > 0);
  assert.ok(assets.movingSeeds.length > 0);
  assert.ok(assets.staticPoints.some((asset) => asset.styleKey === "space_launch_sites"));
  assert.ok(assets.movingSeeds.some((asset) => asset.styleKey === "space_orbital_passes"));
  const menaFacility = assets.staticPoints.find((asset) => asset.layerId === "military_bases" && asset.hostCountry);
  assert.ok(menaFacility);
  assert.equal(typeof menaFacility.facilityType, "string");
  assert.equal(typeof menaFacility.iconKey, "string");
  assert.equal(typeof menaFacility.approximate, "boolean");
  assert.equal(menaFacility.alwaysVisible, true);
  const vessel = assets.movingSeeds.find((asset) => asset.layerId === "naval_vessels");
  assert.ok(vessel);
  assert.notEqual(vessel.status, "seeded");
  assert.ok(vessel.linkedArticleCount > 0);
});

test("map layer service tolerates invalid external article timestamps", async () => {
  const snapshot = { ...buildStateSnapshot(), signalCorpus: [], news: [] };
  const service = new MapLayerService({
    stateManager: {
      getSnapshot: () => snapshot,
      getSignalCorpus: () => []
    }
  });

  const assets = await service.getDashboardMapAssets({
    snapshot,
    signalCorpus: [],
    rssSnapshot: {
      items: [
        {
          id: "invalid-timestamp-rss",
          title: "Carrier strike group sighted near Hormuz",
          description: "Naval patrol activity intensifies in the Gulf.",
          countryMentions: ["IR"],
          provider: "rss",
          publishedAt: "not-a-date",
          topicTags: ["conflict", "shipping"]
        }
      ]
    }
  });

  const vessel = assets.movingSeeds.find((asset) => asset.layerId === "naval_vessels");
  assert.ok(vessel);
  assert.equal(new Date(vessel.lastEvidenceAt).toISOString(), vessel.lastEvidenceAt);
});
