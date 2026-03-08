import { parseCountries, parsePositiveInt } from "../utils/filters.js";

function mapResponse(data) {
  return {
    ok: true,
    data
  };
}

function parseLayerIds(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBbox(value) {
  if (!value) {
    return null;
  }

  const parts = String(value)
    .split(",")
    .map((entry) => Number(entry.trim()));
  if (parts.length !== 4 || parts.some((valuePart) => !Number.isFinite(valuePart))) {
    return null;
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

export function getMapConfig(_req, res) {
  const service = res.app.locals.mapLayerService;
  res.json(mapResponse(service.getConfig()));
}

export function getMapPresets(_req, res) {
  const service = res.app.locals.mapLayerService;
  res.json(mapResponse({ presets: service.getConfig().presets }));
}

export function getMapThemes(_req, res) {
  const service = res.app.locals.mapLayerService;
  res.json(mapResponse({ themes: service.getConfig().themes }));
}

export async function getMapLayers(req, res) {
  const service = res.app.locals.mapLayerService;
  const config = res.app.locals.config;
  const countries = req.query.countries ? parseCountries(req.query.countries, config.watchlistCountries || []) : [];
  const bundle = await service.getLayerBundle({
    layerIds: parseLayerIds(req.query.layers),
    timeWindow: String(req.query.timeWindow || "24h"),
    countries,
    bbox: parseBbox(req.query.bbox),
    limit: parsePositiveInt(req.query.limit, 250, { min: 10, max: 1000 }),
    preset: String(req.query.preset || "Global"),
    force: req.query.force === "1" || req.query.force === "true"
  });
  res.json(mapResponse(bundle));
}
