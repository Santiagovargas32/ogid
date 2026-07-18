import { createHash } from "node:crypto";

export const NEWS_SOURCE_CATALOG_SCHEMA_VERSION = 1;
export const NEWS_SOURCE_CATALOG_VERSION = "1.0.0";
export const NEWS_SOURCE_CATALOG_METHOD_VERSION = "news-source-catalog-v1";

const RSS_SOURCE_ROWS = Object.freeze([
  ["rss-bellingcat", "Bellingcat", "https://www.bellingcat.com/feed/"],
  ["rss-globalsecurity", "GlobalSecurity", "https://www.globalsecurity.org/wmd/library/news/rss.xml"],
  ["rss-acled-conflict-data", "ACLED Conflict Data", "https://acleddata.com/feed/"],
  ["rss-reliefweb-global-crisis", "ReliefWeb Global Crisis", "https://reliefweb.int/updates/rss.xml"],
  ["rss-defense-news", "Defense News", "https://www.defensenews.com/arc/outboundfeeds/rss/"],
  ["rss-war-on-the-rocks", "War on the Rocks", "https://warontherocks.com/feed/"],
  ["rss-the-diplomat", "The Diplomat", "https://thediplomat.com/feed/"],
  ["rss-foreign-policy", "Foreign Policy", "https://foreignpolicy.com/feed/"],
  ["rss-csis", "Center for Strategic and International Studies", "https://www.csis.org/rss.xml"],
  ["rss-atlantic-council", "Atlantic Council", "https://www.atlanticcouncil.org/feed/"],
  ["rss-council-on-foreign-relations", "Council on Foreign Relations", "https://www.cfr.org/rss"],
  ["rss-carnegie-endowment", "Carnegie Endowment", "https://carnegieendowment.org/rss"],
  ["rss-chatham-house", "Chatham House", "https://www.chathamhouse.org/rss.xml"],
  ["rss-rand-national-security", "RAND Corporation", "https://www.rand.org/topics/national-security.rss"],
  ["rss-isw", "ISW Institute for the Study of War", "https://www.understandingwar.org/rss.xml"],
  ["rss-modern-war-institute", "Modern War Institute", "https://mwi.usma.edu/feed/"],
  ["rss-small-wars-journal", "Small Wars Journal", "https://smallwarsjournal.com/rss.xml"],
  ["rss-janes-defence", "Jane's Defence", "https://www.janes.com/feeds/rss"],
  ["rss-defense-one", "Defense One", "https://www.defenseone.com/rss/"],
  ["rss-military-times", "Military Times", "https://www.militarytimes.com/arc/outboundfeeds/rss/"],
  ["rss-breaking-defense", "Breaking Defense", "https://breakingdefense.com/feed/"],
  ["rss-arms-control-association", "Arms Control Association", "https://www.armscontrol.org/feeds/all"],
  ["rss-global-conflict-tracker", "Global Conflict Tracker", "https://www.cfr.org/global-conflict-tracker/rss.xml"],
  ["rss-international-crisis-group", "International Crisis Group", "https://www.crisisgroup.org/rss.xml"],
  ["rss-humanitarian-response", "Humanitarian Response", "https://www.humanitarianresponse.info/rss.xml"],
  ["rss-un-news-global", "UN News Global", "https://news.un.org/feed/subscribe/en/news/all/rss.xml"],
  ["rss-un-peacekeeping", "UN Peacekeeping", "https://peacekeeping.un.org/en/rss.xml"],
  ["rss-nato-news", "NATO News", "https://www.nato.int/cps/en/natohq/rss.xml"],
  ["rss-eu-external-action", "EU External Action", "https://eeas.europa.eu/rss_en.xml"],
  ["rss-osce-news", "OSCE News", "https://www.osce.org/rss.xml"],
  ["rss-google-geopolitics", "Google News Geopolitics", "https://news.google.com/rss/search?q=geopolitics", "discovery"],
  ["rss-google-war", "Google News War", "https://news.google.com/rss/search?q=war+conflict", "discovery"],
  ["rss-google-nato", "Google News NATO", "https://news.google.com/rss/search?q=nato", "discovery"],
  ["rss-google-china-military", "Google News China Military", "https://news.google.com/rss/search?q=china+military", "discovery"],
  ["rss-google-russia-war", "Google News Russia War", "https://news.google.com/rss/search?q=russia+war", "discovery"],
  ["rss-google-middle-east-conflict", "Google News Middle East Conflict", "https://news.google.com/rss/search?q=middle+east+conflict", "discovery"],
  ["rss-google-taiwan-strait", "Google News Taiwan Strait", "https://news.google.com/rss/search?q=taiwan+strait", "discovery"],
  ["rss-google-south-china-sea", "Google News South China Sea", "https://news.google.com/rss/search?q=south+china+sea+military", "discovery"],
  ["rss-google-north-korea", "Google News North Korea", "https://news.google.com/rss/search?q=north+korea+missile", "discovery"],
  ["rss-google-iran-nuclear", "Google News Iran Nuclear", "https://news.google.com/rss/search?q=iran+nuclear", "discovery"],
  ["rss-google-cyberwar", "Google News Cyberwar", "https://news.google.com/rss/search?q=cyberwar", "discovery"],
  ["rss-google-military-technology", "Google News Military Technology", "https://news.google.com/rss/search?q=military+technology", "discovery"],
  ["rss-google-defense-industry", "Google News Defense Industry", "https://news.google.com/rss/search?q=defense+industry", "discovery"],
  ["rss-google-intelligence-agencies", "Google News Intelligence Agencies", "https://news.google.com/rss/search?q=intelligence+agency", "discovery"],
  ["rss-google-strategic-weapons", "Google News Strategic Weapons", "https://news.google.com/rss/search?q=strategic+weapons", "discovery"],
  ["rss-google-global-sanctions", "Google News Global Sanctions", "https://news.google.com/rss/search?q=international+sanctions", "discovery"],
  ["rss-reuters-world", "Reuters World", "http://feeds.reuters.com/Reuters/worldNews"],
  ["rss-cnn-world", "CNN World", "http://rss.cnn.com/rss/edition_world.rss"],
  ["rss-bbc-world", "BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["rss-guardian-world", "The Guardian World", "https://www.theguardian.com/world/rss"],
  ["rss-new-york-times-world", "New York Times World", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"],
  ["rss-washington-post-world", "Washington Post World", "http://feeds.washingtonpost.com/rss/world"],
  ["rss-al-jazeera", "Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"],
  ["rss-france24-world", "France24 World", "https://www.france24.com/en/rss"],
  ["rss-dw-world", "DW World", "https://rss.dw.com/xml/rss-en-world"],
  ["rss-euronews-world", "Euronews World", "https://www.euronews.com/rss?level=theme&name=world"],
  ["rss-sky-news-world", "Sky News World", "https://feeds.skynews.com/feeds/rss/world.xml"],
  ["rss-financial-times-world", "Financial Times World", "https://www.ft.com/world?format=rss"],
  ["rss-politico-europe", "Politico Europe", "https://www.politico.eu/feed/"],
  ["rss-telegraph-world", "The Telegraph World", "https://www.telegraph.co.uk/news/world/rss.xml"],
  ["rss-independent-world", "The Independent World", "https://www.independent.co.uk/news/world/rss"],
  ["rss-abc-international", "ABC International", "https://abcnews.go.com/abcnews/internationalheadlines"],
  ["rss-fox-world", "Fox World", "https://moxie.foxnews.com/google-publisher/world.xml"],
  ["rss-nbc-world", "NBC World News", "http://feeds.nbcnews.com/feeds/worldnews"],
  ["rss-cbs-world", "CBS World News", "https://www.cbsnews.com/latest/rss/world"],
  ["rss-yahoo-world", "Yahoo World News", "https://www.yahoo.com/news/rss/world"],
  ["rss-npr-world", "NPR World", "https://feeds.npr.org/1004/rss.xml"],
  ["rss-zerohedge-disabled", "ZeroHedge", "https://www.zerohedge.com/", "editorial", false, "disabled-until-valid-xml-feed"]
]);

const GENERATED_COUNTRY_TERMS = Object.freeze([
  "United States", "Ukraine", "Russia", "China", "Taiwan", "Israel", "Iran", "Turkey", "India", "Pakistan",
  "South Korea", "North Korea", "Syria", "Iraq", "Yemen", "Sudan", "Ethiopia", "Venezuela", "Myanmar",
  "Afghanistan", "European Union", "Middle East", "NATO", "South China Sea", "Arctic", "Sahel", "Baltic",
  "Red Sea", "Black Sea"
]);

const GENERATED_TOPIC_TERMS = Object.freeze([
  "conflict", "sanctions", "cyber", "defense", "shipping", "energy", "election", "protest", "earthquake",
  "wildfire", "satellite launch", "prediction market", "inflation", "food security", "water stress"
]);

const REQUIRED_FIELDS = Object.freeze([
  "sourceId", "type", "name", "publisher", "hostname", "role", "topics", "countries", "languages",
  "instrumentIds", "priority", "enabled", "status", "expectedCadence", "licensePolicy", "contentPolicy",
  "verifiedAt", "provenance", "healthPolicy"
]);
const TYPES = new Set(["rss", "generated_search", "discovery"]);
const ROLES = new Set(["primary", "official", "editorial", "discovery"]);
const STATUSES = new Set(["configured", "disabled", "healthy", "degraded", "unhealthy", "retired"]);

function slug(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function canonicalizeSourceUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("invalid-news-source-url");
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  const entries = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  url.search = "";
  for (const [key, entry] of entries) url.searchParams.append(key, entry);
  return url.toString();
}

function stableQueryDefinition(value = {}) {
  const locale = value.locale && typeof value.locale === "object"
    ? Object.fromEntries(Object.entries(value.locale)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, String(entry || "").trim()]))
    : null;
  return JSON.stringify({
    provider: String(value.provider || "").trim().toLowerCase(),
    query: String(value.query || "").trim().replace(/\s+/g, " "),
    locale
  });
}

function sourceIdentity(entry) {
  return entry.type === "generated_search"
    ? `query:${stableQueryDefinition({ ...entry.queryDefinition, provider: entry.queryProvider })}`
    : `url:${canonicalizeSourceUrl(entry.url)}`;
}

function baseMetadata({ priority, cadenceMs, policyId }) {
  return {
    topics: [], countries: [], languages: ["en"], instrumentIds: [], priority,
    status: "configured", expectedCadence: { minPollIntervalMs: cadenceMs },
    licensePolicy: "unverified", contentPolicy: "headline-summary-link-out", verifiedAt: null,
    provenance: {
      origin: "legacy-inventory",
      catalogVersion: NEWS_SOURCE_CATALOG_VERSION,
      methodVersion: NEWS_SOURCE_CATALOG_METHOD_VERSION
    },
    healthPolicy: { policyId }
  };
}

function rssEntry([sourceId, name, url, role = "primary", enabled = true, disabledReason = null]) {
  return {
    sourceId, type: "rss", name, publisher: null, url,
    hostname: new URL(url).hostname.toLowerCase(), role, ...baseMetadata({ priority: 100, cadenceMs: 15 * 60_000, policyId: "rss-default-v1" }),
    enabled, status: enabled ? "configured" : "disabled", disabledReason
  };
}

function generatedSearchEntry(country, topic) {
  const query = `"${country}" ${topic}`;
  return {
    sourceId: `search-google-news-${slug(country)}-${slug(topic)}`,
    type: "generated_search", name: `Google News ${country} ${topic}`, publisher: null,
    queryDefinition: { query, locale: { hl: "en-US", gl: "US", ceid: "US:en" } },
    queryProvider: "google-news-rss", hostname: "news.google.com", role: "discovery",
    ...baseMetadata({ priority: 20, cadenceMs: 60 * 60_000, policyId: "generated-search-default-v1" }),
    topics: [topic], countries: [country], enabled: true
  };
}

export function validateNewsSourceCatalog(catalog) {
  if (!catalog
    || catalog.schemaVersion !== NEWS_SOURCE_CATALOG_SCHEMA_VERSION
    || typeof catalog.catalogVersion !== "string"
    || !catalog.catalogVersion.trim()
    || catalog.methodVersion !== NEWS_SOURCE_CATALOG_METHOD_VERSION
    || !Array.isArray(catalog.entries)) {
    throw new Error("invalid-news-source-catalog-envelope");
  }
  const ids = new Set(); const identities = new Map();
  for (const entry of catalog.entries) {
    const missing = REQUIRED_FIELDS.filter((field) => !Object.hasOwn(entry || {}, field));
    if (missing.length) throw new Error(`invalid-news-source:${entry?.sourceId || "unknown"}:missing-${missing.join(",")}`);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(entry.sourceId) || ids.has(entry.sourceId)) throw new Error(`invalid-or-duplicate-source-id:${entry.sourceId}`);
    if (!TYPES.has(entry.type) || !ROLES.has(entry.role)) throw new Error(`invalid-news-source-type-or-role:${entry.sourceId}`);
    const listFields = [entry.topics, entry.countries, entry.languages, entry.instrumentIds];
    if (!listFields.every((values) => Array.isArray(values)
      && values.every((value) => typeof value === "string" && value.trim())
      && new Set(values).size === values.length)) {
      throw new Error(`invalid-news-source-arrays:${entry.sourceId}`);
    }
    if (!Number.isFinite(entry.priority)
      || entry.priority < 0
      || typeof entry.enabled !== "boolean"
      || typeof entry.name !== "string"
      || !entry.name.trim()
      || typeof entry.hostname !== "string"
      || entry.hostname !== entry.hostname.toLowerCase()
      || (entry.publisher !== null && (typeof entry.publisher !== "string" || !entry.publisher.trim()))
      || (entry.enabled && ["disabled", "retired"].includes(entry.status))
      || (!entry.enabled && !["disabled", "retired"].includes(entry.status))
      || !STATUSES.has(entry.status)) {
      throw new Error(`invalid-news-source-fields:${entry.sourceId}`);
    }
    if (!Number.isFinite(entry.expectedCadence?.minPollIntervalMs)
      || entry.expectedCadence.minPollIntervalMs <= 0
      || !entry.licensePolicy
      || !entry.contentPolicy
      || entry.provenance?.catalogVersion !== catalog.catalogVersion
      || !entry.provenance?.methodVersion
      || !entry.healthPolicy?.policyId) {
      throw new Error(`invalid-news-source-policy:${entry.sourceId}`);
    }
    if (entry.verifiedAt !== null && !Number.isFinite(Date.parse(entry.verifiedAt))) throw new Error(`invalid-news-source-verified-at:${entry.sourceId}`);
    if (entry.type === "generated_search") {
      if (entry.url
        || !entry.queryDefinition?.query
        || !["hl", "gl", "ceid"].every((field) => typeof entry.queryDefinition?.locale?.[field] === "string" && entry.queryDefinition.locale[field].trim())
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(entry.queryProvider)
        || new URL(`https://${entry.hostname}`).hostname !== entry.hostname) {
        throw new Error(`invalid-generated-search:${entry.sourceId}`);
      }
    } else {
      if (!entry.url || entry.queryDefinition) throw new Error(`invalid-url-source:${entry.sourceId}`);
      const canonicalUrl = canonicalizeSourceUrl(entry.url);
      if (new URL(canonicalUrl).hostname !== entry.hostname) throw new Error(`invalid-news-source-hostname:${entry.sourceId}`);
    }
    const identity = sourceIdentity(entry);
    if (identities.has(identity)) throw new Error(`duplicate-news-source-identity:${identities.get(identity)}:${entry.sourceId}`);
    ids.add(entry.sourceId); identities.set(identity, entry.sourceId);
  }
  return catalog;
}

export function createNewsSourceCatalog(entries, { catalogVersion = NEWS_SOURCE_CATALOG_VERSION } = {}) {
  const normalizedEntries = structuredClone(entries).map((entry) => ({
    ...entry,
    provenance: { ...entry.provenance, catalogVersion }
  }));
  const catalog = {
    schemaVersion: NEWS_SOURCE_CATALOG_SCHEMA_VERSION,
    catalogVersion,
    methodVersion: NEWS_SOURCE_CATALOG_METHOD_VERSION,
    entries: normalizedEntries
  };
  validateNewsSourceCatalog(catalog);
  return deepFreeze(catalog);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

const entries = [
  ...RSS_SOURCE_ROWS.map(rssEntry),
  ...GENERATED_COUNTRY_TERMS.flatMap((country) => GENERATED_TOPIC_TERMS.map((topic) => generatedSearchEntry(country, topic)))
];

export const NEWS_SOURCE_CATALOG = createNewsSourceCatalog(entries);

export function renderGeneratedSearchUrl(entry) {
  if (entry?.type !== "generated_search" || entry.queryProvider !== "google-news-rss") throw new Error(`unsupported-generated-search:${entry?.sourceId || "unknown"}`);
  const locale = entry.queryDefinition.locale;
  return `https://${entry.hostname}/rss/search?q=${encodeURIComponent(entry.queryDefinition.query)}&hl=${encodeURIComponent(locale.hl)}&gl=${encodeURIComponent(locale.gl)}&ceid=${encodeURIComponent(locale.ceid)}`;
}

function legacyFeed(entry) {
  const url = entry.type === "generated_search" ? renderGeneratedSearchUrl(entry) : entry.url;
  return {
    sourceId: entry.sourceId, type: entry.type, label: entry.name, publisher: entry.publisher, url,
    disabled: !entry.enabled, reason: entry.disabledReason || (!entry.enabled ? entry.status : null),
    generated: entry.type === "generated_search", priority: entry.priority,
    minPollIntervalMs: entry.expectedCadence.minPollIntervalMs, queryDefinition: entry.queryDefinition || null,
    queryProvider: entry.queryProvider || null, provenance: structuredClone(entry.provenance)
  };
}

export function projectLegacyRssFeeds(catalog = NEWS_SOURCE_CATALOG) {
  validateNewsSourceCatalog(catalog);
  return catalog.entries.filter((entry) => entry.type === "rss").map(legacyFeed);
}

export function projectLegacyGeneratedSearches(catalog = NEWS_SOURCE_CATALOG) {
  validateNewsSourceCatalog(catalog);
  return catalog.entries.filter((entry) => entry.type === "generated_search").map(legacyFeed);
}

export function projectLegacyExtendedCatalog(catalog = NEWS_SOURCE_CATALOG) {
  return [...projectLegacyRssFeeds(catalog), ...projectLegacyGeneratedSearches(catalog)];
}

export function summarizeNewsSourceCatalog(catalog = NEWS_SOURCE_CATALOG) {
  validateNewsSourceCatalog(catalog);
  const byType = { rss: 0, generated_search: 0, discovery: 0 };
  for (const entry of catalog.entries) byType[entry.type] += 1;
  return {
    total: catalog.entries.length, byType,
    enabledRss: catalog.entries.filter((entry) => entry.type === "rss" && entry.enabled).length,
    disabledRss: catalog.entries.filter((entry) => entry.type === "rss" && !entry.enabled).length,
    identityDigest: createHash("sha256").update(catalog.entries.map(sourceIdentity).join("\n")).digest("hex")
  };
}

export function coerceLegacyRssFeeds(feeds = []) {
  const converted = feeds.map((feed) => {
    if (feed?.sourceId && feed?.type === "rss") return structuredClone(feed);
    const url = String(feed?.url || feed || "").trim();
    const name = String(feed?.label || new URL(url).hostname);
    const id = `rss-override-${createHash("sha256").update(canonicalizeSourceUrl(url)).digest("hex").slice(0, 16)}`;
    return legacyFeed(rssEntry([id, name, url, "editorial", !feed?.disabled, feed?.reason || null]));
  });
  return converted;
}
