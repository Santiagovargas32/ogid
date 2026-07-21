import { parseCountries, parsePositiveInt } from "../utils/filters.js";
import { AppError } from "../utils/error.js";

function mapResponse(data) {
  return {
    ok: true,
    data
  };
}

function requestOptions(req, res, {
  defaultCountries = null,
  alignAnomalyWindow = false,
  strictAdvancedContract = false
} = {}) {
  const config = res.app.locals.config;
  const countryDefaults = Array.isArray(defaultCountries) ? defaultCountries : config.watchlistCountries || [];
  if (strictAdvancedContract) {
    const requestedWindowHours = Number(req.query.windowHours ?? 24);
    const requestedActiveWindowHours = Number(req.query.activeWindowHours ?? requestedWindowHours);
    const requestedBaselineDays = Number(req.query.baselineDays ?? 7);
    if (!Number.isInteger(requestedWindowHours) || requestedWindowHours < 6 || requestedWindowHours > 48) {
      throw new AppError("windowHours must be an integer between 6 and 48.", 400, "INVALID_ADVANCED_WINDOW");
    }
    if (!Number.isInteger(requestedActiveWindowHours) || requestedActiveWindowHours !== requestedWindowHours) {
      throw new AppError("activeWindowHours must match windowHours for the shared advanced snapshot.", 400, "MISMATCHED_ADVANCED_WINDOW");
    }
    if (![7, 30].includes(requestedBaselineDays)) {
      throw new AppError("baselineDays must be 7 or 30.", 400, "INVALID_BASELINE_WINDOW");
    }
  }
  const windowHours = parsePositiveInt(req.query.windowHours, 24, { min: 6, max: 168 });
  const requestedBaselineDays = parsePositiveInt(req.query.baselineDays, 7, { min: 1, max: 30 });
  return {
    countries: parseCountries(req.query.countries, countryDefaults),
    force: req.query.force === "1" || req.query.force === "true",
    windowHours,
    maxEvents: parsePositiveInt(req.query.maxEvents, 450, { min: 50, max: 1000 }),
    activeWindowHours: parsePositiveInt(
      req.query.activeWindowHours,
      alignAnomalyWindow ? Math.min(48, windowHours) : 2,
      { min: 1, max: 48 }
    ),
    baselineDays: requestedBaselineDays
  };
}

async function advancedSnapshot(req, res, options = {}) {
  return res.app.locals.advancedIntelligenceService.getSnapshot(requestOptions(req, res, options));
}

export async function getAdvancedIntelligenceSnapshot(req, res) {
  res.json(mapResponse(await advancedSnapshot(req, res, {
    alignAnomalyWindow: true,
    strictAdvancedContract: true
  })));
}

export async function getCountryInstability(req, res) {
  const snapshot = await advancedSnapshot(req, res, { defaultCountries: [] });
  const result = snapshot.countryInstability;
  res.json(
    mapResponse({
      generatedAt: snapshot.generatedAt,
      ranking: result.ranking,
      countries: result.countries,
      window: snapshot.window,
      corpus: snapshot.corpus,
      quality: snapshot.quality,
      methodology: result.methodology
    })
  );
}

export async function getHotspotsV2(req, res) {
  const snapshot = await advancedSnapshot(req, res, { defaultCountries: [] });
  res.json(
    mapResponse({
      generatedAt: snapshot.generatedAt,
      hotspots: snapshot.hotspots,
      eventCount: snapshot.corpus.eventCount,
      window: snapshot.window,
      corpus: snapshot.corpus,
      quality: snapshot.quality,
      methodology: snapshot.methodology
    })
  );
}

export async function getIntelAnomalies(req, res) {
  const snapshot = await advancedSnapshot(req, res, { defaultCountries: [] });
  res.json(mapResponse({
    ...snapshot.anomalies,
    generatedAt: snapshot.generatedAt,
    corpus: snapshot.corpus,
    quality: snapshot.quality,
    methodology: snapshot.methodology.anomaly
  }));
}
