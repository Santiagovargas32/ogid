const DEFAULT_LAYER_OPTIONS = Object.freeze({
  clusterable: true,
  timeFilterable: true,
  enabledByDefault: false,
  capability: "registry",
  refreshIntervalMs: 300_000
});

function defineLayer(id, label, category, options = {}) {
  return Object.freeze({
    id,
    label,
    category,
    ...DEFAULT_LAYER_OPTIONS,
    ...options
  });
}

export const MAP_LAYER_DEFINITIONS = Object.freeze([
  defineLayer("conflicts", "Conflicts", "security", { enabledByDefault: true, capability: "live", refreshIntervalMs: 60_000 }),
  defineLayer("military_bases", "Military Bases", "security", { capability: "seeded", refreshIntervalMs: 1_800_000 }),
  defineLayer("naval_vessels", "Naval Vessels", "security", { capability: "seeded", refreshIntervalMs: 120_000 }),
  defineLayer("aircraft_adsb", "Aircraft ADS-B", "security", { capability: "seeded", refreshIntervalMs: 120_000 }),
  defineLayer("undersea_cables", "Undersea Cables", "infrastructure", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("pipelines", "Pipelines", "infrastructure", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("datacenters", "Datacenters", "infrastructure", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("protests", "Protests", "society", { capability: "live", refreshIntervalMs: 120_000 }),
  defineLayer("fires", "Fires", "environment", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("earthquakes", "Earthquakes", "environment", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("cyber_incidents", "Cyber Incidents", "cyber", { capability: "live", refreshIntervalMs: 180_000 }),
  defineLayer("sanctions", "Sanctions", "economics", { capability: "live", refreshIntervalMs: 180_000 }),
  defineLayer("satellite_launches", "Satellite Launches", "space", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("strategic_ports", "Strategic Ports", "logistics", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("airports", "Airports", "logistics", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("trade_routes", "Trade Routes", "logistics", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("refineries", "Refineries", "energy", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("power_plants", "Power Plants", "energy", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("substations", "Substations", "energy", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("internet_outages", "Internet Outages", "cyber", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("disinformation", "Disinformation", "information", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("elections", "Elections", "political", { capability: "live", refreshIntervalMs: 3_600_000 }),
  defineLayer("refugee_flows", "Refugee Flows", "humanitarian", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("border_incidents", "Border Incidents", "security", { capability: "live", refreshIntervalMs: 120_000 }),
  defineLayer("terror_attacks", "Terror Attacks", "security", { capability: "live", refreshIntervalMs: 120_000 }),
  defineLayer("critical_minerals", "Critical Minerals", "economics", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("ports_congestion", "Ports Congestion", "logistics", { capability: "seeded", refreshIntervalMs: 900_000 }),
  defineLayer("shipping_chokepoints", "Shipping Chokepoints", "logistics", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("droughts", "Droughts", "environment", { capability: "live", refreshIntervalMs: 3_600_000 }),
  defineLayer("storms", "Storms", "environment", { capability: "live", refreshIntervalMs: 900_000 }),
  defineLayer("floods", "Floods", "environment", { capability: "live", refreshIntervalMs: 900_000 }),
  defineLayer("disease_outbreaks", "Disease Outbreaks", "health", { capability: "live", refreshIntervalMs: 900_000 }),
  defineLayer("space_assets", "Space Assets", "space", { capability: "seeded", refreshIntervalMs: 900_000 }),
  defineLayer("missile_tests", "Missile Tests", "security", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("air_defense", "Air Defense", "security", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("troop_movements", "Troop Movements", "security", { capability: "live", refreshIntervalMs: 180_000 }),
  defineLayer("strategic_chokepoints", "Strategic Chokepoints", "logistics", { capability: "seeded", refreshIntervalMs: 3_600_000 }),
  defineLayer("supply_chain", "Supply Chain", "economics", { capability: "live", refreshIntervalMs: 900_000 }),
  defineLayer("food_security", "Food Security", "humanitarian", { capability: "live", refreshIntervalMs: 900_000 }),
  defineLayer("water_stress", "Water Stress", "humanitarian", { capability: "live", refreshIntervalMs: 900_000 }),
  defineLayer("financial_shocks", "Financial Shocks", "economics", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("prediction_markets", "Prediction Markets", "economics", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("commodity_prices", "Commodity Prices", "economics", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("energy_markets", "Energy Markets", "energy", { capability: "live", refreshIntervalMs: 300_000 }),
  defineLayer("cable_outages", "Cable Outages", "cyber", { capability: "live", refreshIntervalMs: 900_000 })
]);

export const MAP_TIME_WINDOWS = Object.freeze([
  Object.freeze({ id: "1h", label: "1h", ms: 60 * 60 * 1_000 }),
  Object.freeze({ id: "6h", label: "6h", ms: 6 * 60 * 60 * 1_000 }),
  Object.freeze({ id: "24h", label: "24h", ms: 24 * 60 * 60 * 1_000 }),
  Object.freeze({ id: "3d", label: "3d", ms: 3 * 24 * 60 * 60 * 1_000 }),
  Object.freeze({ id: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1_000 })
]);

export const MAP_REGION_PRESETS = Object.freeze([
  Object.freeze({
    id: "Global",
    label: "Global",
    center: [20, 5],
    zoom: 2,
    activeLayers: ["conflicts", "protests", "cyber_incidents", "sanctions"],
    timeWindow: "24h"
  }),
  Object.freeze({
    id: "Americas",
    label: "Americas",
    center: [16, -84],
    zoom: 3,
    activeLayers: ["conflicts", "protests", "strategic_ports", "trade_routes"],
    timeWindow: "24h"
  }),
  Object.freeze({
    id: "Europe",
    label: "Europe",
    center: [50, 15],
    zoom: 4,
    activeLayers: ["conflicts", "cyber_incidents", "sanctions", "aircraft_adsb"],
    timeWindow: "24h"
  }),
  Object.freeze({
    id: "MENA",
    label: "MENA",
    center: [28, 36],
    zoom: 4,
    activeLayers: ["conflicts", "troop_movements", "naval_vessels", "energy_markets"],
    timeWindow: "24h"
  }),
  Object.freeze({
    id: "Asia",
    label: "Asia",
    center: [24, 100],
    zoom: 3,
    activeLayers: ["conflicts", "missile_tests", "satellite_launches", "trade_routes"],
    timeWindow: "24h"
  }),
  Object.freeze({
    id: "Africa",
    label: "Africa",
    center: [2, 21],
    zoom: 3,
    activeLayers: ["conflicts", "protests", "food_security", "refugee_flows"],
    timeWindow: "3d"
  }),
  Object.freeze({
    id: "Oceania",
    label: "Oceania",
    center: [-18, 147],
    zoom: 4,
    activeLayers: ["trade_routes", "strategic_ports", "space_assets", "storms"],
    timeWindow: "3d"
  }),
  Object.freeze({
    id: "LatinAmerica",
    label: "LatinAmerica",
    center: [-16, -64],
    zoom: 4,
    activeLayers: ["protests", "conflicts", "critical_minerals", "financial_shocks"],
    timeWindow: "24h"
  })
]);

const LAYER_BY_ID = new Map(MAP_LAYER_DEFINITIONS.map((layer) => [layer.id, layer]));
const TIME_WINDOW_BY_ID = new Map(MAP_TIME_WINDOWS.map((item) => [item.id, item]));
const PRESET_BY_ID = new Map(MAP_REGION_PRESETS.map((preset) => [preset.id, preset]));

export function getMapLayerDefinition(layerId) {
  return LAYER_BY_ID.get(String(layerId || "")) || null;
}

export function getMapTimeWindow(windowId = "24h") {
  return TIME_WINDOW_BY_ID.get(String(windowId || "24h")) || TIME_WINDOW_BY_ID.get("24h");
}

export function getMapPreset(presetId = "Global") {
  return PRESET_BY_ID.get(String(presetId || "Global")) || PRESET_BY_ID.get("Global");
}

export function listMapLayers() {
  return MAP_LAYER_DEFINITIONS.map((layer) => ({ ...layer }));
}

export function listMapPresets() {
  return MAP_REGION_PRESETS.map((preset) => ({ ...preset }));
}

export function listMapTimeWindows() {
  return MAP_TIME_WINDOWS.map((window) => ({ ...window }));
}
