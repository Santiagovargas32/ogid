import { createHash } from "node:crypto";
import { createLogger } from "../../utils/logger.js";
import { BASELINE_COUNTRIES, buildBaselineCountryMap } from "../../utils/countryCatalog.js";
import { BoundedCache } from "../shared/boundedCache.js";
import { getMapLayerDefinition, getMapPreset, getMapTimeWindow, listMapLayers, listMapPresets, listMapTimeWindows } from "./mapLayerRegistry.js";
import { buildMapThemeConfig } from "./mapThemeService.js";

const log = createLogger("backend/services/map/mapLayerService");
const countryIndex = buildBaselineCountryMap();

const STATIC_POINTS = Object.freeze({
  military_bases: [
    {
      id: "base-incirlik",
      name: "Incirlik Air Base",
      lat: 37.0017,
      lng: 35.4259,
      country: "TR",
      hostCountry: "TR",
      facilityType: "Air Base",
      iconKey: "facility-air-base",
      approximate: true,
      aliases: ["Adana Air Base"]
    },
    {
      id: "base-kurecik",
      name: "Kurecik Radar Site",
      lat: 38.349,
      lng: 37.794,
      country: "TR",
      hostCountry: "TR",
      facilityType: "Radar Facility",
      iconKey: "facility-radar",
      approximate: true,
      aliases: ["AN/TPY-2 Radar", "Kurecik"]
    },
    {
      id: "base-muwaffaq-salti",
      name: "Muwaffaq Salti Air Base",
      lat: 31.831,
      lng: 36.782,
      country: "JO",
      hostCountry: "JO",
      facilityType: "Air Base",
      iconKey: "facility-air-base",
      approximate: true,
      aliases: ["Azraq Air Base"]
    },
    {
      id: "base-tower-22",
      name: "Tower 22 Support Site",
      lat: 33.372,
      lng: 38.793,
      country: "JO",
      hostCountry: "JO",
      facilityType: "Outpost",
      iconKey: "facility-outpost",
      approximate: true,
      aliases: ["Tower 22", "Jordan Border Support Site"]
    },
    {
      id: "base-al-tanf",
      name: "Al Tanf Garrison",
      lat: 33.488,
      lng: 38.618,
      country: "SY",
      hostCountry: "SY",
      facilityType: "Outpost",
      iconKey: "facility-outpost",
      approximate: true,
      aliases: ["Al Tanf", "Tanf Garrison"]
    },
    {
      id: "base-conoco",
      name: "Conoco Mission Support Site",
      lat: 35.338,
      lng: 40.299,
      country: "SY",
      hostCountry: "SY",
      facilityType: "Outpost",
      iconKey: "facility-outpost",
      approximate: true,
      aliases: ["Conoco", "Deir ez-Zor Support Site"]
    },
    {
      id: "base-erbil",
      name: "Erbil Air Base",
      lat: 36.2376,
      lng: 43.9632,
      country: "IQ",
      hostCountry: "IQ",
      facilityType: "Air Base",
      iconKey: "facility-air-base",
      approximate: true,
      aliases: ["Erbil Air Base", "Harir Airfield"]
    },
    {
      id: "base-al-asad",
      name: "Al Asad Air Base",
      lat: 33.7856,
      lng: 42.4412,
      country: "IQ",
      hostCountry: "IQ",
      facilityType: "Air Base",
      iconKey: "facility-air-base",
      approximate: true,
      aliases: ["Ain al-Asad", "Al Assad"]
    },
    {
      id: "base-ali-al-salem",
      name: "Ali Al Salem Air Base",
      lat: 29.3467,
      lng: 47.5208,
      country: "KW",
      hostCountry: "KW",
      facilityType: "Air Base",
      iconKey: "facility-air-base",
      approximate: true,
      aliases: ["Ali Al Salem"]
    },
    {
      id: "base-camp-buehring",
      name: "Camp Buehring",
      lat: 29.702,
      lng: 47.728,
      country: "KW",
      hostCountry: "KW",
      facilityType: "Outpost",
      iconKey: "facility-outpost",
      approximate: true,
      aliases: ["Buehring", "Camp Buehring Kuwait"]
    },
    {
      id: "base-nsa-bahrain",
      name: "Naval Support Activity Bahrain",
      lat: 26.233,
      lng: 50.607,
      country: "BH",
      hostCountry: "BH",
      facilityType: "Naval Facility",
      iconKey: "facility-naval",
      approximate: true,
      aliases: ["NSA Bahrain", "Fifth Fleet Bahrain"]
    },
    {
      id: "base-al-dhafra",
      name: "Al Dhafra Air Base",
      lat: 24.2481,
      lng: 54.5477,
      country: "AE",
      hostCountry: "AE",
      facilityType: "Air Base",
      iconKey: "facility-air-base",
      approximate: true,
      aliases: ["Al Dhafra"]
    },
    {
      id: "base-jebel-ali",
      name: "Jebel Ali Port Facility",
      lat: 25.0113,
      lng: 55.0615,
      country: "AE",
      hostCountry: "AE",
      facilityType: "Naval Facility",
      iconKey: "facility-naval",
      approximate: true,
      aliases: ["Jebel Ali", "Dubai Port Facility"]
    },
    {
      id: "base-masirah",
      name: "Masirah Airfield",
      lat: 20.6754,
      lng: 58.8905,
      country: "OM",
      hostCountry: "OM",
      facilityType: "Air Base",
      iconKey: "facility-air-base",
      approximate: true,
      aliases: ["Masirah Island Airfield"]
    },
    {
      id: "base-thumrait",
      name: "Thumrait Air Base",
      lat: 17.667,
      lng: 54.024,
      country: "OM",
      hostCountry: "OM",
      facilityType: "Air Base",
      iconKey: "facility-air-base",
      approximate: true,
      aliases: ["Thumrait"]
    },
    {
      id: "base-camp-lemonnier",
      name: "Camp Lemonnier",
      lat: 11.5473,
      lng: 43.1595,
      country: "DJ",
      hostCountry: "DJ",
      facilityType: "Naval Facility",
      iconKey: "facility-naval",
      approximate: true,
      aliases: ["Camp Lemonnier Djibouti"]
    }
  ],
  datacenters: [
    { id: "dc-london", name: "London Exchange Cluster", lat: 51.5072, lng: -0.1276, country: "UA" },
    { id: "dc-frankfurt", name: "Frankfurt IX Hub", lat: 50.1109, lng: 8.6821, country: "UA" },
    { id: "dc-ashburn", name: "Ashburn Data Valley", lat: 39.0438, lng: -77.4874, country: "US" },
    { id: "dc-singapore", name: "Singapore Digital Hub", lat: 1.3521, lng: 103.8198, country: "CN" },
    { id: "dc-dubai", name: "Dubai Cloud Corridor", lat: 25.2048, lng: 55.2708, country: "IR" }
  ],
  strategic_ports: [
    { id: "port-singapore", name: "Port of Singapore", lat: 1.2644, lng: 103.8408, country: "CN" },
    { id: "port-jebel-ali", name: "Jebel Ali", lat: 25.0113, lng: 55.0605, country: "IR" },
    { id: "port-rotterdam", name: "Port of Rotterdam", lat: 51.9475, lng: 4.1333, country: "UA" },
    { id: "port-houston", name: "Port Houston", lat: 29.7304, lng: -95.2629, country: "US" },
    { id: "port-busan", name: "Port of Busan", lat: 35.1017, lng: 129.0403, country: "KR" }
  ],
  airports: [
    { id: "apt-heathrow", name: "Heathrow", lat: 51.47, lng: -0.4543, country: "UA" },
    { id: "apt-incheon", name: "Incheon", lat: 37.4602, lng: 126.4407, country: "KR" },
    { id: "apt-dxb", name: "Dubai Intl", lat: 25.2532, lng: 55.3657, country: "IR" },
    { id: "apt-jfk", name: "JFK", lat: 40.6413, lng: -73.7781, country: "US" },
    { id: "apt-del", name: "Delhi", lat: 28.5562, lng: 77.1, country: "IN" }
  ],
  refineries: [
    { id: "ref-jamnagar", name: "Jamnagar Refinery", lat: 22.4707, lng: 70.0577, country: "IN" },
    { id: "ref-ras-tanura", name: "Ras Tanura", lat: 26.6431, lng: 50.1596, country: "IR" },
    { id: "ref-houston", name: "Houston Refining Belt", lat: 29.7604, lng: -95.3698, country: "US" }
  ],
  power_plants: [
    { id: "pp-zap", name: "Zaporizhzhia Nuclear Plant", lat: 47.5108, lng: 34.5858, country: "UA" },
    { id: "pp-bushehr", name: "Bushehr Nuclear Plant", lat: 28.8291, lng: 50.8864, country: "IR" },
    { id: "pp-palo-verde", name: "Palo Verde", lat: 33.389, lng: -112.865, country: "US" }
  ],
  substations: [
    { id: "ss-kyiv", name: "Kyiv Grid Node", lat: 50.4547, lng: 30.5238, country: "UA" },
    { id: "ss-telaviv", name: "Tel Aviv Grid Node", lat: 32.0853, lng: 34.7818, country: "IL" },
    { id: "ss-dallas", name: "Dallas Grid Node", lat: 32.7767, lng: -96.797, country: "US" }
  ],
  critical_minerals: [
    { id: "cm-katanga", name: "Katanga Copper Belt", lat: -11.6647, lng: 27.4794, country: "SD" },
    { id: "cm-lithium-triangle", name: "Lithium Triangle", lat: -23.6509, lng: -66.049, country: "VE" },
    { id: "cm-mp", name: "Rare Earth Corridor", lat: 40.8436, lng: 97.623, country: "CN" }
  ],
  shipping_chokepoints: [
    { id: "chk-hormuz", name: "Strait of Hormuz", lat: 26.5667, lng: 56.25, country: "IR" },
    { id: "chk-bab-el-mandeb", name: "Bab el-Mandeb", lat: 12.5856, lng: 43.3333, country: "YE" },
    { id: "chk-malacca", name: "Strait of Malacca", lat: 2.5, lng: 101.5, country: "CN" },
    { id: "chk-suez", name: "Suez Canal", lat: 30.4167, lng: 32.35, country: "IL" }
  ],
  air_defense: [
    { id: "ad-negev", name: "Negev Air Defense Belt", lat: 31.252, lng: 34.7915, country: "IL" },
    { id: "ad-seoul", name: "Seoul SAM Ring", lat: 37.5665, lng: 126.978, country: "KR" },
    { id: "ad-kyiv", name: "Kyiv Air Defense Ring", lat: 50.4501, lng: 30.5234, country: "UA" }
  ],
  strategic_chokepoints: [
    { id: "sk-suez", name: "Suez Canal Corridor", lat: 30.4167, lng: 32.35, country: "IL" },
    { id: "sk-panama", name: "Panama Canal", lat: 9.080, lng: -79.680, country: "US" },
    { id: "sk-bosphorus", name: "Bosphorus", lat: 41.125, lng: 29.1, country: "TR" }
  ],
  ports_congestion: [
    { id: "pc-long-beach", name: "Long Beach Queue", lat: 33.7701, lng: -118.1937, country: "US" },
    { id: "pc-shanghai", name: "Shanghai Queue", lat: 31.2304, lng: 121.4737, country: "CN" },
    { id: "pc-singapore", name: "Singapore Queue", lat: 1.2644, lng: 103.8408, country: "CN" }
  ],
  space_assets: [
    { id: "sa-baikonur", name: "Baikonur Launch Complex", lat: 45.965, lng: 63.305, country: "RU" },
    { id: "sa-vandenberg", name: "Vandenberg", lat: 34.742, lng: -120.5724, country: "US" },
    { id: "sa-jiuquan", name: "Jiuquan", lat: 40.9606, lng: 100.2983, country: "CN" }
  ]
});

const STATIC_LINES = Object.freeze({
  undersea_cables: [
    {
      id: "cable-transatlantic",
      name: "Transatlantic Fiber Arc",
      coordinates: [
        [-74.006, 40.7128],
        [-32, 47],
        [-0.1276, 51.5072]
      ],
      countries: ["US", "UA"]
    },
    {
      id: "cable-mena-europe",
      name: "MENA-Europe Cable",
      coordinates: [
        [55.2708, 25.2048],
        [32.35, 30.4167],
        [14.2681, 40.8518]
      ],
      countries: ["IR", "IL", "UA"]
    }
  ],
  pipelines: [
    {
      id: "pipe-caspian",
      name: "Caspian Energy Route",
      coordinates: [
        [51.389, 35.6892],
        [44.793, 41.7151],
        [32.8597, 39.9334]
      ],
      countries: ["IR", "TR"]
    },
    {
      id: "pipe-gulf",
      name: "Gulf Export Corridor",
      coordinates: [
        [50.1596, 26.6431],
        [55.0605, 25.0113],
        [54.3773, 24.4539]
      ],
      countries: ["IR"]
    }
  ],
  trade_routes: [
    {
      id: "route-indo-pacific",
      name: "Indo-Pacific Trade Arc",
      coordinates: [
        [103.8408, 1.2644],
        [121.4737, 31.2304],
        [126.978, 37.5665]
      ],
      countries: ["CN", "KR"]
    },
    {
      id: "route-atlantic",
      name: "Atlantic Shipping Arc",
      coordinates: [
        [-95.2629, 29.7304],
        [-50, 35],
        [4.1333, 51.9475]
      ],
      countries: ["US", "UA"]
    }
  ],
  supply_chain: [
    {
      id: "sc-chip-corridor",
      name: "Semiconductor Chokepoint Route",
      coordinates: [
        [121.5654, 25.033],
        [126.978, 37.5665],
        [-121.8863, 37.3382]
      ],
      countries: ["TW", "KR", "US"]
    }
  ]
});

const MOVING_SEEDS = Object.freeze({
  naval_vessels: [
    { id: "vessel-1", name: "Carrier Strike Group", lat: 26.5, lng: 56, country: "IR" },
    { id: "vessel-2", name: "Mediterranean Task Group", lat: 34.5, lng: 18, country: "IL" },
    { id: "vessel-3", name: "Western Pacific Patrol", lat: 22, lng: 122, country: "TW" }
  ],
  aircraft_adsb: [
    { id: "aircraft-1", name: "ISR Orbit", lat: 31.8, lng: 35.2, country: "IL" },
    { id: "aircraft-2", name: "Strategic Bomber Track", lat: 37.5, lng: 127.5, country: "KR" },
    { id: "aircraft-3", name: "Reconnaissance Corridor", lat: 50.4, lng: 30.7, country: "UA" }
  ],
  space_assets: [
    { id: "space-1", name: "LEO Pass", lat: 8, lng: 36, country: "IR" },
    { id: "space-2", name: "ISR Satellite Track", lat: 28, lng: 58, country: "IR" }
  ]
});

const ARTICLE_KEYWORDS = Object.freeze({
  protests: ["protest", "riot", "demonstration", "uprising", "strike"],
  fires: ["fire", "wildfire", "burn", "blaze"],
  earthquakes: ["earthquake", "quake", "seismic"],
  cyber_incidents: ["cyber", "ransomware", "hacked", "malware", "outage"],
  sanctions: ["sanction", "export control", "asset freeze", "embargo"],
  satellite_launches: ["satellite launch", "rocket launch", "space launch", "orbital launch"],
  internet_outages: ["internet outage", "network outage", "shutdown", "telecom disruption"],
  disinformation: ["disinformation", "propaganda", "influence campaign", "misinformation"],
  elections: ["election", "vote", "ballot", "polling station"],
  refugee_flows: ["refugee", "displaced", "evacuation", "humanitarian corridor"],
  border_incidents: ["border clash", "border incident", "cross-border", "incursion"],
  terror_attacks: ["terror", "bombing", "insurgent", "extremist"],
  droughts: ["drought", "dry spell", "water shortage"],
  storms: ["storm", "cyclone", "typhoon", "hurricane"],
  floods: ["flood", "flash flood", "overflow"],
  disease_outbreaks: ["outbreak", "epidemic", "pandemic", "cholera", "avian influenza"],
  missile_tests: ["missile test", "ballistic missile", "launch test"],
  troop_movements: ["troop", "mobilization", "brigade", "deployment", "armored column"],
  food_security: ["food insecurity", "grain shortage", "aid shortage", "famine"],
  water_stress: ["water stress", "reservoir", "water shortage", "aquifer"],
  financial_shocks: ["tariff", "inflation shock", "default risk", "debt crisis", "market rout"],
  prediction_markets: ["prediction market", "odds imply", "forecast market"],
  commodity_prices: ["commodity", "brent", "lng", "wheat", "copper"],
  energy_markets: ["oil", "gas", "lng", "refinery", "energy market"],
  cable_outages: ["subsea cable", "cable cut", "fiber outage"],
  conflicts: ["conflict", "missile", "drone", "airstrike", "shelling"]
});

const DASHBOARD_STATIC_LAYER_RULES = Object.freeze({
  military_bases: Object.freeze({
    label: "US Facilities (MENA)",
    styleKey: "military_bases",
    keywords: ["military base", "air base", "garrison", "deployment", "airfield", "outpost", "radar site", "naval support activity"],
    topicTags: ["conflict"]
  }),
  datacenters: Object.freeze({
    label: "Datacenters",
    styleKey: "datacenters",
    keywords: ["data center", "datacenter", "cloud", "server farm", "exchange"],
    topicTags: ["cyber", "economics"]
  }),
  strategic_ports: Object.freeze({
    label: "Strategic Ports",
    styleKey: "strategic_ports",
    keywords: ["port", "harbor", "shipping", "maritime", "container terminal"],
    topicTags: ["shipping", "economics"]
  }),
  airports: Object.freeze({
    label: "Airports",
    styleKey: "airports",
    keywords: ["airport", "airfield", "aviation", "flight", "runway"],
    topicTags: ["conflict", "economics"]
  }),
  refineries: Object.freeze({
    label: "Refineries",
    styleKey: "refineries",
    keywords: ["refinery", "crude", "fuel terminal", "oil processing"],
    topicTags: ["energy"]
  }),
  power_plants: Object.freeze({
    label: "Power Plants",
    styleKey: "power_plants",
    keywords: ["power plant", "nuclear plant", "reactor", "grid outage", "energy facility"],
    topicTags: ["energy"]
  }),
  substations: Object.freeze({
    label: "Substations",
    styleKey: "substations",
    keywords: ["substation", "grid node", "transmission", "power grid"],
    topicTags: ["energy", "cyber"]
  }),
  critical_minerals: Object.freeze({
    label: "Critical Minerals",
    styleKey: "critical_minerals",
    keywords: ["lithium", "rare earth", "copper belt", "mine", "critical minerals"],
    topicTags: ["economics"]
  }),
  shipping_chokepoints: Object.freeze({
    label: "Shipping Chokepoints",
    styleKey: "shipping_chokepoints",
    keywords: ["strait", "canal", "maritime chokepoint", "shipping lane", "tanker"],
    topicTags: ["shipping", "conflict"]
  }),
  air_defense: Object.freeze({
    label: "Air Defense",
    styleKey: "air_defense",
    keywords: ["air defense", "sam", "missile defense", "interceptor"],
    topicTags: ["conflict"]
  }),
  strategic_chokepoints: Object.freeze({
    label: "Strategic Chokepoints",
    styleKey: "strategic_chokepoints",
    keywords: ["canal", "strait", "bottleneck", "corridor", "chokepoint"],
    topicTags: ["shipping", "conflict"]
  }),
  ports_congestion: Object.freeze({
    label: "Ports Congestion",
    styleKey: "ports_congestion",
    keywords: ["port congestion", "vessel queue", "queue", "anchorage", "berth delay"],
    topicTags: ["shipping", "economics"]
  }),
  space_assets: Object.freeze({
    label: "Launch Sites",
    styleKey: "space_launch_sites",
    keywords: ["launch site", "rocket launch", "spaceport", "launch complex", "orbital launch"],
    topicTags: ["space"]
  })
});

const DASHBOARD_MOVING_LAYER_RULES = Object.freeze({
  naval_vessels: Object.freeze({
    label: "Naval Vessels",
    styleKey: "naval_vessels",
    keywords: ["naval", "warship", "carrier", "destroyer", "frigate", "task group", "patrol"],
    topicTags: ["conflict", "shipping"],
    maxDriftKm: 1_100,
    syntheticLatScale: 0.45,
    syntheticLngScale: 0.75
  }),
  aircraft_adsb: Object.freeze({
    label: "Aircraft ADS-B",
    styleKey: "aircraft_adsb",
    keywords: ["aircraft", "flight", "bomber", "sortie", "reconnaissance", "isr", "patrol aircraft"],
    topicTags: ["conflict"],
    maxDriftKm: 850,
    syntheticLatScale: 0.45,
    syntheticLngScale: 0.75
  }),
  space_assets: Object.freeze({
    label: "Orbital Passes",
    styleKey: "space_orbital_passes",
    keywords: ["satellite", "orbit", "orbital", "leo", "spacecraft", "space asset", "pass"],
    topicTags: ["space"],
    maxDriftKm: 1_600,
    syntheticLatScale: 0.8,
    syntheticLngScale: 1.25
  })
});

const DASHBOARD_ASSET_STATUS = Object.freeze(["confirmed", "country-inferred", "seeded"]);
const DASHBOARD_ALIAS_STOPWORDS = new Set([
  "air",
  "base",
  "belt",
  "camp",
  "canal",
  "cluster",
  "complex",
  "corridor",
  "group",
  "grid",
  "hub",
  "intl",
  "international",
  "launch",
  "node",
  "of",
  "pass",
  "patrol",
  "plant",
  "port",
  "queue",
  "ring",
  "site",
  "station",
  "strait",
  "task",
  "the",
  "track"
]);
const EARTH_RADIUS_KM = 6_371;

function normalizeText(value = "") {
  return ` ${String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function normalizePhrase(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function hashValue(value = "") {
  return createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function toTimestamp(value) {
  const timestamp = new Date(value || Date.now()).toISOString();
  return Number.isNaN(new Date(timestamp).getTime()) ? new Date().toISOString() : timestamp;
}

function jitter(seed, scale = 0.24) {
  const digest = hashValue(seed);
  const numeric = Number.parseInt(digest.slice(0, 8), 16);
  return ((numeric % 2000) / 1000 - 1) * scale;
}

function numericOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function listToUpper(items = []) {
  return [...new Set((items || []).map((item) => String(item || "").trim().toUpperCase()).filter(Boolean))];
}

function resolveAssetHostCountry(item = {}) {
  return String(item.hostCountry || item.country || "").trim().toUpperCase();
}

function resolveAssetCountries(item = {}) {
  const hostCountry = resolveAssetHostCountry(item);
  if (Array.isArray(item.countries) && item.countries.length) {
    return listToUpper(item.countries);
  }
  return listToUpper([hostCountry]);
}

function sameCoordinates(left, right, epsilon = 0.06) {
  if (!left || !right) {
    return false;
  }

  return Math.abs(Number(left.lat) - Number(right.lat)) <= epsilon && Math.abs(Number(left.lng) - Number(right.lng)) <= epsilon;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const startLat = (lat1 * Math.PI) / 180;
  const endLat = (lat2 * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function interpolateCoordinate(start, end, weight = 0.5) {
  const factor = clamp(weight, 0, 1);
  return start + (end - start) * factor;
}

function interpolatePoint(start, end, weight = 0.5) {
  return {
    lat: interpolateCoordinate(Number(start.lat), Number(end.lat), weight),
    lng: interpolateCoordinate(Number(start.lng), Number(end.lng), weight)
  };
}

function clampToRadius(base, target, maxDistanceKm = 800) {
  const distanceKm = haversineKm(base.lat, base.lng, target.lat, target.lng);
  if (!Number.isFinite(distanceKm) || distanceKm <= maxDistanceKm) {
    return {
      lat: Number(target.lat),
      lng: Number(target.lng),
      distanceKm: Number.isFinite(distanceKm) ? distanceKm : 0
    };
  }

  const factor = clamp(maxDistanceKm / Math.max(distanceKm, 1), 0, 1);
  return {
    lat: interpolateCoordinate(base.lat, target.lat, factor),
    lng: interpolateCoordinate(base.lng, target.lng, factor),
    distanceKm: maxDistanceKm
  };
}

function bearingDegrees(start, end) {
  const lat1 = (Number(start.lat) * Math.PI) / 180;
  const lat2 = (Number(end.lat) * Math.PI) / 180;
  const lngDelta = ((Number(end.lng) - Number(start.lng)) * Math.PI) / 180;
  const y = Math.sin(lngDelta) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lngDelta);

  if (!Number.isFinite(x) || !Number.isFinite(y) || (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9)) {
    return null;
  }

  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function syntheticHeading(seed, phase) {
  const numeric = Number.parseInt(hashValue(`${seed}:${phase}:heading`).slice(0, 8), 16);
  return numeric % 360;
}

function uniqueEvidence(items = []) {
  const seen = new Set();
  const unique = [];
  for (const item of items || []) {
    const key = `${item.id}:${item.publishedAt}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function pushIndexed(map, key, value) {
  if (!key) {
    return;
  }

  const existing = map.get(key) || [];
  existing.push(value);
  map.set(key, existing);
}

function buildSeedAliases(name = "", aliases = []) {
  const normalizedName = normalizePhrase(name);
  const values = new Set();
  if (normalizedName) {
    values.add(normalizedName);
  }

  for (const alias of aliases || []) {
    const normalizedAlias = normalizePhrase(alias);
    if (normalizedAlias) {
      values.add(normalizedAlias);
    }
  }

  for (const token of normalizedName.split(" ")) {
    if (!token || token.length < 4 || DASHBOARD_ALIAS_STOPWORDS.has(token)) {
      continue;
    }
    values.add(token);
  }

  return [...values];
}

function includesPhrase(haystack = "", phrase = "") {
  const normalizedPhraseValue = normalizeText(phrase);
  return Boolean(normalizedPhraseValue.trim()) && haystack.includes(normalizedPhraseValue);
}

function resolveActivityScore(evidence = []) {
  if (!evidence.length) {
    return 0;
  }
  const weighted = evidence.reduce((sum, item) => sum + item.score, 0) * 10.5 + evidence.length * 4;
  return Math.round(clamp(weighted, 0, 100));
}

function resolveEvidenceConfidence(evidence = [], fallback = 0.34) {
  if (!evidence.length) {
    return roundTo(fallback, 2);
  }

  const topConfidence = Math.max(...evidence.map((item) => Number(item.confidence || 0)));
  return roundTo(clamp(topConfidence, 0.2, 0.99), 2);
}

function buildDashboardCorpus(snapshot = {}, signalCorpus = [], rssSnapshot = {}) {
  const articles = uniqueEvidence([
    ...(signalCorpus || []),
    ...(snapshot.news || []),
    ...(rssSnapshot.items || [])
  ]);
  const items = [];
  const byCountry = new Map();
  const byTopic = new Map();
  const bySource = new Map();

  for (const article of articles) {
    const countries = listToUpper([
      ...(article.countryMentions || []),
      ...(article.countries || []),
      article.country || null
    ]);
    const lat = numericOrNull(article.lat);
    const lng = numericOrNull(article.lng);
    const primaryCountry = countries.length ? resolveCountryCoordinates(countries[0]) : null;
    const directGeo = lat !== null && lng !== null && !sameCoordinates({ lat, lng }, primaryCountry);
    const topicTags = [...new Set((article.topicTags || []).map((item) => normalizePhrase(item)).filter(Boolean))];
    const sourceName = article.sourceName || article.provider || "unknown";
    const item = {
      id: article.id || hashValue(`${article.url || article.title || "article"}:${article.publishedAt || article.timestamp || ""}`),
      title: article.title || sourceName,
      text: normalizeText(
        `${article.title || ""} ${article.summary || ""} ${article.description || ""} ${article.content || ""} ${(article.topicTags || []).join(" ")}`
      ),
      countries,
      lat,
      lng,
      directGeo,
      topicTags,
      sourceName,
      provider: article.provider || sourceName,
      credibility: clamp(Number(article.credibilityScore || 0.62), 0.15, 0.99),
      publishedAt: toTimestamp(article.publishedAt || article.timestamp || Date.now())
    };

    items.push(item);
    countries.forEach((iso2) => pushIndexed(byCountry, iso2, item));
    topicTags.forEach((tag) => pushIndexed(byTopic, tag, item));
    pushIndexed(bySource, normalizePhrase(sourceName), item);
  }

  return {
    items,
    byCountry,
    byTopic,
    bySource
  };
}

function candidatePoolForAsset(assetCountries = [], rule = {}, corpus = {}) {
  const pool = new Map();
  assetCountries.forEach((iso2) => {
    (corpus.byCountry?.get(iso2) || []).forEach((item) => {
      pool.set(item.id, item);
    });
  });
  (rule.topicTags || []).forEach((tag) => {
    (corpus.byTopic?.get(normalizePhrase(tag)) || []).forEach((item) => {
      pool.set(item.id, item);
    });
  });
  return pool.size ? [...pool.values()] : corpus.items || [];
}

function evaluateSeedEvidence(candidate, { countries = [], aliases = [], rule = {}, nowMs = Date.now() } = {}) {
  const aliasMatches = aliases.filter((alias) => includesPhrase(candidate.text, alias));
  const keywordMatches = (rule.keywords || []).filter((keyword) => includesPhrase(candidate.text, keyword));
  const topicMatches = (rule.topicTags || []).filter((tag) => (candidate.topicTags || []).includes(normalizePhrase(tag)));
  const countryMatch = countries.some((iso2) => candidate.countries.includes(iso2));

  if (!aliasMatches.length && !keywordMatches.length && !topicMatches.length) {
    return null;
  }

  if (!countryMatch && !aliasMatches.length) {
    return null;
  }

  const ageMs = nowMs - new Date(candidate.publishedAt || 0).getTime();
  const ageHours = Number.isFinite(ageMs) && ageMs > 0 ? ageMs / 3_600_000 : 24;
  const recencyBoost = ageHours <= 6 ? 0.9 : ageHours <= 24 ? 0.55 : ageHours <= 72 ? 0.25 : 0;
  const score =
    (countryMatch ? 1.35 : 0) +
    aliasMatches.length * 2.45 +
    keywordMatches.length * 0.85 +
    topicMatches.length * 0.7 +
    (candidate.directGeo ? 1.7 : 0) +
    candidate.credibility * 1.15 +
    recencyBoost;

  if (score < 2.15) {
    return null;
  }

  return {
    id: candidate.id,
    title: candidate.title,
    publishedAt: candidate.publishedAt,
    sourceName: candidate.sourceName,
    countries: candidate.countries,
    lat: candidate.lat,
    lng: candidate.lng,
    directGeo: candidate.directGeo,
    score: roundTo(score, 3),
    confidence: clamp(
      candidate.credibility +
        (aliasMatches.length ? 0.12 : 0) +
        (candidate.directGeo ? 0.14 : 0) +
        (countryMatch ? 0.08 : 0),
      0.2,
      0.99
    ),
    status: candidate.directGeo && aliasMatches.length ? "confirmed" : countryMatch ? "country-inferred" : "seeded"
  };
}

function summarizeEvidence(evidence = []) {
  const recent = evidence
    .slice(0, 2)
    .map((item) => item.title)
    .filter(Boolean);
  return recent.length ? recent : [];
}

function weightedAverageCoordinates(evidence = []) {
  if (!evidence.length) {
    return null;
  }

  const weighted = evidence.reduce(
    (accumulator, item) => {
      const weight = Number(item.score || 0);
      accumulator.lat += Number(item.lat) * weight;
      accumulator.lng += Number(item.lng) * weight;
      accumulator.total += weight;
      return accumulator;
    },
    { lat: 0, lng: 0, total: 0 }
  );

  if (weighted.total <= 0) {
    return null;
  }

  return {
    lat: weighted.lat / weighted.total,
    lng: weighted.lng / weighted.total
  };
}

function weightedCountryCoordinates(evidence = [], fallbackCountry = "") {
  const weighted = evidence.reduce(
    (accumulator, item) => {
      const country = (item.countries || []).find(Boolean) || fallbackCountry;
      const coordinates = resolveCountryCoordinates(country);
      if (!coordinates) {
        return accumulator;
      }

      const weight = Number(item.score || 0);
      accumulator.lat += Number(coordinates.lat) * weight;
      accumulator.lng += Number(coordinates.lng) * weight;
      accumulator.total += weight;
      return accumulator;
    },
    { lat: 0, lng: 0, total: 0 }
  );

  if (weighted.total <= 0) {
    return fallbackCountry ? resolveCountryCoordinates(fallbackCountry) : null;
  }

  return {
    lat: weighted.lat / weighted.total,
    lng: weighted.lng / weighted.total
  };
}

function buildDashboardStaticPointAssets(snapshot = {}, signalCorpus = [], rssSnapshot = {}, now = new Date().toISOString()) {
  const corpus = buildDashboardCorpus(snapshot, signalCorpus, rssSnapshot);
  const nowMs = new Date(now).getTime();

  return Object.entries(STATIC_POINTS).flatMap(([layerId, items]) => {
    const rule = DASHBOARD_STATIC_LAYER_RULES[layerId] || {
      label: layerId.replaceAll("_", " "),
      styleKey: layerId,
      keywords: [],
      topicTags: []
    };

    return items.map((item) => {
      const hostCountry = resolveAssetHostCountry(item);
      const countries = resolveAssetCountries(item);
      const hostCountryName = countryIndex[hostCountry]?.country || hostCountry;
      const aliases = buildSeedAliases(item.name, item.aliases || []);
      const evidence = candidatePoolForAsset([hostCountry], rule, corpus)
        .map((candidate) =>
          evaluateSeedEvidence(candidate, {
            countries: [hostCountry],
            aliases,
            rule,
            nowMs
          })
        )
        .filter(Boolean)
        .sort((left, right) => right.score - left.score)
        .slice(0, 5);
      const topEvidence = evidence[0] || null;

      return {
        id: `static:${layerId}:${item.id}`,
        assetType: "static",
        layerId,
        layerLabel: rule.label,
        styleKey: rule.styleKey,
        iconKey: item.iconKey || rule.styleKey,
        title: item.name,
        country: hostCountry,
        countries,
        hostCountry,
        hostCountryName,
        facilityType: item.facilityType || null,
        approximate: item.approximate === true,
        alwaysVisible: layerId === "military_bases",
        lat: Number(item.lat),
        lng: Number(item.lng),
        baseLat: Number(item.lat),
        baseLng: Number(item.lng),
        status: topEvidence?.status || "seeded",
        confidence: resolveEvidenceConfidence(evidence, 0.34),
        activityScore: resolveActivityScore(evidence),
        linkedArticleCount: evidence.length,
        lastEvidenceAt: topEvidence?.publishedAt || null,
        lastEvidenceSource: topEvidence?.sourceName || null,
        headline: topEvidence?.title || null,
        evidenceSummary: summarizeEvidence(evidence),
        syntheticMotion: false,
        heading: null
      };
    });
  });
}

function buildDashboardMovingSeedAssets(snapshot = {}, signalCorpus = [], rssSnapshot = {}, now = new Date().toISOString()) {
  const corpus = buildDashboardCorpus(snapshot, signalCorpus, rssSnapshot);
  const phase = Math.floor(new Date(now).getTime() / 60_000);
  const nowMs = new Date(now).getTime();

  return Object.entries(MOVING_SEEDS).flatMap(([layerId, items]) => {
    const rule = DASHBOARD_MOVING_LAYER_RULES[layerId] || {
      label: layerId.replaceAll("_", " "),
      styleKey: layerId,
      keywords: [],
      topicTags: [],
      maxDriftKm: 850,
      syntheticLatScale: 0.45,
      syntheticLngScale: 0.75
    };

    return items.map((item) => {
      const aliases = buildSeedAliases(item.name, item.aliases || []);
      const evidence = candidatePoolForAsset([item.country], rule, corpus)
        .map((candidate) =>
          evaluateSeedEvidence(candidate, {
            countries: [item.country],
            aliases,
            rule,
            nowMs
          })
        )
        .filter(Boolean)
        .sort((left, right) => right.score - left.score)
        .slice(0, 5);
      const syntheticPoint = {
        lat: item.lat + jitter(`${item.id}:${phase}:lat`, rule.syntheticLatScale),
        lng: item.lng + jitter(`${item.id}:${phase}:lng`, rule.syntheticLngScale)
      };
      const geoEvidence = evidence.filter((entry) => entry.directGeo && Number.isFinite(entry.lat) && Number.isFinite(entry.lng));
      const geoTarget = weightedAverageCoordinates(geoEvidence.slice(0, 3));
      const countryTarget = weightedCountryCoordinates(evidence, item.country);
      const blendedTarget = geoTarget
        ? interpolatePoint(syntheticPoint, geoTarget, 0.72)
        : countryTarget
          ? interpolatePoint(syntheticPoint, countryTarget, 0.3)
          : syntheticPoint;
      const clampedPoint = clampToRadius(
        { lat: Number(item.lat), lng: Number(item.lng) },
        blendedTarget,
        rule.maxDriftKm
      );
      const topEvidence = evidence[0] || null;
      const finalPoint = topEvidence ? clampedPoint : syntheticPoint;
      const heading =
        bearingDegrees({ lat: Number(item.lat), lng: Number(item.lng) }, finalPoint) ?? syntheticHeading(item.id, phase);

      return {
        id: `moving:${layerId}:${item.id}`,
        assetType: "moving",
        layerId,
        layerLabel: rule.label,
        styleKey: rule.styleKey,
        title: item.name,
        country: item.country,
        countries: [item.country],
        lat: roundTo(finalPoint.lat, 5),
        lng: roundTo(finalPoint.lng, 5),
        baseLat: Number(item.lat),
        baseLng: Number(item.lng),
        status: topEvidence?.status || "seeded",
        confidence: resolveEvidenceConfidence(evidence, 0.42),
        activityScore: resolveActivityScore(evidence),
        linkedArticleCount: evidence.length,
        lastEvidenceAt: topEvidence?.publishedAt || null,
        lastEvidenceSource: topEvidence?.sourceName || null,
        headline: topEvidence?.title || null,
        evidenceSummary: summarizeEvidence(evidence),
        syntheticMotion: !topEvidence,
        heading: roundTo(heading, 1),
        trackPhase: phase,
        positionMode: geoEvidence.length ? "triangulated" : topEvidence ? "country-inferred" : "synthetic"
      };
    });
  });
}

function buildDashboardMapAssets(snapshot = {}, signalCorpus = [], rssSnapshot = {}, now = new Date().toISOString()) {
  const staticPoints = buildDashboardStaticPointAssets(snapshot, signalCorpus, rssSnapshot, now);
  const movingSeeds = buildDashboardMovingSeedAssets(snapshot, signalCorpus, rssSnapshot, now);
  const statusCounts = DASHBOARD_ASSET_STATUS.reduce(
    (accumulator, status) => ({
      ...accumulator,
      [status]: 0
    }),
    {}
  );

  [...staticPoints, ...movingSeeds].forEach((asset) => {
    statusCounts[asset.status] = (statusCounts[asset.status] || 0) + 1;
  });

  return {
    generatedAt: now,
    staticPoints,
    movingSeeds,
    meta: {
      generatedAt: now,
      rssGeneratedAt: rssSnapshot?.generatedAt || null,
      corpusSize: (signalCorpus || []).length + (snapshot.news || []).length + ((rssSnapshot.items || []).length),
      matchedAssets: [...staticPoints, ...movingSeeds].filter((asset) => asset.linkedArticleCount > 0).length,
      statusCounts
    }
  };
}

function pointFeature(layerId, id, title, lat, lng, properties = {}, timestamp = new Date().toISOString()) {
  return {
    id: `${layerId}:${id}`,
    layerId,
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [Number(lng), Number(lat)]
    },
    title,
    timestamp: toTimestamp(timestamp),
    properties: {
      ...properties
    }
  };
}

function lineFeature(layerId, id, title, coordinates = [], properties = {}, timestamp = new Date().toISOString()) {
  return {
    id: `${layerId}:${id}`,
    layerId,
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: coordinates.map(([lng, lat]) => [Number(lng), Number(lat)])
    },
    title,
    timestamp: toTimestamp(timestamp),
    properties
  };
}

function resolveCountryCoordinates(iso2) {
  return countryIndex[String(iso2 || "").toUpperCase()] || null;
}

function buildStaticPointFeatures(layerId, now) {
  return (STATIC_POINTS[layerId] || []).map((item) =>
    pointFeature(
      layerId,
      item.id,
      item.name,
      item.lat,
      item.lng,
      {
        country: resolveAssetHostCountry(item),
        countries: resolveAssetCountries(item),
        hostCountry: resolveAssetHostCountry(item),
        facilityType: item.facilityType || null,
        iconKey: item.iconKey || layerId,
        approximate: item.approximate === true,
        severity: "monitoring",
        source: "seeded-map-catalog",
        synthetic: true
      },
      now
    )
  );
}

function buildStaticLineFeatures(layerId, now) {
  return (STATIC_LINES[layerId] || []).map((item) =>
    lineFeature(
      layerId,
      item.id,
      item.name,
      item.coordinates,
      {
        countries: item.countries || [],
        severity: "monitoring",
        source: "seeded-map-catalog",
        synthetic: true
      },
      now
    )
  );
}

function buildMovingFeatures(layerId, now) {
  const phase = Math.floor(new Date(now).getTime() / 60_000);
  return (MOVING_SEEDS[layerId] || []).map((item) => {
    const lat = item.lat + jitter(`${item.id}:${phase}:lat`, 0.45);
    const lng = item.lng + jitter(`${item.id}:${phase}:lng`, 0.75);
    return pointFeature(
      layerId,
      item.id,
      item.name,
      lat,
      lng,
      {
        country: item.country,
        countries: [item.country],
        severity: "elevated",
        source: "seeded-moving-layer",
        synthetic: true,
        trackPhase: phase
      },
      now
    );
  });
}

function buildConflictFeatures(snapshot = {}, now) {
  return (snapshot.hotspots || [])
    .filter((item) => Number(item.score || 0) > 0)
    .map((hotspot) =>
      pointFeature(
        "conflicts",
        hotspot.iso2,
        hotspot.country,
        hotspot.lat,
        hotspot.lng,
        {
          country: hotspot.iso2,
          countries: [hotspot.iso2],
          level: hotspot.level,
          severity: String(hotspot.level || "stable").toLowerCase(),
          score: hotspot.score,
          metrics: hotspot.metrics || {},
          topTags: hotspot.topTags || [],
          source: "state-hotspots",
          synthetic: false
        },
        hotspot.updatedAt || now
      )
    );
}

function buildScaffoldFeatures(layerId, now) {
  return BASELINE_COUNTRIES.slice(0, 4).map((country, index) =>
    pointFeature(
      layerId,
      `${country.iso2}-${index + 1}`,
      `${country.name} ${layerId.replaceAll("_", " ")}`,
      country.lat + jitter(`${layerId}:${country.iso2}:lat`, 0.5),
      country.lng + jitter(`${layerId}:${country.iso2}:lng`, 0.5),
      {
        country: country.iso2,
        countries: [country.iso2],
        severity: "monitoring",
        source: "registry-scaffold",
        synthetic: true,
        implementation: "scaffold"
      },
      now
    )
  );
}

function buildArticleSources(snapshot = {}, rssSnapshot = {}) {
  const stateArticles = [...(snapshot.signalCorpus || []), ...(snapshot.news || [])].map((article) => ({
    ...article,
    publishedAt: article.publishedAt,
    sourceName: article.sourceName || article.provider || "state",
    summary: article.description || "",
    threatLevel: article.conflict?.totalWeight > 4 ? "high" : "medium",
    topicTags: (article.conflict?.tags || []).map((item) => item.tag),
    credibilityScore: 0.68
  }));

  const rssArticles = (rssSnapshot.items || []).map((item) => ({
    ...item,
    publishedAt: item.publishedAt || item.timestamp,
    sourceName: item.sourceName || item.provider || "rss",
    summary: item.summary || item.description || "",
    threatLevel: item.threatLevel || "low",
    topicTags: item.topicTags || [],
    credibilityScore: Number(item.credibilityScore || 0.55)
  }));

  return [...stateArticles, ...rssArticles];
}

function articleMatchesKeywords(article, keywords = []) {
  if (!keywords.length) {
    return false;
  }

  const haystack = normalizeText(
    `${article.title || ""} ${article.summary || ""} ${article.description || ""} ${(article.topicTags || []).join(" ")}`
  );
  return keywords.some((keyword) => haystack.includes(normalizeText(keyword)));
}

function resolveArticleSeverity(article = {}) {
  const threatLevel = String(article.threatLevel || "").toLowerCase();
  if (threatLevel === "critical" || threatLevel === "high") {
    return "critical";
  }
  if (threatLevel === "elevated" || threatLevel === "medium") {
    return "elevated";
  }
  return "monitoring";
}

function articleToFeatures(layerId, article = {}) {
  const mentions = [...new Set(article.countryMentions || article.countries || [])];
  const timestamp = article.publishedAt || article.timestamp || new Date().toISOString();
  const features = [];

  if (Number.isFinite(article.lat) && Number.isFinite(article.lng)) {
    features.push(
      pointFeature(
        layerId,
        article.id || hashValue(`${layerId}:${article.title}:${timestamp}`),
        article.title || layerId,
        article.lat,
        article.lng,
        {
          country: article.country || mentions[0] || null,
          countries: mentions,
          severity: resolveArticleSeverity(article),
          source: article.sourceName || article.provider || "article",
          url: article.url || null,
          credibilityScore: Number(article.credibilityScore || 0.55),
          threatLevel: article.threatLevel || "low",
          topicTags: article.topicTags || [],
          synthetic: Boolean(article.synthetic)
        },
        timestamp
      )
    );
    return features;
  }

  for (const iso2 of mentions) {
    const country = resolveCountryCoordinates(iso2);
    if (!country) {
      continue;
    }
    const id = `${article.id || hashValue(article.title || article.url || layerId)}:${iso2}`;
    features.push(
      pointFeature(
        layerId,
        id,
        article.title || layerId,
        country.lat + jitter(`${id}:lat`, 0.25),
        country.lng + jitter(`${id}:lng`, 0.25),
        {
          country: iso2,
          countries: mentions,
          severity: resolveArticleSeverity(article),
          source: article.sourceName || article.provider || "article",
          url: article.url || null,
          credibilityScore: Number(article.credibilityScore || 0.55),
          threatLevel: article.threatLevel || "low",
          topicTags: article.topicTags || [],
          synthetic: Boolean(article.synthetic)
        },
        timestamp
      )
    );
  }

  return features;
}

function buildArticleLayerFeatures(layerId, snapshot = {}, rssSnapshot = {}, now) {
  const keywords = ARTICLE_KEYWORDS[layerId] || [];
  const matches = buildArticleSources(snapshot, rssSnapshot).filter((article) => articleMatchesKeywords(article, keywords));
  const features = matches.flatMap((article) => articleToFeatures(layerId, article));
  if (features.length) {
    return features;
  }
  return buildScaffoldFeatures(layerId, now);
}

function coordinatesWithinBbox(coordinates = [], bbox = null) {
  if (!bbox) {
    return true;
  }

  const [west, south, east, north] = bbox;
  return coordinates.some(([lng, lat]) => lng >= west && lng <= east && lat >= south && lat <= north);
}

function featureWithinBbox(feature, bbox) {
  if (!bbox) {
    return true;
  }
  if (feature.geometry?.type === "Point") {
    return coordinatesWithinBbox([feature.geometry.coordinates], bbox);
  }
  if (feature.geometry?.type === "LineString") {
    return coordinatesWithinBbox(feature.geometry.coordinates || [], bbox);
  }
  return true;
}

function featureWithinCountries(feature, countriesSet) {
  if (!countriesSet?.size) {
    return true;
  }
  const featureCountries = feature?.properties?.countries || [];
  return featureCountries.some((iso2) => countriesSet.has(String(iso2 || "").toUpperCase()));
}

function featureWithinTimeWindow(feature, thresholdMs) {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    return true;
  }

  const timestampMs = new Date(feature.timestamp || 0).getTime();
  if (!Number.isFinite(timestampMs)) {
    return false;
  }
  return timestampMs >= thresholdMs;
}

function buildLayerPayload(layerId, snapshot = {}, rssSnapshot = {}, now = new Date().toISOString()) {
  if (layerId === "conflicts") {
    return {
      implementation: "live",
      features: buildConflictFeatures(snapshot, now)
    };
  }

  if (STATIC_POINTS[layerId]) {
    return {
      implementation: "seeded",
      features: buildStaticPointFeatures(layerId, now)
    };
  }

  if (STATIC_LINES[layerId]) {
    return {
      implementation: "seeded",
      features: buildStaticLineFeatures(layerId, now)
    };
  }

  if (MOVING_SEEDS[layerId]) {
    return {
      implementation: "seeded",
      features: buildMovingFeatures(layerId, now)
    };
  }

  if (ARTICLE_KEYWORDS[layerId]) {
    return {
      implementation: "live",
      features: buildArticleLayerFeatures(layerId, snapshot, rssSnapshot, now)
    };
  }

  return {
    implementation: "scaffold",
    features: buildScaffoldFeatures(layerId, now)
  };
}

export class MapLayerService {
  constructor({ stateManager, rssAggregator = null } = {}) {
    this.stateManager = stateManager;
    this.rssAggregator = rssAggregator;
    this.cache = new BoundedCache({
      maxEntries: 256,
      defaultTtlMs: 300_000
    });
  }

  async resolveRssSnapshot() {
    if (!this.rssAggregator) {
      return { items: [], meta: { source: "disabled" } };
    }

    try {
      return await this.rssAggregator.getSnapshot({ force: false });
    } catch (error) {
      log.warn("map_layer_rss_snapshot_failed", { message: error.message });
      return { items: [], meta: { source: "error", reason: error.message } };
    }
  }

  async getDashboardMapAssets({ snapshot = null, signalCorpus = null, rssSnapshot = null } = {}) {
    const baseSnapshot = snapshot || this.stateManager.getSnapshot();
    const corpus =
      signalCorpus ||
      this.stateManager.getSignalCorpus?.() ||
      baseSnapshot.signalCorpus ||
      [];
    const resolvedRssSnapshot = rssSnapshot || await this.resolveRssSnapshot();
    return buildDashboardMapAssets(baseSnapshot, corpus, resolvedRssSnapshot, new Date().toISOString());
  }

  async getRawLayer(layer, { snapshot, rssSnapshot, force = false } = {}) {
    const cacheKey = layer.id;
    const nowMs = Date.now();
    const cached = !force ? this.cache.get(cacheKey, nowMs) : null;
    if (cached) {
      return {
        ...cached.value,
        cacheHit: true,
        cacheAgeMs: cached.ageMs
      };
    }

    const refreshedAt = new Date(nowMs).toISOString();
    const payload = buildLayerPayload(layer.id, snapshot, rssSnapshot, refreshedAt);
    this.cache.set(
      cacheKey,
      {
        refreshedAt,
        implementation: payload.implementation,
        features: payload.features
      },
      layer.refreshIntervalMs,
      nowMs
    );

    return {
      refreshedAt,
      implementation: payload.implementation,
      features: payload.features,
      cacheHit: false,
      cacheAgeMs: 0
    };
  }

  async getLayerBundle({
    layerIds = [],
    timeWindow = "24h",
    countries = [],
    bbox = null,
    limit = 250,
    preset = "Global",
    force = false
  } = {}) {
    const resolvedLayerIds = layerIds.length
      ? layerIds
      : getMapPreset(preset)?.activeLayers || ["conflicts", "protests", "cyber_incidents", "sanctions"];
    const resolvedLayers = resolvedLayerIds
      .map((layerId) => getMapLayerDefinition(layerId))
      .filter(Boolean);
    const resolvedTimeWindow = getMapTimeWindow(timeWindow);
    const thresholdMs = Date.now() - resolvedTimeWindow.ms;
    const countriesSet = new Set((countries || []).map((iso2) => String(iso2 || "").toUpperCase()));
    const snapshot = this.stateManager.getSnapshot();
    const rssSnapshot = await this.resolveRssSnapshot();

    const layers = [];
    for (const layer of resolvedLayers) {
      const raw = await this.getRawLayer(layer, { snapshot, rssSnapshot, force });
      const features = (raw.features || [])
        .filter((feature) => featureWithinTimeWindow(feature, thresholdMs))
        .filter((feature) => featureWithinCountries(feature, countriesSet))
        .filter((feature) => featureWithinBbox(feature, bbox))
        .slice(0, limit);

      layers.push({
        id: layer.id,
        label: layer.label,
        category: layer.category,
        clusterable: layer.clusterable,
        timeFilterable: layer.timeFilterable,
        capability: layer.capability,
        implementation: raw.implementation,
        refreshIntervalMs: layer.refreshIntervalMs,
        cacheHit: raw.cacheHit,
        cacheAgeMs: raw.cacheAgeMs,
        refreshedAt: raw.refreshedAt,
        featureCount: features.length,
        features
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      timeWindow: resolvedTimeWindow,
      preset: getMapPreset(preset),
      layers
    };
  }

  getConfig() {
    return {
      generatedAt: new Date().toISOString(),
      engine: {
        default: "leaflet",
        available: ["leaflet", "webgl"],
        futureWebglTargets: ["deck.gl", "globe.gl", "Three.js"]
      },
      layers: listMapLayers(),
      presets: listMapPresets(),
      timeWindows: listMapTimeWindows(),
      themes: buildMapThemeConfig()
    };
  }
}
