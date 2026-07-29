const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const SOURCE_ROWS = [
  {
    sourceId: "awareness-fed-calendar",
    name: "Federal Reserve Calendar",
    url: "https://www.federalreserve.gov/newsevents/calendar.htm",
    adapter: "fed-calendar-html",
    urlStrategy: "fed-month",
    monthOffset: 0,
    kind: "macro_scheduled",
    domains: ["financial", "macro"],
    timezone: "America/New_York",
    minPollIntervalMs: 6 * HOUR_MS,
    priority: 100,
    tier: "P0"
  },
  {
    sourceId: "awareness-fed-calendar-next",
    name: "Federal Reserve Calendar (next month)",
    url: "https://www.federalreserve.gov/newsevents/calendar.htm",
    adapter: "fed-calendar-html",
    urlStrategy: "fed-month",
    monthOffset: 1,
    kind: "macro_scheduled",
    domains: ["financial", "macro"],
    timezone: "America/New_York",
    minPollIntervalMs: 6 * HOUR_MS,
    priority: 99,
    tier: "P0"
  },
  {
    sourceId: "awareness-fed-releases",
    name: "Federal Reserve Press Releases",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    adapter: "rss",
    kind: "macro_release",
    domains: ["financial", "macro", "regulatory"],
    timezone: "America/New_York",
    minPollIntervalMs: 5 * MINUTE_MS,
    adaptivePollIntervalMs: MINUTE_MS,
    priority: 100,
    tier: "P0"
  },
  {
    sourceId: "awareness-bls-calendar",
    name: "U.S. Bureau of Labor Statistics Calendar",
    url: "https://www.bls.gov/schedule/news_release/bls.ics",
    adapter: "ics",
    kind: "macro_scheduled",
    domains: ["financial", "macro"],
    timezone: "America/New_York",
    minPollIntervalMs: 6 * HOUR_MS,
    priority: 100,
    tier: "P0"
  },
  ...[
    ["cpi", "Consumer Price Index"],
    ["empsit", "Employment Situation"],
    ["ppi", "Producer Price Index"],
    ["jolts", "Job Openings and Labor Turnover"],
    ["eci", "Employment Cost Index"]
  ].map(([slug, label]) => ({
    sourceId: `awareness-bls-${slug}`,
    name: `BLS ${label}`,
    url: `https://www.bls.gov/feed/${slug}.rss`,
    adapter: "rss",
    kind: "macro_release",
    domains: ["financial", "macro"],
    timezone: "America/New_York",
    minPollIntervalMs: 5 * MINUTE_MS,
    adaptivePollIntervalMs: MINUTE_MS,
    priority: 95,
    tier: "P0"
  })),
  {
    sourceId: "awareness-bea-schedule",
    name: "U.S. Bureau of Economic Analysis Release Schedule",
    url: "https://www.bea.gov/news/schedule",
    adapter: "bea-schedule-html",
    kind: "macro_scheduled",
    domains: ["financial", "macro"],
    timezone: "America/New_York",
    minPollIntervalMs: 6 * HOUR_MS,
    priority: 95,
    tier: "P0"
  },
  {
    sourceId: "awareness-centcom-releases",
    name: "U.S. Central Command Public Releases",
    url: "https://www.centcom.mil/MEDIA/PRESS-RELEASES/",
    adapter: "centcom-html",
    kind: "official_security_release",
    domains: ["geopolitical", "security"],
    timezone: "America/New_York",
    minPollIntervalMs: 5 * MINUTE_MS,
    priority: 100,
    tier: "P0",
    admissionState: "blocked",
    enabled: false,
    disabledReason: "persistent-http-403"
  },
  {
    sourceId: "awareness-idf-releases",
    name: "Israel Defense Forces Media Releases",
    url: "https://www.idf.il/en/idf-media-releases/",
    adapter: "idf-html",
    kind: "official_security_release",
    domains: ["geopolitical", "security"],
    timezone: "Asia/Jerusalem",
    minPollIntervalMs: 5 * MINUTE_MS,
    priority: 100,
    tier: "P0",
    admissionState: "blocked",
    enabled: false,
    disabledReason: "official-site-incapsula-no-stable-feed",
    contentPolicy: "headline-short-excerpt-attribution-link-only"
  },
  {
    sourceId: "awareness-marad-advisories",
    name: "U.S. Maritime Alerts and Advisories",
    url: "https://www.maritime.dot.gov/msci-advisories",
    adapter: "marad-html",
    kind: "maritime_alert",
    domains: ["geopolitical", "security", "financial"],
    timezone: "America/New_York",
    minPollIntervalMs: 5 * MINUTE_MS,
    priority: 95,
    tier: "P0",
    admissionState: "blocked",
    enabled: false,
    disabledReason: "persistent-http-403"
  },
  {
    sourceId: "awareness-marad-advisories-rss",
    name: "U.S. MARAD Maritime Security Communications (RSS)",
    url: "https://www.maritime.dot.gov/taxonomy/term/441/feed",
    adapter: "rss",
    kind: "maritime_alert",
    domains: ["geopolitical", "security", "financial"],
    timezone: "America/New_York",
    minPollIntervalMs: 5 * MINUTE_MS,
    priority: 95,
    tier: "P0",
    admissionState: "probing",
    enabled: false,
    disabledReason: "intermittent-http-403-admission-lab",
    requireSourceTimestamp: true,
    fallbackFor: ["awareness-marad-advisories"],
    coverageRole: "same-publisher-alternate-transport"
  },
  {
    sourceId: "awareness-centcom-dvids",
    name: "DVIDS / U.S. Central Command Public Affairs",
    url: "https://www.dvidshub.net/rss/unit/72",
    adapter: "rss",
    kind: "official_security_release",
    domains: ["geopolitical", "security"],
    timezone: "America/New_York",
    minPollIntervalMs: 5 * MINUTE_MS,
    priority: 90,
    tier: "P0",
    admissionState: "shadow",
    role: "official-distributor",
    publisher: "U.S. Central Command Public Affairs",
    requireSourceTimestamp: true,
    rssItemPathPrefixes: ["/news/"],
    rssItemAllowedHosts: ["www.dvidshub.net", "dvidshub.net"],
    fallbackFor: ["awareness-centcom-releases"],
    coverageRole: "official-distributor"
  },
  {
    sourceId: "awareness-us-defense-releases",
    name: "U.S. Defense Releases",
    url: "https://www.war.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=9&Site=945&max=10",
    adapter: "rss",
    kind: "official_security_release",
    domains: ["geopolitical", "security"],
    timezone: "America/New_York",
    minPollIntervalMs: 15 * MINUTE_MS,
    priority: 75,
    tier: "P1",
    admissionState: "shadow",
    requireSourceTimestamp: true,
    coverageRole: "independent-thematic-coverage"
  },
  {
    sourceId: "awareness-sec-edgar-watchlist",
    name: "SEC EDGAR Watchlist Filings",
    url: "https://data.sec.gov/submissions/",
    adapter: "sec-edgar-json",
    kind: "regulatory_filing",
    domains: ["financial", "corporate", "regulatory"],
    timezone: "America/New_York",
    minPollIntervalMs: 5 * MINUTE_MS,
    priority: 90,
    tier: "P1",
    admissionState: "blocked",
    enabled: false,
    disabledReason: "requires-verified-instrument-to-cik-mapping"
  },
  {
    sourceId: "awareness-treasury-releases",
    name: "U.S. Treasury Press Releases",
    url: "https://home.treasury.gov/news/press-releases",
    adapter: "generic-official-html",
    kind: "regulatory_filing",
    domains: ["financial", "geopolitical", "regulatory"],
    timezone: "America/New_York",
    minPollIntervalMs: 15 * MINUTE_MS,
    priority: 80,
    tier: "P1",
    admissionState: "probing",
    enabled: false,
    disabledReason: "pending-source-promotion"
  },
  {
    sourceId: "awareness-ofac-actions",
    name: "OFAC Recent Actions",
    url: "https://ofac.treasury.gov/recent-actions",
    adapter: "generic-official-html",
    kind: "regulatory_filing",
    domains: ["financial", "geopolitical", "regulatory"],
    timezone: "America/New_York",
    minPollIntervalMs: 15 * MINUTE_MS,
    priority: 85,
    tier: "P1",
    admissionState: "probing",
    enabled: false,
    disabledReason: "official-rss-retired-pending-html-contract"
  },
  {
    sourceId: "awareness-ecb-rss",
    name: "European Central Bank News",
    url: "https://www.ecb.europa.eu/rss/press.html",
    adapter: "rss",
    kind: "macro_release",
    domains: ["financial", "macro"],
    timezone: "Europe/Frankfurt",
    minPollIntervalMs: 15 * MINUTE_MS,
    priority: 80,
    tier: "P1",
    admissionState: "shadow",
    requireSourceTimestamp: true
  },
  {
    sourceId: "awareness-bis-rss",
    name: "Bank for International Settlements Press Releases",
    url: "https://www.bis.org/doclist/all_pressrels.rss",
    adapter: "rss",
    kind: "macro_release",
    domains: ["financial", "macro", "regulatory"],
    timezone: "Europe/Zurich",
    minPollIntervalMs: 30 * MINUTE_MS,
    priority: 75,
    tier: "P1",
    admissionState: "shadow",
    requireSourceTimestamp: true
  },
  {
    sourceId: "awareness-usgs-significant",
    name: "USGS Significant Earthquakes",
    url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson",
    adapter: "usgs-geojson",
    kind: "market_moving_news",
    domains: ["geopolitical", "financial"],
    timezone: "UTC",
    minPollIntervalMs: 5 * MINUTE_MS,
    priority: 70,
    tier: "P1",
    admissionState: "shadow",
    emptyResultPolicy: "healthy"
  }
];

const ADMISSION_STATES = new Set(["probing", "shadow", "active", "blocked"]);

function normalizeSource(source) {
  const url = new URL(source.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`invalid-awareness-source-url:${source.sourceId}`);
  const requestedAdmissionState = String(source.admissionState || (source.enabled === false ? "probing" : "active")).toLowerCase();
  if (!ADMISSION_STATES.has(requestedAdmissionState)) throw new Error(`invalid-awareness-admission-state:${source.sourceId}`);
  const enabled = ["shadow", "active"].includes(requestedAdmissionState);
  return Object.freeze({
    role: "official",
    official: true,
    contentPolicy: source.contentPolicy || "headline-short-excerpt-attribution-link-only",
    methodVersion: "awareness-source-catalog-v2",
    ...source,
    admissionState: requestedAdmissionState,
    enabled,
    disabledReason: enabled ? null : source.disabledReason || (requestedAdmissionState === "blocked" ? "source-blocked" : "pending-source-probe"),
    domains: Object.freeze([...(source.domains || [])]),
    ...(Array.isArray(source.fallbackFor) ? { fallbackFor: Object.freeze([...source.fallbackFor]) } : {}),
    ...(Array.isArray(source.rssItemPathPrefixes) ? { rssItemPathPrefixes: Object.freeze([...source.rssItemPathPrefixes]) } : {}),
    ...(Array.isArray(source.rssItemAllowedHosts) ? { rssItemAllowedHosts: Object.freeze([...source.rssItemAllowedHosts].map((host) => String(host).toLowerCase())) } : {}),
    hostname: url.hostname.toLowerCase()
  });
}

export const AWARENESS_SOURCE_CATALOG_VERSION = "1.1.0";
export const AWARENESS_SOURCES = Object.freeze(SOURCE_ROWS.map(normalizeSource));
export const AWARENESS_ALLOWED_HOSTS = Object.freeze([...new Set(AWARENESS_SOURCES.map((source) => source.hostname))]);

export function getAwarenessSources({ enabledOnly = false, tier = null } = {}) {
  return AWARENESS_SOURCES.filter((source) => (!enabledOnly || source.enabled) && (!tier || source.tier === tier));
}

export function getAwarenessSource(sourceId) {
  return AWARENESS_SOURCES.find((source) => source.sourceId === String(sourceId || "")) || null;
}
