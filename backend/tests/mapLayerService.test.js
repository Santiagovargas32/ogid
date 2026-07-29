import test from "node:test";
import assert from "node:assert/strict";
import { MapLayerService } from "../services/map/mapLayerService.js";
import { getCountryByIso2 } from "../utils/countryCatalog.js";

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

test("map seeds use catalog-backed country codes and never label synthetic scaffolds as live", async () => {
  const service = new MapLayerService({
    stateManager: { getSnapshot: () => ({ ...buildStateSnapshot(), signalCorpus: [], news: [] }) },
    rssAggregator: { getSnapshot: async () => ({ items: [], meta: {} }) }
  });
  const bundle = await service.getLayerBundle({
    layerIds: [
      "datacenters",
      "strategic_ports",
      "airports",
      "refineries",
      "critical_minerals",
      "shipping_chokepoints",
      "strategic_chokepoints",
      "space_assets",
      "undersea_cables",
      "pipelines",
      "trade_routes",
      "ports_congestion",
      "protests"
    ],
    timeWindow: "24h"
  });
  const featureByTitle = (layerId, title) =>
    bundle.layers.find((layer) => layer.id === layerId).features.find((feature) => feature.title === title);
  const datacenters = bundle.layers.find((layer) => layer.id === "datacenters");
  const countriesByName = Object.fromEntries(datacenters.features.map((feature) => [feature.title, feature.properties.country]));
  assert.equal(countriesByName["London Exchange Cluster"], "GB");
  assert.equal(countriesByName["Frankfurt IX Hub"], "DE");
  assert.equal(countriesByName["Singapore Digital Hub"], "SG");
  assert.equal(countriesByName["Dubai Cloud Corridor"], "AE");
  assert.equal(featureByTitle("strategic_ports", "Port of Singapore").properties.country, "SG");
  assert.equal(featureByTitle("strategic_ports", "Jebel Ali").properties.country, "AE");
  assert.equal(featureByTitle("strategic_ports", "Port of Rotterdam").properties.country, "NL");
  assert.equal(featureByTitle("airports", "Heathrow").properties.country, "GB");
  assert.equal(featureByTitle("airports", "Dubai Intl").properties.country, "AE");
  assert.equal(featureByTitle("refineries", "Ras Tanura").properties.country, "SA");
  assert.equal(featureByTitle("critical_minerals", "Katanga Copper Belt").properties.country, "CD");
  const lithiumTriangle = featureByTitle("critical_minerals", "Lithium Triangle");
  assert.equal(lithiumTriangle.properties.country, "AR");
  assert.deepEqual(lithiumTriangle.properties.countries, ["AR", "BO", "CL"]);
  assert.equal(lithiumTriangle.properties.geoPrecision, "regional");
  assert.equal(lithiumTriangle.properties.approximate, true);
  assert.equal(featureByTitle("shipping_chokepoints", "Suez Canal").properties.country, "EG");
  const malacca = featureByTitle("shipping_chokepoints", "Strait of Malacca");
  assert.equal(malacca.properties.country, "MY");
  assert.deepEqual(malacca.properties.countries, ["MY", "SG", "ID"]);
  assert.equal(featureByTitle("strategic_chokepoints", "Suez Canal Corridor").properties.country, "EG");
  assert.equal(featureByTitle("strategic_chokepoints", "Panama Canal").properties.country, "PA");
  assert.equal(featureByTitle("space_assets", "Baikonur Launch Complex").properties.country, "KZ");
  assert.deepEqual(featureByTitle("undersea_cables", "Transatlantic Fiber Arc").properties.countries, ["US", "GB"]);
  assert.deepEqual(featureByTitle("undersea_cables", "MENA-Europe Cable").properties.countries, ["AE", "EG", "IT"]);
  assert.deepEqual(featureByTitle("pipelines", "Gulf Export Corridor").properties.countries, ["SA", "AE"]);
  assert.deepEqual(featureByTitle("trade_routes", "Atlantic Shipping Arc").properties.countries, ["US", "NL"]);
  assert.equal(bundle.layers.find((layer) => layer.id === "ports_congestion").features.find((feature) => feature.title === "Singapore Queue").properties.country, "SG");
  assert.ok(datacenters.features.every((feature) => feature.properties.dataMode === "seeded"));
  assert.ok(
    bundle.layers
      .flatMap((layer) => layer.features)
      .flatMap((feature) => feature.properties?.countries || [])
      .every((iso2) => getCountryByIso2(iso2))
  );
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
  assert.equal(vessel.verificationStatus, "source-reported-location-match");
  assert.equal(vessel.geoPrecision, "approximate");
  assert.equal(vessel.locationMethod, "seed-to-reported-coordinate-blend");
  assert.ok(vessel.evidenceBasis.directCoordinateCount > 0);
});

test("null article coordinates remain country-level evidence instead of becoming zero-zero", async () => {
  const now = new Date().toISOString();
  const snapshot = {
    ...buildStateSnapshot(),
    meta: { lastRefreshAt: now },
    signalCorpus: [
      {
        id: "null-coordinate-vessel",
        title: "Carrier strike group sighted near Hormuz",
        description: "Naval patrol activity continues in the Gulf.",
        countryMentions: ["IR"],
        sourceName: "Test Wire",
        provider: "rss",
        publishedAt: now,
        lat: null,
        lng: null,
        topicTags: ["conflict", "shipping"],
        credibilityScore: 0.9
      }
    ],
    news: []
  };
  const service = new MapLayerService({
    stateManager: {
      getSnapshot: () => snapshot,
      getSignalCorpus: () => snapshot.signalCorpus
    },
    rssAggregator: { getSnapshot: async () => ({ items: [], meta: {} }) }
  });

  const assets = await service.getDashboardMapAssets({ snapshot, signalCorpus: snapshot.signalCorpus });
  const vessel = assets.movingSeeds.find((asset) => asset.layerId === "naval_vessels");

  assert.ok(vessel);
  assert.equal(vessel.status, "country-inferred");
  assert.equal(vessel.verificationStatus, "country-correlation");
  assert.equal(vessel.positionMode, "country-inferred");
  assert.equal(vessel.geoPrecision, "country-level");
  assert.equal(vessel.locationMethod, "seed-to-country-centroid-blend");
  assert.equal(vessel.evidenceBasis.directCoordinateCount, 0);
  assert.equal(vessel.evidenceBasis.countryInferredCount, 1);
});

test("regional nested coordinates remain approximate and cannot confirm a moving seed", async () => {
  const now = new Date().toISOString();
  const regionalLocation = { lat: 26.65, lng: 56.05, precision: "region", method: "source-region" };
  const snapshot = {
    ...buildStateSnapshot(),
    signalCorpus: [
      {
        id: "regional-vessel",
        title: "Carrier strike group sighted near Hormuz",
        countryMentions: ["IR"],
        publishedAt: now,
        location: regionalLocation,
        topicTags: ["conflict", "shipping"]
      },
      {
        id: "regional-protest",
        title: "Protest reported near Hormuz",
        countryMentions: ["IR"],
        publishedAt: now,
        location: regionalLocation
      }
    ],
    news: []
  };
  const service = new MapLayerService({
    stateManager: {
      getSnapshot: () => snapshot,
      getSignalCorpus: () => snapshot.signalCorpus
    },
    rssAggregator: { getSnapshot: async () => ({ items: [], meta: {} }) }
  });

  const assets = await service.getDashboardMapAssets({ snapshot, signalCorpus: snapshot.signalCorpus });
  const vessel = assets.movingSeeds.find((asset) => asset.layerId === "naval_vessels");
  assert.equal(vessel.status, "country-inferred");
  assert.equal(vessel.positionMode, "country-inferred");
  assert.equal(vessel.evidenceBasis.directCoordinateCount, 0);

  const bundle = await service.getLayerBundle({ layerIds: ["protests"], timeWindow: "24h" });
  const protest = bundle.layers[0].features.find((feature) => feature.title === "Protest reported near Hormuz");
  assert.deepEqual(protest.geometry.coordinates, [regionalLocation.lng, regionalLocation.lat]);
  assert.equal(protest.properties.geoPrecision, "region");
  assert.equal(protest.properties.locationMethod, "source-region");
  assert.equal(protest.properties.verificationStatus, "source-reported-approximate");
});

test("out-of-range article coordinates fall back to an explicit country centroid", async () => {
  const snapshot = {
    ...buildStateSnapshot(),
    signalCorpus: [
      {
        id: "invalid-coordinate-protest",
        title: "Protest reported in Iran",
        countryMentions: ["IR"],
        publishedAt: new Date().toISOString(),
        lat: 95,
        lng: 220,
        conflict: { totalWeight: 1, tags: [] }
      }
    ],
    news: []
  };
  const service = new MapLayerService({
    stateManager: {
      getSnapshot: () => snapshot,
      getSignalCorpus: () => snapshot.signalCorpus
    },
    rssAggregator: { getSnapshot: async () => ({ items: [], meta: {} }) }
  });

  const bundle = await service.getLayerBundle({ layerIds: ["protests"], timeWindow: "24h" });
  const feature = bundle.layers[0].features.find((item) => item.title === "Protest reported in Iran");

  assert.ok(feature);
  assert.equal(feature.properties.country, "IR");
  assert.equal(feature.properties.geoPrecision, "country-level");
  assert.equal(feature.properties.locationMethod, "country-inference");
  assert.ok(feature.geometry.coordinates[0] >= -180 && feature.geometry.coordinates[0] <= 180);
  assert.ok(feature.geometry.coordinates[1] >= -90 && feature.geometry.coordinates[1] <= 90);
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
