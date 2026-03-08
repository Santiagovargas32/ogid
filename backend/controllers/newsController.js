import { parseCountries, parsePositiveInt } from "../utils/filters.js";

function mapResponse(data) {
  return {
    ok: true,
    data
  };
}

export async function getAggregateNews(req, res) {
  const config = res.app.locals.config;
  const aggregator = res.app.locals.rssAggregator;
  const countries = req.query.countries ? parseCountries(req.query.countries, config.watchlistCountries || []) : [];
  const payload = await aggregator.getSnapshot({
    force: req.query.force === "1" || req.query.force === "true",
    countries,
    topic: String(req.query.topic || ""),
    threat: String(req.query.threat || ""),
    limit: parsePositiveInt(req.query.limit, 120, { min: 10, max: 500 })
  });
  res.json(mapResponse(payload));
}
