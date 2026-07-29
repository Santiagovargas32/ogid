import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { detectCountryMentions, getCountryByIso2 } from "../../utils/countryCatalog.js";
import { sanitizeArticleContent } from "../news/newsContentSanitizer.js";
import { parseFeedArticles } from "../news/providers/rssProvider.js";

const EVENT_SCHEMA_VERSION = "awareness-event-v1";
const TIME_ZONE_ALIASES = Object.freeze({
  "US-Eastern": "America/New_York"
});
const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
});

const REGION_PATTERNS = Object.freeze([
  ["Global", /\b(?:global|worldwide)\b/i],
  ["Middle East", /\bmiddle east\b/i],
  ["Red Sea", /\bred sea\b/i],
  ["Strait of Hormuz", /\bstrait of hormuz\b/i],
  ["Persian Gulf", /\bpersian gulf\b/i],
  ["Gulf of Oman", /\bgulf of oman\b/i],
  ["Gulf of Aden", /\bgulf of aden\b/i],
  ["Arabian Sea", /\barabian sea\b/i],
  ["Black Sea", /\bblack sea\b/i],
  ["Sea of Azov", /\bsea of azov\b/i],
  ["Gulf of Guinea", /\bgulf of guinea\b/i],
  ["Eastern Mediterranean", /\beastern mediterranean\b/i]
]);

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function loadSafeHtml(body = "") {
  const $ = cheerio.load(body);
  $("script,style,noscript,iframe,object,embed,template").remove();
  return $;
}

function elementText($, element) {
  const clone = $(element).clone();
  clone.find("*").each((_index, child) => {
    clone.find(child).before(" ").after(" ");
  });
  return cleanText(clone.text());
}

function canonicalUrl(value, sourceUrl) {
  try {
    const url = new URL(String(value || ""), sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password) return sourceUrl;
    url.hash = "";
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function zonedDateTimeToUtc(parts, timeZone = "UTC") {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  if (timeZone === "UTC") return new Date(desired).toISOString();
  let candidate = desired;
  for (let pass = 0; pass < 3; pass += 1) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    const values = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const observed = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    candidate += desired - observed;
  }
  return new Date(candidate).toISOString();
}

function parseClock(text = "") {
  const match = cleanText(text).match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const pm = match[3].toLowerCase().startsWith("p");
  if (hour === 12) hour = 0;
  if (pm) hour += 12;
  return { hour, minute: Number(match[2] || 0) };
}

function parseHumanDateTime(text = "", { timeZone = "UTC", fallbackYear = new Date().getUTCFullYear(), fallbackMonth = null } = {}) {
  const normalized = cleanText(text);
  const named = normalized.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
  const reversed = normalized.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})\b/i);
  const numeric = normalized.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  let year;
  let month;
  let day;
  if (named) {
    year = Number(named[3] || fallbackYear);
    month = MONTHS[named[1].toLowerCase()];
    day = Number(named[2]);
  } else if (reversed) {
    year = Number(reversed[3]);
    month = MONTHS[reversed[2].toLowerCase()];
    day = Number(reversed[1]);
  } else if (numeric) {
    year = Number(numeric[3]);
    month = Number(numeric[1]);
    day = Number(numeric[2]);
  } else if (fallbackMonth) {
    const dayMatch = normalized.match(/(?:^|\s)([12]?\d|3[01])(?:\s|$)/);
    if (!dayMatch) return null;
    year = fallbackYear;
    month = fallbackMonth;
    day = Number(dayMatch[1]);
  } else {
    return null;
  }
  const clock = parseClock(normalized) || { hour: 0, minute: 0 };
  try {
    return zonedDateTimeToUtc({ year, month, day, ...clock }, timeZone);
  } catch {
    return null;
  }
}

function unescapeIcsText(value = "") {
  return String(value || "").replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

function parseIcsTimestamp(value = "", params = {}, fallbackTimezone = "UTC") {
  const normalized = String(value || "").trim();
  if (/^\d{8}T\d{6}Z$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}T${normalized.slice(9, 11)}:${normalized.slice(11, 13)}:${normalized.slice(13, 15)}.000Z`;
  }
  const match = normalized.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?$/);
  if (!match) return isoOrNull(normalized);
  const requestedTimeZone = String(params.TZID || fallbackTimezone).replace(/^"|"$/g, "");
  const timeZone = TIME_ZONE_ALIASES[requestedTimeZone] || requestedTimeZone;
  return zonedDateTimeToUtc({
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0)
  }, timeZone);
}

function importanceFor(title = "", kind = "") {
  const text = cleanText(title).toLowerCase();
  if (/\b(fomc|interest rate|rate decision|consumer price|\bcpi\b|producer price|\bppi\b|employment situation|nonfarm|payroll|gross domestic product|\bgdp\b|personal income|\bpce\b)/i.test(text)) return "high";
  if (/\b(missile|airstrike|strike|attack|blockade|intercept|hostage|ceasefire|jolts|employment cost|trade balance|central bank|monetary policy)/i.test(text)) return "high";
  if (["official_security_release", "maritime_alert", "regulatory_filing"].includes(kind)) return "medium";
  return "low";
}

function assetClassesFor(text = "") {
  const normalized = cleanText(text).toLowerCase();
  const values = new Set();
  if (/fomc|interest rate|inflation|consumer price|producer price|employment|payroll|gdp|pce|central bank/.test(normalized)) ["equities", "bonds", "fx"].forEach((value) => values.add(value));
  if (/oil|gas|energy|opec|hormuz|red sea|tanker|maritime|shipping/.test(normalized)) ["commodities", "equities"].forEach((value) => values.add(value));
  if (/bitcoin|crypto|digital asset/.test(normalized)) values.add("crypto");
  return [...values];
}

function correlationIssuerFor(source = {}, title = "") {
  const identity = `${source.sourceId || ""} ${source.name || ""} ${title}`.toLowerCase();
  if (/\bfomc\b|federal reserve|federal open market/.test(identity)) return "fed";
  if (/bureau of labor statistics|\bbls\b/.test(identity)) return "bls";
  if (/bureau of economic analysis|\bbea\b/.test(identity)) return "bea";
  if (/european central bank|\becb\b/.test(identity)) return "ecb";
  return String(source.sourceId || "unknown-issuer").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unknown-issuer";
}

function correlationKeyFor(title = "", scheduledAt = null, publishedAt = null, source = {}) {
  const text = cleanText(title).toLowerCase();
  const issuer = correlationIssuerFor(source, title);
  let family = null;
  if (/fomc.*press conference|press conference.*fomc/.test(text)) family = `${issuer}-press-conference`;
  else if (/fomc|federal reserve.*rate|interest rate decision|monetary policy decision/.test(text)) {
    // Preserve the persisted Fed key while keeping other central banks issuer-scoped.
    family = issuer === "fed" ? "fed-fomc" : `${issuer}-rate-decision`;
  }
  else if (/consumer price|\bcpi\b/.test(text)) family = `${issuer}-cpi`;
  else if (/producer price|\bppi\b/.test(text)) family = `${issuer}-ppi`;
  else if (/employment situation|nonfarm|payroll/.test(text)) family = `${issuer}-employment`;
  else if (/job openings|jolts/.test(text)) family = `${issuer}-jolts`;
  else if (/gross domestic product|\bgdp\b/.test(text)) family = `${issuer}-gdp`;
  else if (/personal income|\bpce\b/.test(text)) family = `${issuer}-pce`;
  if (!family) return null;
  const date = String(scheduledAt || publishedAt || "").slice(0, 10);
  return date ? `${family}:${date}` : family;
}

function locationFor(text = "", countries = []) {
  for (const [label, pattern] of REGION_PATTERNS) {
    if (pattern.test(text)) return { lat: null, lng: null, label, precision: "region", method: "explicit-region-text", confidence: 0.8 };
  }
  if (countries.length === 1) {
    const country = getCountryByIso2(countries[0]);
    if (country) return { lat: country.lat, lng: country.lng, label: country.name, precision: "country", method: "explicit-country-centroid", confidence: 0.55 };
  }
  return null;
}

export function createAwarenessEvent({
  source,
  title,
  summary = "",
  canonicalUrl: eventUrl,
  scheduledAt = null,
  publishedAt = null,
  updatedAt = null,
  status = null,
  kind = null,
  rawId = null,
  countries = null,
  location = undefined,
  observedAt = new Date().toISOString(),
  dataMode = "observed",
  stale = false
} = {}) {
  const sanitized = sanitizeArticleContent({ title, description: summary, content: summary });
  if (!sanitized.title) return null;
  const resolvedUrl = canonicalUrl(eventUrl, source.url);
  const resolvedScheduledAt = isoOrNull(scheduledAt);
  const resolvedPublishedAt = isoOrNull(publishedAt);
  const resolvedUpdatedAt = isoOrNull(updatedAt) || resolvedPublishedAt || resolvedScheduledAt || null;
  const resolvedKind = kind || source.kind;
  const text = `${sanitized.title}. ${sanitized.excerpt || ""}`;
  const resolvedCountries = [...new Set(countries || detectCountryMentions(text))];
  const resolvedLocation = location === undefined && ["official_security_release", "maritime_alert"].includes(resolvedKind)
    ? locationFor(text, resolvedCountries)
    : location || null;
  const resolvedStatus = status || (resolvedScheduledAt && !resolvedPublishedAt ? "scheduled" : "released");
  const identity = rawId || resolvedUrl || `${sanitized.title}|${resolvedScheduledAt || resolvedPublishedAt || ""}`;
  const correlationKey = correlationKeyFor(sanitized.title, resolvedScheduledAt, resolvedPublishedAt, source);
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: `awe-${hash(`${source.sourceId}|${identity}`)}`,
    revision: 1,
    kind: resolvedKind,
    domains: [...new Set(source.domains || [])],
    status: resolvedStatus,
    title: sanitized.title,
    summary: cleanText(sanitized.excerpt || "").slice(0, 500),
    canonicalUrl: resolvedUrl,
    scheduledAt: resolvedScheduledAt,
    publishedAt: resolvedPublishedAt,
    observedAt: isoOrNull(observedAt) || new Date().toISOString(),
    updatedAt: resolvedUpdatedAt,
    source: {
      sourceId: source.sourceId,
      name: source.name,
      role: source.role || "official",
      official: source.official !== false,
      timezone: source.timezone || "UTC"
    },
    countries: resolvedCountries,
    instrumentIds: [],
    sectors: [],
    assetClasses: assetClassesFor(text),
    importance: importanceFor(sanitized.title, resolvedKind),
    importanceMethod: "rule-v1",
    location: resolvedLocation,
    claimStatus: ["official_security_release", "maritime_alert"].includes(resolvedKind) ? "source_asserted" : "reported",
    provenance: {
      adapter: source.adapter,
      sourceUrl: source.url,
      fetchedAt: isoOrNull(observedAt) || new Date().toISOString(),
      methodVersion: "awareness-parser-v1",
      stale: Boolean(stale)
    },
    dataMode: stale ? "stale" : dataMode,
    correlationKey
  };
}

export function parseIcsEvents(ics = "", source, { observedAt = new Date().toISOString() } = {}) {
  const unfolded = String(ics || "").replace(/\r?\n[ \t]/g, "");
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  return blocks.map((block) => {
    const properties = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const descriptor = line.slice(0, separator);
      const value = line.slice(separator + 1);
      const [name, ...rawParams] = descriptor.split(";");
      const params = Object.fromEntries(rawParams.map((entry) => {
        const [key, ...parts] = entry.split("=");
        return [key.toUpperCase(), parts.join("=")];
      }));
      properties[name.toUpperCase()] = { value, params };
    }
    const scheduledAt = parseIcsTimestamp(properties.DTSTART?.value, properties.DTSTART?.params, source.timezone);
    const status = String(properties.STATUS?.value || "").toUpperCase() === "CANCELLED" ? "cancelled" : "scheduled";
    return createAwarenessEvent({
      source,
      rawId: properties.UID?.value || null,
      title: unescapeIcsText(properties.SUMMARY?.value),
      summary: unescapeIcsText(properties.DESCRIPTION?.value),
      canonicalUrl: unescapeIcsText(properties.URL?.value) || source.url,
      scheduledAt,
      updatedAt: parseIcsTimestamp(properties["LAST-MODIFIED"]?.value, properties["LAST-MODIFIED"]?.params, "UTC"),
      status,
      observedAt
    });
  }).filter(Boolean);
}

function parseRssEvents(body, source, observedAt) {
  const feedDocument = scopedFeedDocument(body);
  const pathPrefixes = Array.isArray(source.rssItemPathPrefixes) ? source.rssItemPathPrefixes : [];
  const allowedItemHosts = new Set((Array.isArray(source.rssItemAllowedHosts) ? source.rssItemAllowedHosts : []).map((host) => String(host).toLowerCase()));
  const articles = parseFeedArticles(feedDocument, source.name, {
    sourceId: source.sourceId,
    publisher: source.name,
    type: "rss",
    provenance: { methodVersion: "awareness-rss-v1" }
  }).filter((article) => {
    if (source.requireSourceTimestamp && article.provenance?.publishedAtQuality !== "source") return false;
    if (!pathPrefixes.length && !allowedItemHosts.size) return true;
    try {
      const url = new URL(article.url);
      if (allowedItemHosts.size && !allowedItemHosts.has(url.hostname.toLowerCase())) return false;
      return !pathPrefixes.length || pathPrefixes.some((prefix) => url.pathname.startsWith(prefix));
    } catch {
      return false;
    }
  });
  return articles.map((article) => createAwarenessEvent({
    source,
    rawId: article.url || article.title,
    title: article.title,
    summary: article.excerpt || article.description,
    canonicalUrl: article.url,
    publishedAt: article.publishedAt,
    status: source.kind === "maritime_alert"
      ? /\b(cancel(?:led|lation)?|rescinded|expired)\b/i.test(`${article.title || ""} ${article.description || ""}`)
        ? "cancelled"
        : /\b(supersed(?:e|es|ed|ing))\b/i.test(`${article.title || ""} ${article.description || ""}`)
          ? "updated"
          : "live"
      : null,
    observedAt,
    stale: article.dataMode === "stale"
  })).filter(Boolean);
}

function scopedFeedDocument(body = "") {
  const document = String(body || "").replace(/^\uFEFF/, "").trim();
  const $ = cheerio.load(document, { xmlMode: true, decodeEntities: false });
  const roots = $.root().children().toArray().filter((node) => node.type === "tag");
  if (roots.length !== 1) throw new Error("awareness-rss-envelope-invalid");
  const root = roots[0];
  const rootName = String(root.name || "").toLowerCase();
  if (!["rss", "feed", "rdf:rdf"].includes(rootName)) throw new Error("awareness-rss-envelope-invalid");
  const escapedRoot = String(root.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`</${escapedRoot}\\s*>(?:\\s|<!--[\\s\\S]*?-->)*$`, "i").test(document)) {
    throw new Error("awareness-rss-envelope-invalid");
  }

  const directChildren = (element, name) => $(element).children().toArray()
    .filter((node) => node.type === "tag" && String(node.name || "").toLowerCase() === name);
  const serialize = (nodes) => nodes.map((node) => $.xml(node)).join("");
  if (rootName === "rss") {
    const channels = directChildren(root, "channel");
    const elementChildren = $(root).children().toArray().filter((node) => node.type === "tag");
    if (channels.length !== 1 || elementChildren.length !== 1) throw new Error("awareness-rss-envelope-invalid");
    const channel = channels[0];
    return `<rss><channel>${serialize(directChildren(channel, "title").slice(0, 1))}${serialize(directChildren(channel, "item"))}</channel></rss>`;
  }
  if (rootName === "feed") {
    return `<feed>${serialize(directChildren(root, "title").slice(0, 1))}${serialize(directChildren(root, "entry"))}</feed>`;
  }
  return `<rdf:RDF>${serialize(directChildren(root, "channel").slice(0, 1))}${serialize(directChildren(root, "item"))}</rdf:RDF>`;
}

function extractPageMonthYear($) {
  const match = elementText($, $("body")).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  return match ? { month: MONTHS[match[1].toLowerCase()], year: Number(match[2]) } : {};
}

function parseFedReleaseDateTime(context, source, page = {}, releaseColumn = "") {
  const releaseText = releaseColumn ? `Release Date: ${cleanText(releaseColumn)}` : cleanText(context);
  const releaseDate = releaseText.match(/\brelease\s+date(?:\(s\)|s)?\s*:?\s*(?:(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+)?(\d{1,2})(?:,?\s+(20\d{2}))?/i);
  if (!releaseDate) return parseHumanDateTime(context, { timeZone: source.timezone, fallbackYear: page.year, fallbackMonth: page.month });
  const clock = parseClock(context) || { hour: 0, minute: 0 };
  const month = releaseDate[1] ? MONTHS[releaseDate[1].toLowerCase()] : page.month;
  const year = Number(releaseDate[3] || page.year);
  const day = Number(releaseDate[2]);
  if (!month || !Number.isFinite(year) || day < 1 || day > 31) return null;
  try {
    return zonedDateTimeToUtc({ year, month, day, ...clock }, source.timezone);
  } catch {
    return null;
  }
}

function candidateContainer($, element) {
  const candidate = $(element).closest("tr, article, li, .eventlist__event, .row, .card, .views-row");
  return candidate.length ? candidate.first() : $(element).parent();
}

function parseFedCalendarHtml(body, source, observedAt) {
  const $ = loadSafeHtml(body);
  const page = extractPageMonthYear($);
  const events = [];
  const seen = new Set();
  const addEvent = (element, container, releaseColumn = "") => {
    const title = cleanText($(element).text());
    if (!/FOMC|Press Conference|Beige Book|Testimony|Speech|Statistical Release|Industrial Production|Consumer Credit/i.test(title)) return;
    const context = elementText($, container);
    const scheduledAt = parseFedReleaseDateTime(context, source, page, releaseColumn);
    if (!scheduledAt) return;
    const url = canonicalUrl($(element).attr("href") || source.url, source.url);
    const key = `${title}|${scheduledAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rawId = url !== source.url ? url : `${title}|${page.year || new Date(scheduledAt).getUTCFullYear()}-${page.month || new Date(scheduledAt).getUTCMonth() + 1}`;
    events.push(createAwarenessEvent({ source, rawId, title, summary: context, canonicalUrl: url, scheduledAt, observedAt }));
  };

  $(".row").each((_index, row) => {
    const timeColumn = $(row).find(".col-xs-2").first();
    const detailColumn = $(row).find(".col-xs-7").first();
    const releaseColumn = $(row).find(".col-xs-3").last();
    if (!timeColumn.length || !detailColumn.length || !releaseColumn.length || !parseClock(elementText($, timeColumn))) return;
    const titleElement = detailColumn.find("a,p,h3,h4,h5,.eventlist__event__title").filter((_titleIndex, element) =>
      /FOMC|Press Conference|Beige Book|Testimony|Speech|Statistical Release|Industrial Production|Consumer Credit/i.test(cleanText($(element).text()))
    ).first();
    if (titleElement.length) addEvent(titleElement, $(row), elementText($, releaseColumn));
  });

  $("a, h3, h4, h5, .eventlist__event__title").each((_index, element) => {
    const container = candidateContainer($, element);
    addEvent(element, container);
  });
  return events.filter(Boolean);
}

function parseBeaScheduleHtml(body, source, observedAt) {
  const $ = loadSafeHtml(body);
  const events = [];
  $("tr").each((_index, row) => {
    const cells = $(row).find("th,td").map((_cellIndex, cell) => elementText($, cell)).get();
    if (cells.length < 2) return;
    const context = cells.join(" ");
    const scheduledAt = parseHumanDateTime(context, { timeZone: source.timezone });
    const title = cells.slice(1).sort((left, right) => right.length - left.length)[0];
    if (!scheduledAt || !title || !/GDP|Gross Domestic Product|Personal Income|Trade|Transactions|Investment|Corporate Profits|PCE|Economic/i.test(title)) return;
    const link = $(row).find("a[href]").first();
    const url = canonicalUrl(link.attr("href") || source.url, source.url);
    events.push(createAwarenessEvent({
      source,
      rawId: url !== source.url ? url : title,
      title,
      summary: context,
      canonicalUrl: url,
      scheduledAt,
      observedAt
    }));
  });
  return events.filter(Boolean);
}

function parseReleaseLinks(body, source, observedAt, { hrefPattern, titlePattern = null } = {}) {
  const $ = loadSafeHtml(body);
  const events = [];
  const seen = new Set();
  $("a[href]").each((_index, anchor) => {
    const href = String($(anchor).attr("href") || "");
    const title = cleanText($(anchor).text());
    if (!hrefPattern.test(href) || title.length < 10 || (titlePattern && !titlePattern.test(title))) return;
    const url = canonicalUrl(href, source.url);
    if (url === source.url || new URL(url).hostname !== new URL(source.url).hostname) return;
    if (seen.has(url)) return;
    const context = elementText($, candidateContainer($, anchor));
    const publishedAt = parseHumanDateTime(context, { timeZone: source.timezone });
    if (!publishedAt) return;
    seen.add(url);
    events.push(createAwarenessEvent({
      source,
      rawId: url,
      title,
      summary: context === title ? "" : context,
      canonicalUrl: url,
      publishedAt,
      observedAt
    }));
  });
  return events.filter(Boolean);
}

function parseCentcomHtml(body, source, observedAt) {
  const $ = loadSafeHtml(body);
  const events = [];
  const seen = new Set();
  $("a[href]").each((_index, anchor) => {
    const href = String($(anchor).attr("href") || "");
    if (!/\/MEDIA\/PUBLIC-RELEASES\/Article\/\d+\//i.test(href)) return;
    const title = cleanText($(anchor).text());
    if (title.length < 10) return;
    const url = canonicalUrl(href, source.url);
    if (url === source.url || new URL(url).hostname !== new URL(source.url).hostname || seen.has(url)) return;
    const emphasis = $(anchor).closest("b,strong");
    let node = emphasis.length ? emphasis[0].nextSibling : anchor.nextSibling;
    const dateParts = [];
    while (node && String(node.name || "").toLowerCase() !== "br") {
      dateParts.push(node.type === "text" ? node.data : $(node).text());
      node = node.nextSibling;
    }
    const publishedAt = parseHumanDateTime(dateParts.join(" "), { timeZone: source.timezone });
    if (!publishedAt) return;
    seen.add(url);
    events.push(createAwarenessEvent({
      source,
      rawId: url,
      title,
      canonicalUrl: url,
      publishedAt,
      observedAt
    }));
  });
  return events.filter(Boolean);
}

function parseMaradHtml(body, source, observedAt) {
  const $ = loadSafeHtml(body);
  const events = [];
  $("tr").each((_index, row) => {
    const cells = $(row).find("th,td").map((_cellIndex, cell) => elementText($, cell)).get();
    if (cells.length < 2) return;
    const identifier = cells.find((value) => /\b\d{4}-\d{3}\b/.test(value));
    const title = cells.find((value) => /Advisory|Alert/i.test(value) && value !== identifier) || identifier;
    if (!title) return;
    const context = cells.join(" ");
    const cancelled = /cancelled|canceled/i.test(context);
    const active = /\bactive\b/i.test(context);
    const publishedAt = parseHumanDateTime(context, { timeZone: source.timezone });
    const link = $(row).find("a[href]").first();
    events.push(createAwarenessEvent({
      source,
      rawId: identifier || cleanText(title).split(/\s+/)[0],
      title,
      summary: context,
      canonicalUrl: canonicalUrl(link.attr("href") || source.url, source.url),
      publishedAt,
      status: cancelled ? "cancelled" : active ? "live" : "released",
      observedAt
    }));
  });
  return events.filter(Boolean);
}

function parseUsgsGeoJson(body, source, observedAt) {
  const payload = JSON.parse(body);
  return (payload.features || []).map((feature) => {
    const coordinates = feature.geometry?.coordinates || [];
    const lat = Number(coordinates[1]);
    const lng = Number(coordinates[0]);
    return createAwarenessEvent({
      source,
      rawId: feature.id,
      title: feature.properties?.title || feature.properties?.place,
      summary: feature.properties?.place || "",
      canonicalUrl: feature.properties?.url || source.url,
      publishedAt: Number.isFinite(Number(feature.properties?.time)) ? new Date(Number(feature.properties.time)).toISOString() : null,
      updatedAt: Number.isFinite(Number(feature.properties?.updated)) ? new Date(Number(feature.properties.updated)).toISOString() : null,
      location: Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)
        ? { lat, lng, label: feature.properties?.place || "USGS event", precision: "exact", method: "official-geojson", confidence: 0.95 }
        : null,
      observedAt
    });
  }).filter(Boolean);
}

export function parseAwarenessSource(body = "", source, { observedAt = new Date().toISOString() } = {}) {
  switch (source.adapter) {
    case "ics": return parseIcsEvents(body, source, { observedAt });
    case "rss": return parseRssEvents(body, source, observedAt);
    case "fed-calendar-html": return parseFedCalendarHtml(body, source, observedAt);
    case "bea-schedule-html": return parseBeaScheduleHtml(body, source, observedAt);
    case "centcom-html": return parseCentcomHtml(body, source, observedAt);
    case "idf-html": return parseReleaseLinks(body, source, observedAt, { hrefPattern: /\/(?:en\/)?(?:idf-media-releases|mini-sites\/idf-press-releases)[^?#]*/i });
    case "marad-html": return parseMaradHtml(body, source, observedAt);
    case "generic-official-html": return parseReleaseLinks(body, source, observedAt, { hrefPattern: /press-release|recent-actions|news/i });
    case "usgs-geojson": return parseUsgsGeoJson(body, source, observedAt);
    default: return [];
  }
}

export { EVENT_SCHEMA_VERSION, parseHumanDateTime, parseIcsTimestamp, zonedDateTimeToUtc };
