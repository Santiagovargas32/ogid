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
  const readSnapshot = res.app.locals.business ? options => res.app.locals.newsArchive.getFeed({...options,rssOnly:true}) : options => aggregator.getSnapshot(options);
  const payload = await readSnapshot({
    force: req.query.force === "1" || req.query.force === "true",
    stored: (res.app.locals.business && !["1","true"].includes(req.query.force)) || req.query.stored === "1" || req.query.stored === "true",
    countries,
    topic: String(req.query.topic || ""),
    threat: String(req.query.threat || ""),
    limit: parsePositiveInt(req.query.limit, 120, { min: 10, max: 500 })
  });
  res.json(mapResponse(payload));
}
