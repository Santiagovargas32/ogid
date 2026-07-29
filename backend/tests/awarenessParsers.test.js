import assert from "node:assert/strict";
import test from "node:test";
import { parseAwarenessSource, parseIcsEvents, zonedDateTimeToUtc } from "../services/awareness/awarenessParsers.js";

function source(overrides = {}) {
  return {
    sourceId: "test-source",
    name: "Test official source",
    url: "https://www.federalreserve.gov/newsevents/calendar.htm",
    adapter: "ics",
    kind: "macro_scheduled",
    domains: ["financial", "macro"],
    timezone: "America/New_York",
    role: "official",
    official: true,
    ...overrides
  };
}

test("ICS parser unfolds lines, applies source timezone and preserves cancellation revisions", () => {
  const events = parseIcsEvents(`BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:fomc-2026-07\r
DTSTART;TZID=America/New_York:20260729T140000\r
LAST-MODIFIED:20260720T120000Z\r
STATUS:CANCELLED\r
SUMMARY:Federal Open Market Committee Interest Rate \r
 Decision\r
DESCRIPTION:Official scheduled decision\r
URL:https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm\r
END:VEVENT\r
END:VCALENDAR`, source(), { observedAt: "2026-07-20T12:01:00.000Z" });

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Federal Open Market Committee Interest Rate Decision");
  assert.equal(events[0].scheduledAt, "2026-07-29T18:00:00.000Z");
  assert.equal(events[0].status, "cancelled");
  assert.equal(events[0].importance, "high");
});

test("timezone conversion observes daylight-saving transitions", () => {
  assert.equal(zonedDateTimeToUtc({ year: 2026, month: 3, day: 7, hour: 8, minute: 30 }, "America/New_York"), "2026-03-07T13:30:00.000Z");
  assert.equal(zonedDateTimeToUtc({ year: 2026, month: 3, day: 9, hour: 8, minute: 30 }, "America/New_York"), "2026-03-09T12:30:00.000Z");
});

test("BLS US-Eastern calendar timezone alias maps to America/New_York", () => {
  const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:bls-cpi-2026-07
DTSTART;TZID=US-Eastern:20260714T083000
SUMMARY:Consumer Price Index
END:VEVENT
END:VCALENDAR`, source({ sourceId: "awareness-bls-calendar" }), { observedAt: "2026-07-01T12:00:00.000Z" });
  assert.equal(events[0].scheduledAt, "2026-07-14T12:30:00.000Z");
});

test("official HTML adapters produce bounded, sanitized events without invented coordinates", () => {
  const observedAt = "2026-07-29T22:00:00.000Z";
  const centcom = parseAwarenessSource(`
    <div><b><a href="/MEDIA/PUBLIC-RELEASES/Article/123/test/">U.S. forces intercept ballistic missiles launched from Iran in the Middle East</a></b> July 29, 2026 5:45 p.m.<br><script>alert('x')</script></div>`, source({
      sourceId: "awareness-centcom-releases",
      name: "U.S. Central Command Public Releases",
      url: "https://www.centcom.mil/MEDIA/PRESS-RELEASES/",
      adapter: "centcom-html",
      kind: "official_security_release",
      domains: ["geopolitical", "security"]
    }), { observedAt });

  assert.equal(centcom.length, 1);
  assert.equal(centcom[0].claimStatus, "source_asserted");
  assert.equal(centcom[0].location.precision, "region");
  assert.equal(centcom[0].location.label, "Middle East");
  assert.equal(centcom[0].location.lat, null);
  assert.equal(centcom[0].location.lng, null);
  assert.deepEqual(new Set(centcom[0].countries), new Set(["US", "IR"]));
  assert.doesNotMatch(centcom[0].summary, /<script|alert\(/i);

  const idf = parseAwarenessSource(`
    <div class="views-row"><a href="/en/mini-sites/idf-press-releases-israel-at-war/july-26-pr/operational-update/">Operational update from Israel Defense Forces</a><time>July 29, 2026 8:30 p.m.</time></div>`, source({
      sourceId: "awareness-idf-releases",
      name: "Israel Defense Forces Media Releases",
      url: "https://www.idf.il/en/idf-media-releases/",
      adapter: "idf-html",
      kind: "official_security_release",
      domains: ["geopolitical", "security"],
      timezone: "Asia/Jerusalem"
    }), { observedAt });
  assert.equal(idf.length, 1);
  assert.equal(idf[0].source.official, true);
  assert.match(idf[0].canonicalUrl, /^https:\/\/www\.idf\.il\//);

  const navigationOnly = parseAwarenessSource(`
    <nav>
      <a href="/MEDIA/PRESS-RELEASES/">PUBLIC RELEASES</a>
      <a href="/News/Articles/">NEWS ARTICLES</a>
    </nav>`, source({
      sourceId: "awareness-centcom-releases",
      name: "U.S. Central Command Public Releases",
      url: "https://www.centcom.mil/MEDIA/PRESS-RELEASES/",
      adapter: "centcom-html",
      kind: "official_security_release",
      domains: ["geopolitical", "security"]
    }), { observedAt });
  assert.deepEqual(navigationOnly, []);

  const idfNavigationOnly = parseAwarenessSource(`
    <nav>
      <a href="/en/mini-sites/israel-at-war/">Israel at War</a>
      <a href="/en/mini-sites/northern-command/">Northern Command</a>
    </nav>`, source({
      sourceId: "awareness-idf-releases",
      name: "Israel Defense Forces Media Releases",
      url: "https://www.idf.il/en/idf-media-releases/",
      adapter: "idf-html",
      kind: "official_security_release",
      domains: ["geopolitical", "security"]
    }), { observedAt });
  assert.deepEqual(idfNavigationOnly, []);
});

test("Fed, BEA and MARAD HTML fixtures keep schedule/release lifecycle separate", () => {
  const observedAt = "2026-07-01T00:00:00.000Z";
  const fed = parseAwarenessSource(`<main><h1>July 2026</h1><div class="row"><div class="col-xs-2">2:00 p.m.</div><div class="col-xs-7"><p>FOMC Meeting</p><p>Two-day meeting, July 28 - 29</p></div><div class="col-xs-3">29</div></div></main>`, source({ adapter: "fed-calendar-html" }), { observedAt });
  assert.equal(fed[0].scheduledAt, "2026-07-29T18:00:00.000Z");
  assert.equal(fed[0].status, "scheduled");
  const pressConference = parseAwarenessSource(`<main><h1>July 2026</h1><div class="row"><a href="/newsevents/live-broadcast.htm">FOMC Press Conference</a><span>July 29, 2026 2:30 p.m.</span></div></main>`, source({ adapter: "fed-calendar-html" }), { observedAt });
  assert.notEqual(fed[0].correlationKey, pressConference[0].correlationKey);

  const fedRate = parseAwarenessSource(`<?xml version="1.0"?><rss><channel><item><title>Interest Rate Decision</title><link>https://www.federalreserve.gov/rate</link><pubDate>Wed, 29 Jul 2026 18:00:00 GMT</pubDate></item></channel></rss>`, source({
    sourceId: "awareness-fed-releases", name: "Federal Reserve", adapter: "rss", kind: "macro_release"
  }), { observedAt })[0];
  const ecbRate = parseAwarenessSource(`<?xml version="1.0"?><rss><channel><item><title>Interest Rate Decision</title><link>https://www.ecb.europa.eu/rate</link><pubDate>Wed, 29 Jul 2026 18:00:00 GMT</pubDate></item></channel></rss>`, source({
    sourceId: "awareness-ecb-rss", name: "European Central Bank", url: "https://www.ecb.europa.eu/rss/press.html", adapter: "rss", kind: "macro_release"
  }), { observedAt })[0];
  assert.notEqual(fedRate.correlationKey, ecbRate.correlationKey);

  const bea = parseAwarenessSource(`<table><tr><td>July 30, 2026 8:30 a.m.</td><td><a href="/news/2026/gdp">Gross Domestic Product, Second Quarter</a></td></tr></table>`, source({
    sourceId: "awareness-bea-schedule", name: "BEA", url: "https://www.bea.gov/news/schedule", adapter: "bea-schedule-html"
  }), { observedAt });
  assert.equal(bea[0].scheduledAt, "2026-07-30T12:30:00.000Z");
  assert.equal(bea[0].importance, "high");

  const marad = parseAwarenessSource(`<table><tr><td>2026-004</td><td><a href="/msci/2026-004">Maritime Advisory - Red Sea</a></td><td>July 29, 2026 9:00 a.m. Cancelled</td></tr></table>`, source({
    sourceId: "awareness-marad-advisories", name: "MARAD", url: "https://www.maritime.dot.gov/msci-advisories", adapter: "marad-html", kind: "maritime_alert", domains: ["geopolitical", "security", "financial"]
  }), { observedAt });
  assert.equal(marad[0].status, "cancelled");
  assert.equal(marad[0].title, "Maritime Advisory - Red Sea");
  assert.equal(marad[0].location.precision, "region");

  const activeMarad = parseAwarenessSource(`<table><tr><td>2026-005</td><td><a href="/msci/2026-005">Global-U.S. Maritime Advisory</a></td><td>July 29, 2026 9:00 a.m. Active</td></tr></table>`, source({
    sourceId: "awareness-marad-advisories", name: "MARAD", url: "https://www.maritime.dot.gov/msci-advisories", adapter: "marad-html", kind: "maritime_alert", domains: ["geopolitical", "security", "financial"]
  }), { observedAt });
  assert.equal(activeMarad[0].status, "live");
  assert.equal(activeMarad[0].location.label, "Global");
  assert.equal(activeMarad[0].location.lat, null);
  assert.equal(activeMarad[0].location.lng, null);
});

test("RSS awareness policies reject fallback dates, filter distributor media and preserve maritime lifecycle", () => {
  const observedAt = "2026-07-29T22:00:00.000Z";
  const feed = `<?xml version="1.0"?><rss><channel>
    <item><title>CENTCOM operational news release</title><link>https://www.dvidshub.net/news/123/release</link><pubDate>Wed, 29 Jul 2026 21:00:00 GMT</pubDate></item>
    <item><title>CENTCOM image gallery</title><link>https://www.dvidshub.net/image/456/gallery</link><pubDate>Wed, 29 Jul 2026 21:01:00 GMT</pubDate></item>
    <item><title>Impersonating off-host news item</title><link>https://third-party.example/news/456/fake</link><pubDate>Wed, 29 Jul 2026 21:02:00 GMT</pubDate></item>
    <item><title>Undated news item</title><link>https://www.dvidshub.net/news/789/undated</link></item>
  </channel></rss>`;
  const dvids = parseAwarenessSource(feed, source({
    sourceId: "awareness-centcom-dvids",
    name: "DVIDS / U.S. Central Command Public Affairs",
    url: "https://www.dvidshub.net/rss/unit/72",
    adapter: "rss",
    kind: "official_security_release",
    domains: ["geopolitical", "security"],
    rssItemPathPrefixes: ["/news/"],
    rssItemAllowedHosts: ["www.dvidshub.net"],
    requireSourceTimestamp: true,
    role: "official-distributor"
  }), { observedAt });
  assert.equal(dvids.length, 1);
  assert.equal(dvids[0].canonicalUrl, "https://www.dvidshub.net/news/123/release");
  assert.equal(dvids[0].source.role, "official-distributor");

  const cancelled = parseAwarenessSource(`<?xml version="1.0"?><rss><channel><item>
    <title>2026-004 Maritime Advisory Cancellation - Red Sea</title>
    <link>https://www.maritime.dot.gov/msci/2026-004</link>
    <pubDate>Wed, 29 Jul 2026 21:00:00 GMT</pubDate>
  </item></channel></rss>`, source({
    sourceId: "awareness-marad-advisories-rss",
    name: "MARAD RSS",
    url: "https://www.maritime.dot.gov/taxonomy/term/441/feed",
    adapter: "rss",
    kind: "maritime_alert",
    domains: ["geopolitical", "security", "financial"],
    requireSourceTimestamp: true
  }), { observedAt });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].status, "cancelled");
  assert.equal(cancelled[0].location.precision, "region");
});

test("RSS awareness parser rejects challenge documents without a feed envelope", () => {
  const challenge = `<!doctype html><html><body>
    Access denied. Incidental markup:
    <item><title>False official release</title><link>https://official.example.test/fake</link></item>
  </body></html>`;
  assert.throws(() => parseAwarenessSource(challenge, source({
    sourceId: "awareness-challenge",
    url: "https://official.example.test/feed",
    adapter: "rss",
    kind: "macro_release"
  })), /awareness-rss-envelope-invalid/);

  const trailingInjection = `<rss><channel></channel></rss><html><item>
    <title>Injected release</title>
    <link>https://evil.example/injected</link>
    <pubDate>Wed, 29 Jul 2026 18:00:00 GMT</pubDate>
  </item></html>`;
  assert.throws(() => parseAwarenessSource(trailingInjection, source({
    sourceId: "awareness-multi-root",
    url: "https://official.example.test/feed",
    adapter: "rss",
    kind: "macro_release"
  })), /awareness-rss-envelope-invalid/);
});

test("RSS awareness envelope supports direct RSS 1.0 items and official Dublin Core dates", () => {
  const events = parseAwarenessSource(`<?xml version="1.0"?>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>Official central bank releases</title></channel>
      <item><title>Monetary policy release</title><link>https://official.example.test/release</link><dc:date>2026-07-29T18:00:00Z</dc:date></item>
    </rdf:RDF>`, source({
    sourceId: "awareness-rdf-feed",
    url: "https://official.example.test/feed.rdf",
    adapter: "rss",
    kind: "macro_release",
    requireSourceTimestamp: true
  }), { observedAt: "2026-07-29T18:01:00Z" });

  assert.equal(events.length, 1);
  assert.equal(events[0].publishedAt, "2026-07-29T18:00:00.000Z");
  assert.equal(events[0].canonicalUrl, "https://official.example.test/release");
});

test("USGS GeoJSON never promotes the null-island sentinel into an exact map point", () => {
  const [event] = parseAwarenessSource(JSON.stringify({
    type: "FeatureCollection",
    features: [{
      id: "null-island-fixture",
      properties: {
        title: "Significant earthquake fixture",
        place: "Unknown location",
        time: Date.parse("2026-07-29T20:00:00Z"),
        updated: Date.parse("2026-07-29T20:01:00Z"),
        url: "https://earthquake.usgs.gov/earthquakes/eventpage/fixture"
      },
      geometry: { type: "Point", coordinates: [0, 0, 10] }
    }]
  }), source({
    sourceId: "awareness-usgs-significant",
    name: "USGS Significant Earthquakes",
    url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson",
    adapter: "usgs-geojson",
    kind: "market_moving_news",
    domains: ["geopolitical", "financial"],
    timezone: "UTC"
  }), { observedAt: "2026-07-29T20:02:00Z" });
  assert.equal(event.location, null);
});
