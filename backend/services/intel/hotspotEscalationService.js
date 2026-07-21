import { detectGeoConvergence } from "./geoEventIndex.js";

export const HOTSPOT_ESCALATION_METHODOLOGY = Object.freeze({
  version: "hotspot-escalation-v2",
  normalization: "100*(1-exp(-log1p(ratePerHour)/log1p(referencePerHour)))",
  weights: Object.freeze({ news: 0.35, cii: 0.25, geo: 0.25, military: 0.15 }),
  references: Object.freeze({ newsPerHour: 2, militaryPerHour: 0.5 })
});

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function normalizeLogRate(count, windowHours, referencePerHour) {
  const ratePerHour = Math.max(0, Number(count || 0)) / Math.max(1, Number(windowHours || 24));
  const score = clamp(100 * (1 - Math.exp(-Math.log1p(ratePerHour) / Math.log1p(referencePerHour))));
  return { ratePerHour, score };
}

function isMilitaryEvent(event = {}) {
  return ["conflict", "military", "conflict_tag", "troop_movements", "missile_tests"].includes(
    String(event.event_type || "").toLowerCase()
  );
}

export function computeHotspotEscalation({
  fusedEvents = [],
  countryInstability = { countries: {} },
  gridSize = 1,
  windowHours = 24,
  now = Date.now()
} = {}) {
  const resolvedWindowHours = Math.max(1, Number(windowHours || 24));
  const thresholdMs = Number(now) - resolvedWindowHours * 60 * 60 * 1_000;
  const activeEvents = (fusedEvents || []).filter((event) => {
    const timestampMs = new Date(event.timestamp || 0).getTime();
    return Number.isFinite(timestampMs) && timestampMs >= thresholdMs && timestampMs <= Number(now) + 5 * 60 * 1_000;
  });
  const geoConvergence = detectGeoConvergence(activeEvents, { gridSize, windowHours: resolvedWindowHours, now });
  const convergenceByCountry = {};
  const convergenceEvidenceByCountry = {};

  for (const cell of geoConvergence) {
    for (const country of cell.countries || []) {
      if (Number(cell.geoConvergence || 0) >= Number(convergenceByCountry[country] || 0)) {
        convergenceByCountry[country] = Number(cell.geoConvergence || 0);
        convergenceEvidenceByCountry[country] = {
          cellId: cell.cellId,
          eventCount: cell.eventCount,
          articleCount: cell.articleCount,
          eventTypes: cell.eventTypes,
          components: cell.components
        };
      }
    }
  }

  const militaryEvidenceByCountry = {};
  const newsEvidenceByCountry = {};

  for (const event of activeEvents) {
    if (!event.country) {
      continue;
    }
    if (!event.sourceKind || event.sourceKind === "news") {
      newsEvidenceByCountry[event.country] ||= new Set();
      newsEvidenceByCountry[event.country].add(event.metadata?.articleId || event.id);
    }
    if (isMilitaryEvent(event)) {
      militaryEvidenceByCountry[event.country] ||= new Set();
      militaryEvidenceByCountry[event.country].add(`${event.metadata?.articleId || event.id}:${event.event_type}`);
    }
  }

  return Object.values(countryInstability.countries || {})
    .map((country) => {
      const newsCount = newsEvidenceByCountry[country.iso2]?.size || 0;
      const militaryCount = militaryEvidenceByCountry[country.iso2]?.size || 0;
      const references = HOTSPOT_ESCALATION_METHODOLOGY.references;
      const weights = HOTSPOT_ESCALATION_METHODOLOGY.weights;
      const newsRate = normalizeLogRate(newsCount, resolvedWindowHours, references.newsPerHour);
      const militaryRate = normalizeLogRate(militaryCount, resolvedWindowHours, references.militaryPerHour);
      const newsActivity = newsRate.score;
      const cii = clamp(country.cii || 0);
      const geo = clamp(convergenceByCountry[country.iso2] || 0);
      const military = militaryRate.score;
      const score = clamp(
        newsActivity * weights.news + cii * weights.cii + geo * weights.geo + military * weights.military
      );

      const components = {
        news: {
          score: Number(newsActivity.toFixed(2)),
          weight: weights.news,
          eventCount: newsCount,
          ratePerHour: Number(newsRate.ratePerHour.toFixed(3))
        },
        cii: {
          score: Number(cii.toFixed(2)),
          weight: weights.cii
        },
        geo: {
          score: Number(geo.toFixed(2)),
          weight: weights.geo,
          evidence: convergenceEvidenceByCountry[country.iso2] || null
        },
        military: {
          score: Number(military.toFixed(2)),
          weight: weights.military,
          eventCount: militaryCount,
          ratePerHour: Number(militaryRate.ratePerHour.toFixed(3))
        }
      };

      return {
        iso2: country.iso2,
        country: country.country,
        lat: country.lat,
        lng: country.lng,
        hotspotScore: Number(score.toFixed(2)),
        cii: country.cii,
        newsActivity,
        geoConvergence: geo,
        militaryActivity: military,
        components,
        explanation: [
          `News ${components.news.score.toFixed(1)} from ${newsCount} unique event(s) in ${resolvedWindowHours}h`,
          `CII ${components.cii.score.toFixed(1)}`,
          `Geo convergence ${components.geo.score.toFixed(1)}`,
          `Military ${components.military.score.toFixed(1)} from ${militaryCount} event(s)`
        ],
        windowHours: resolvedWindowHours,
        methodologyVersion: HOTSPOT_ESCALATION_METHODOLOGY.version
      };
    })
    .sort((left, right) => right.hotspotScore - left.hotspotScore);
}
