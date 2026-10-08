// Registro compartido: contratos de transporte, permisos e inventario API→MCP.
// Sin imports de runtime ni secretos. Los parámetros son valores tipados; nunca URLs/rutas libres.
export const OPERATIONS_VERSION = "1.1.0";
const str = (maxLength = 128) => ({ type: "string", minLength: 1, maxLength });
const int = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const choice = (...values) => ({ type: "string", enum: values });
const array = (items = str(), maxItems = 50) => ({ type: "array", items, minItems: 1, maxItems, uniqueItems: true });
const date = { type: "string", format: "date-time" };
const country = { type: "string", pattern: "^[A-Z]{2}$" };
const countries = array(country);
const limit = int(1, 100);
const refs = { symbols: array(str(64)), instrumentIds: array(str()) };
const intel = { countries: array({ type: "string", pattern: "^(ALL|[A-Z]{2})$" }), sources: array(str(40)), limit };
const advanced = { countries, windowHours: int(6, 168), maxEvents: int(50, 1000), activeWindowHours: int(1, 48), baselineDays: { type: "integer", enum: [7, 30] } };
const awareness = { domain: array(choice("financial", "macro", "market", "corporate", "regulatory", "geopolitical", "security")), kinds: array(choice("macro_scheduled", "macro_release", "market_moving_news", "regulatory_filing", "official_security_release", "maritime_alert")), status: array(choice("scheduled", "live", "released", "updated", "cancelled")), countries, instrumentIds: refs.instrumentIds, from: date, to: date, limit };
const candles = { instrumentId: str(), interval: choice("1day", "1h", "30min", "15min", "5min"), from: date, to: date, limit, adjusted: choice("splits", "none") };
const impact = { tickers: array(str(64)), countries, windowMin: int(10, 1440), couplingInterval: choice("1day", "1h", "30min", "15min", "5min"), couplingWindows: array(int(15, 1440), 4), benchmarkInstrumentId: str() };
const layers = { layers: array(str(64), 30), timeWindow: choice("1h", "6h", "24h", "3d", "7d"), countries, bbox: { type: "array", items: { type: "number", minimum: -180, maximum: 180 }, minItems: 4, maxItems: 4 }, limit, preset: str(64) };
export const NEWS_SEARCH_PARAMS = { countries, ...refs, q: str(200), topics: array(str(64), 20), sectors: array(str(64), 20), sources: array(str(128), 30), providers: array(str(40), 20), from: date, to: date, timeField: choice("publishedAt", "updatedAt", "receivedAt", "archiveChangedAt"), limit, cursor: str(2048), maxBytes: int(4096, 524288) };
export const PORTFOLIO_PARAMS = { mode: choice("agenda", "daily", "material", "weekly"), ...refs, countries, from: date, to: date, limit, minImportance: choice("medium", "high"), includeUncorroborated: { type: "boolean" } };
function schema(properties = {}, required = []) { return { type: "object", properties, required, additionalProperties: false }; }
function op(id, method, path, parameters = {}, options = {}) {
  return Object.freeze({ ...options, id, method, path, parameters: schema(parameters, options.required || []), body: options.body ? schema(options.body, options.bodyRequired || []) : null,
    profile: options.profile || "research", scope: options.scope || "read:stored", effects: options.effects || "stored/local-calculation", cost: options.cost || "no-provider", fixed: options.fixed || {},
    retention: options.retention || "current snapshot; consult response coverage", provenance: options.provenance || "OGID runtime; source metadata", quality: "preserve mode, dates, stale/synthetic and missing values",
    projection: options.projection || "public", tool: options.tool || (options.profile === "operator" ? "ogid_operator" : "ogid_query") });
}
const costly = { profile: "operator", scope: "provider:query", effects: "provider requests and cache updates", cost: "provider quota/rate limits" };
const mutation = (scope) => ({ profile: "operator", scope, effects: "mutation", cost: "see runtime quotas" });
export const OGID_OPERATIONS = Object.freeze([
  op("health", "GET", "/api/health", {}, { tool: "ogid_health", projection: "health" }),
  op("capabilities", "GET", "/api/capabilities", {}, { tool: "ogid_get_capabilities" }),
  ...["snapshot", "hotspots", "risks", "news", "insights"].map(name => op(`intel.${name}`, "GET", `/api/intel/${name}`, intel, { projection: name === "news" ? "news" : "public", ...(name === "news" ? { tool: "ogid_get_news" } : {}) })),
  op("awareness", "GET", "/api/intel/awareness-snapshot", awareness, { tool: "ogid_get_awareness", projection: "awareness", retention: "backend retention policy (365-day default); public admission only" }),
  ...["advanced-snapshot", "hotspots-v2", "anomalies", "country-instability"].map(name => op(`intel.${name}`, "GET", `/api/intel/${name}`, advanced, { fixed: { stored: true }, effects: "stored/local-calculation; normal API may fetch RSS" })),
  op("country-instability.alias", "GET", "/api/country-instability", advanced, { fixed: { stored: true } }),
  op("news.aggregate", "GET", "/api/news/aggregate", { countries, topic: str(64), threat: choice("critical", "elevated", "monitoring", "low"), limit }, { fixed: { stored: true }, projection: "aggregate" }),
  op("news.search", "GET", "/api/news/search", NEWS_SEARCH_PARAMS, { tool: "ogid_search_news", retention: "30 days of permitted metadata, starting on activation", projection: "archive" }),
  op("news.item", "GET", "/api/news/items/:id", {}, { pathParameters: schema({ id: str(128) }, ["id"]), tool: "ogid_get_news_item", projection: "archive" }),
  op("instruments.resolve", "GET", "/api/market/instruments/resolve", { references: array(str()), exchange: str(80), currency: { type: "string", pattern: "^[A-Z]{3}$" }, isin: { type: "string", pattern: "^[A-Z]{2}[A-Z0-9]{9}[0-9]$" } }, { tool: "ogid_resolve_instruments", projection: "instruments" }),
  op("market.watchlist", "GET", "/api/market/watchlist", {}, { projection: "watchlist" }),
  op("market.quotes", "GET", "/api/market/quotes", { tickers: array(str(64)), includeSeries: { type: "boolean" }, seriesLimit: int(1,100) }, { projection: "quotes", fixed: { view: "compact" } }),
  op("market.provider-status", "GET", "/api/market/provider-status"),
  op("market.candles", "GET", "/api/market/candles", candles, { required: ["instrumentId"] }),
  op("market.candles.metrics", "GET", "/api/market/candles/metrics"),
  op("market.indicators", "GET", "/api/market/indicators", { instrumentId: str(), interval: candles.interval, adjusted: candles.adjusted, package: choice("standard-v1"), limit: int(1,2500) }, { required: ["instrumentId"] }),
  op("market.technical-context", "GET", "/api/market/technical-context", { instrumentId: str(), interval: choice("1day","1wk","1h","30min","15min","5min"), adjusted: candles.adjusted, package: choice("standard-v1"), benchmarkInstrumentId: str(), limit: int(30,2500) }, { required:["instrumentId"] }),
  op("research.forecast-evaluation", "GET", "/api/research/forecast-evaluation", {instrumentIds:refs.instrumentIds,modelVersion:str(100),minSamples:int(20,500),limit,asOf:date}, {effects:"stored evaluation; no forecast registration or providers"}),
  op("research.forecast.register", "POST", "/api/research/forecasts", {}, {...mutation("forecasts:write"),body:{forecastId:str(),instrumentId:str(),benchmarkInstrumentId:str(),eventId:str(),target:choice("return","relative-return","direction"),horizonHours:int(1,720),issuedAt:date,modelVersion:str(100),predictedValue:{type:"number"},direction:choice("up","down","flat"),probability:{type:"number",minimum:0,maximum:1},probabilityModelVersion:str(100),costs:schema({commissionBps:{type:"number",minimum:0,maximum:1000},spreadBps:{type:"number",minimum:0,maximum:1000},slippageBps:{type:"number",minimum:0,maximum:1000}},["commissionBps","spreadBps","slippageBps"]),evidence:array(schema({sourceId:str(),availableAt:date},["sourceId","availableAt"]),20)},bodyRequired:["forecastId","instrumentId","target","horizonHours","modelVersion"],cost:"prospective local registration only"}),
  op("research.scenarios", "GET", "/api/research/scenarios", {instrumentIds:refs.instrumentIds,statuses:array(choice("pending-data","watch","confirmed","invalidated","expired"),5),limit}, {retention:"durable scenarios; bounded audited revisions"}),
  op("signals.delta", "GET", "/api/signals/delta", {consumerId:str(100),instrumentIds:refs.instrumentIds,cursor:str(4096),limit,maxBytes:int(4096,524288)}, {effects:"stored read; never advances consumer checkpoint",retention:"30-day change journal; explicit gap errors"}),
  op("research.scenarios.refresh", "POST", "/api/research/scenarios/refresh", {}, {...mutation("signals:generate"),body:{instrumentIds:array(str(),50)},bodyRequired:["instrumentIds"],cost:"stored calculations; no provider"}),
  op("research.scenarios.delete", "POST", "/api/research/scenarios/delete", {}, {...mutation("signals:generate"),body:{scenarioId:str(),reason:str(200)},bodyRequired:["scenarioId","reason"],cost:"local audited tombstone"}),
  op("signals.checkpoint", "POST", "/api/signals/checkpoint", {}, {...mutation("signals:ack"),body:{consumerId:str(100),checkpointCursor:str(4096),expectedSequence:int(0,2147483647)},bodyRequired:["consumerId","checkpointCursor","expectedSequence"],cost:"processing acknowledgement only; no delivery receipt"}),
  op("signals.recover", "POST", "/api/signals/recover", {}, {...mutation("signals:ack"),body:{consumerId:str(100),sequence:int(0,2147483647),expectedSequence:int(0,2147483647),reason:str(200)},bodyRequired:["consumerId","sequence","expectedSequence","reason"],cost:"explicit recovery after snapshot review; acknowledges retained gap"}),
  op("research.event-impact", "GET", "/api/research/event-impact", { instrumentIds: refs.instrumentIds, eventIds: array(str()), from:date, to:date, limit }),
  op("research.companyfacts", "GET", "/api/research/companyfacts", {companyId:str()}, {required:["companyId"]}),
  op("research.sources", "GET", "/api/research/sources"),
  op("etf.holdings", "GET", "/api/etf/holdings", {instrumentId:str(),limit,offset:int(0,10000),snapshotId:str()}, {required:["instrumentId"]}),
  op("market.history.job", "GET", "/api/market/history/jobs", {jobId:str()}, {required:["jobId"],retention:"durable bounded job ledger"}),
  op("market.history.create", "POST", "/api/market/history/jobs", {}, {...mutation("candles:backfill"),body:{requestId:str(),instrumentIds:array(str(),20),targetBars:int(30,2500),endAt:date},bodyRequired:["requestId","instrumentIds"],cost:"local job creation; run is explicit"}),
  op("market.history.run", "POST", "/api/market/history/run", {}, {...mutation("candles:backfill"),body:{jobId:str(),maxRequests:int(1,4)},bodyRequired:["jobId"],cost:"max 4 Yahoo requests per run; provider limits"}),
  op("research.sources.run", "POST", "/api/research/sources/run", {}, {...mutation("sources:ingest"),body:{sourceIds:array(str(100),4),maxRequests:int(1,4)},bodyRequired:["sourceIds"],cost:"configured public sources only; max 4 requests"}),
  ...["impact", "analytics"].map(name => op(`market.${name}`, "GET", `/api/market/${name}`, impact)),
  op("market.conditions", "GET", "/api/market/conditions", { windowMin: { type: "integer", enum: [15, 60, 240, 1440] }, countries }),
  ...["config", "presets", "themes"].map(name => op(`map.${name}`, "GET", `/api/map/${name}`)),
  op("map.layers", "GET", "/api/map/layers", layers, { fixed: { stored: true }, effects: "stored/local-calculation; normal API may fetch RSS" }),
  op("media.streams", "GET", "/api/media/streams", { ids: array(str(80), 50) }, { fixed: { stored: true, resolve: "none" } }),
  op("media.health", "GET", "/api/media/streams/health"),
  op("media.item", "GET", "/api/media/streams/:id", {}, { pathParameters: schema({ id: str(80) }, ["id"]), fixed: { stored: true, resolve: "none" } }),
  op("diagnostics", "GET", "/api/diagnostics", {}, { projection: "diagnostics", effects: "sanitized counts; excludes private admin payloads" }),
  op("portfolio.context", "GET", "/api/portfolio/context", PORTFOLIO_PARAMS, { required: ["mode"], tool: "ogid_get_portfolio_context", effects: "stored/local-calculation; persists observed alert candidates, never delivery" }),
  op("market.instruments.search", "GET", "/api/market/instruments/search", { q: str(80), limit: int(1, 20) }, { ...costly, required: ["q"] }),
  op("intel.refresh", "POST", "/api/intel/refresh", { countries }, { ...mutation("intel:refresh"), body: { countries, reason: str(64) } }),
  op("market.watchlist.update", "PUT", "/api/market/watchlist", {}, { ...mutation("watchlist:write"), body: { instrumentIds: { ...refs.instrumentIds, minItems: 0 } }, bodyRequired: ["instrumentIds"] }),
  op("market.candles.backfill", "POST", "/api/market/candles/backfill", {}, { ...mutation("candles:backfill"), body: { instrumentIds: array(str(), 20), days: int(1, 30), adjusted: candles.adjusted }, bodyRequired: ["instrumentIds"], cost: "provider quota" }),
  op("media.refresh", "POST", "/api/media/streams/refresh", {}, { ...mutation("media:refresh"), body: { ids: array(str(80), 50), force: { type: "boolean" } }, cost: "provider requests" }),
  op("portfolio.alerts.ack", "POST", "/api/portfolio/alerts/ack", {}, { ...mutation("alerts:ack"), body: { candidateIds: array(str(128), 100), deliveredAt: date }, bodyRequired: ["candidateIds", "deliveredAt"] }),
  ...["api-limits", "news-raw", "pipeline-status", "ai-enrichments"].map(name => op(`admin.${name}`, "GET", `/api/admin/${name}`, name === "news-raw" ? { dataset: choice("intel", "rss-aggregate"), page: int(1, 10000), pageSize: int(10, 100) } : name === "ai-enrichments" ? { status: choice("pending", "running", "ready", "rejected", "failed", "stale"), kind: choice("article_summary", "country_insight", "market_explanation"), page: int(1, 10000), pageSize: int(1, 100) } : {}, { profile: "operator", scope: "admin:read", projection: "admin-counts", ...(name === "news-raw" ? { fixed: { stored: true } } : {}), effects: "sanitized administrative projection; full internal bodies never relayed" })),
  op("news.aggregate.fetch", "GET", "/api/news/aggregate", { countries, topic: str(64), threat: str(32), limit }, { ...costly, fixed: { force: true }, projection: "aggregate" }),
  op("intel.advanced.fetch", "GET", "/api/intel/advanced-snapshot", advanced, { ...costly, fixed: { force: true } }),
  op("intel.instability.fetch", "GET", "/api/intel/country-instability", advanced, { ...costly, fixed: { force: true } }),
  op("intel.hotspots.fetch", "GET", "/api/intel/hotspots-v2", advanced, { ...costly, fixed: { force: true } }),
  op("intel.instability-alias.fetch", "GET", "/api/country-instability", advanced, { ...costly, fixed: { force: true } }),
  op("market.candles.fetch", "GET", "/api/market/candles", candles, { ...costly, required: ["instrumentId"], fixed: { force: true } }),
  op("map.layers.fetch", "GET", "/api/map/layers", layers, { ...costly, fixed: { force: true } }),
  op("media.streams.resolve", "GET", "/api/media/streams", { ids: array(str(80), 50), resolve: choice("critical", "visible", "all") }, { ...costly, fixed: { force: true } }),
  op("media.item.resolve", "GET", "/api/media/streams/:id", { resolve: choice("visible", "all") }, { ...costly, pathParameters: schema({ id: str(80) }, ["id"]), fixed: { force: true } })
]);
export function getOperation(id) { return OGID_OPERATIONS.find(operation => operation.id === id) || null; }
export function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export function validateValue(value, definition) {
  if (definition.enum && !definition.enum.includes(value)) return false;
  if (definition.type === "object") return value && !Array.isArray(value) && typeof value === "object"
    && (definition.required || []).every(key => value[key] !== undefined)
    && Object.entries(value).every(([key, entry]) => Object.hasOwn(definition.properties, key) && validateValue(entry, definition.properties[key]));
  if (definition.type === "array") return Array.isArray(value) && value.length >= (definition.minItems || 0) && value.length <= definition.maxItems
    && (!definition.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length) && value.every(item => validateValue(item, definition.items));
  if (definition.type === "string") return typeof value === "string" && value.length >= (definition.minLength || 0) && value.length <= (definition.maxLength || 10000)
    && (!definition.pattern || new RegExp(definition.pattern).test(value)) && (definition.format !== "date-time" || validIsoDate(value));
  if (definition.type === "boolean") return typeof value === "boolean";
  return typeof value === "number" && Number.isFinite(value) && (definition.type !== "integer" || Number.isInteger(value)) && value >= (definition.minimum ?? -Infinity) && value <= (definition.maximum ?? Infinity);
}
export function parseOperationQuery(query, operation) {
  const values = {};
  for (const [key, raw] of Object.entries(query)) {
    if (!Object.hasOwn(operation.parameters.properties, key)) throw new Error("INVALID_ARGUMENTS");
    if (typeof raw !== "string") throw new Error("INVALID_ARGUMENTS");
    const def = operation.parameters.properties[key];
    values[key] = def.type === "array" ? raw.split(",").map(item => def.items.type === "integer" || def.items.type === "number" ? Number(item) : item.trim()) : def.type === "integer" || def.type === "number" ? Number(raw) : def.type === "boolean" ? raw === "true" ? true : raw === "false" ? false : null : raw;
  }
  if (!validateValue(values, operation.parameters)) throw new Error("INVALID_ARGUMENTS");
  if (values.from && values.to && Date.parse(values.from) > Date.parse(values.to)) throw new Error("INVALID_WINDOW");
  return values;
}
export function operationPath(operation, values = {}) {
  return operation.path.replace(/:([a-zA-Z]+)/g, (_match, name) => {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(values[name] || ""))) throw new Error("INVALID_PATH_ARGUMENT");
    return encodeURIComponent(values[name]);
  });
}
