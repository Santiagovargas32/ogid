import stateManager from "../state/stateManager.js";
import { parseCountries, parsePositiveInt } from "../utils/filters.js";
import { computeCountryInstability } from "../services/intel/countryInstabilityService.js";
import { computeHotspotEscalation } from "../services/intel/hotspotEscalationService.js";
import { normalizeOsintEvents } from "../services/intel/osintFusion.js";

function mapResponse(data) {
  return {
    ok: true,
    data
  };
}

function filterRankedCountries(ranking = [], countries = []) {
  if (!countries.length) {
    return ranking;
  }
  const set = new Set(countries);
  return ranking.filter((item) => set.has(item.iso2));
}

export async function getCountryInstability(req, res) {
  const config = res.app.locals.config;
  const aggregator = res.app.locals.rssAggregator;
  const countries = req.query.countries ? parseCountries(req.query.countries, config.watchlistCountries || []) : [];
  const aggregateNews = await aggregator.getSnapshot({
    force: req.query.force === "1" || req.query.force === "true",
    countries,
    limit: 250
  });
  const snapshot = stateManager.getSnapshot();
  const result = computeCountryInstability({ snapshot, aggregateNews });
  const ranking = filterRankedCountries(result.ranking, countries);
  res.json(
    mapResponse({
      generatedAt: result.generatedAt,
      ranking,
      countries: Object.fromEntries(ranking.map((item) => [item.iso2, result.countries[item.iso2]]))
    })
  );
}

export async function getHotspotsV2(req, res) {
  const config = res.app.locals.config;
  const aggregator = res.app.locals.rssAggregator;
  const countries = req.query.countries ? parseCountries(req.query.countries, config.watchlistCountries || []) : [];
  const aggregateNews = await aggregator.getSnapshot({
    force: req.query.force === "1" || req.query.force === "true",
    countries,
    limit: 300
  });
  const snapshot = stateManager.getSnapshot();
  const countryInstability = computeCountryInstability({ snapshot, aggregateNews });
  const fusedEvents = normalizeOsintEvents({
    snapshot,
    aggregateNews,
    maxEvents: parsePositiveInt(req.query.maxEvents, 450, { min: 50, max: 1000 })
  });
  const hotspots = computeHotspotEscalation({
    fusedEvents,
    countryInstability,
    gridSize: 1,
    windowHours: 24
  });
  res.json(
    mapResponse({
      generatedAt: new Date().toISOString(),
      hotspots: filterRankedCountries(hotspots, countries),
      eventCount: fusedEvents.length
    })
  );
}

export async function getIntelAnomalies(req, res) {
  const signalCorrelator = res.app.locals.signalCorrelator;
  const aggregator = res.app.locals.rssAggregator;
  const snapshot = stateManager.getSnapshot();
  const aggregateNews = await aggregator.getSnapshot({
    force: false,
    limit: 200
  });
  signalCorrelator.recordSnapshot(snapshot, aggregateNews);
  res.json(
    mapResponse(
      signalCorrelator.getAnomalies({
        activeWindowHours: parsePositiveInt(req.query.activeWindowHours, 2, { min: 1, max: 48 }),
        baselineDays: parsePositiveInt(req.query.baselineDays, 7, { min: 1, max: 30 })
      })
    )
  );
}
