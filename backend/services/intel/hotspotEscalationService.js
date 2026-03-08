import { detectGeoConvergence } from "./geoEventIndex.js";

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

export function computeHotspotEscalation({
  fusedEvents = [],
  countryInstability = { countries: {} },
  gridSize = 1,
  windowHours = 24
} = {}) {
  const geoConvergence = detectGeoConvergence(fusedEvents, { gridSize, windowHours });
  const convergenceByCountry = {};

  for (const cell of geoConvergence) {
    for (const country of cell.countries || []) {
      convergenceByCountry[country] = Math.max(convergenceByCountry[country] || 0, Number(cell.geoConvergence || 0));
    }
  }

  const militaryActivityByCountry = {};
  const newsActivityByCountry = {};

  for (const event of fusedEvents) {
    if (!event.country) {
      continue;
    }
    newsActivityByCountry[event.country] = (newsActivityByCountry[event.country] || 0) + 1;
    if (["conflict", "military", "conflict_tag", "troop_movements", "missile_tests"].includes(String(event.event_type || ""))) {
      militaryActivityByCountry[event.country] = (militaryActivityByCountry[event.country] || 0) + 1;
    }
  }

  return Object.values(countryInstability.countries || {})
    .map((country) => {
      const newsActivity = clamp((newsActivityByCountry[country.iso2] || 0) * 10);
      const cii = clamp(country.cii || 0);
      const geo = clamp(convergenceByCountry[country.iso2] || 0);
      const military = clamp((militaryActivityByCountry[country.iso2] || 0) * 15);
      const score = clamp(newsActivity * 0.35 + cii * 0.25 + geo * 0.25 + military * 0.15);

      return {
        iso2: country.iso2,
        country: country.country,
        lat: country.lat,
        lng: country.lng,
        hotspotScore: Number(score.toFixed(2)),
        cii: country.cii,
        newsActivity,
        geoConvergence: geo,
        militaryActivity: military
      };
    })
    .sort((left, right) => right.hotspotScore - left.hotspotScore);
}
