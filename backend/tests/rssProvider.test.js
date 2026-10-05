import test from "node:test";
import assert from "node:assert/strict";
import { fetchRss, parseFeedArticles, hasFeedEnvelope, hasFeedEntries, resetRssFeedValidationCacheForTests } from "../services/news/providers/rssProvider.js";
import { providerRuntime } from "../services/providers/providerRuntime.js";

test("namespaced Atom entries preserve source update dates and links through normalization", async () => {
  const xml = `<a10:feed xmlns:a10="http://www.w3.org/2005/Atom"><a10:title>Council</a10:title><a10:entry><a10:title>Official statement</a10:title><a10:link href="https://example.org/2026/09/28/statement"/><a10:updated>2026-10-05T19:30:00Z</a10:updated></a10:entry></a10:feed>`;
  assert.equal(hasFeedEnvelope(xml), true);
  assert.equal(hasFeedEntries(xml), true);
  const [raw] = parseFeedArticles(xml, "Council");
  assert.equal(raw.title, "Official statement");
  assert.equal(raw.url, "https://example.org/2026/09/28/statement");
  assert.equal(raw.publishedAt, "2026-10-05T19:30:00Z");
  assert.equal(raw.provenance.publishedAtQuality, "source");
  assert.equal(raw.provenance.publishedAtBasis, "updated");
  const { normalizeArticles } = await import("../services/normalizeService.js");
  const [normalized] = normalizeArticles([raw]);
  assert.equal(normalized.provenance.publishedAtBasis, "updated");
});

test("publication wins over an update; similarly named XML tags cannot invent dates", () => {
  const [article] = parseFeedArticles(`<feed><entry><title>Release</title><link href="https://example.org/release"/><updated>2026-10-05T19:30:00Z</updated><published>2026-09-28T12:00:00Z</published></entry></feed>`);
  assert.equal(article.publishedAt, "2026-09-28T12:00:00Z");
  assert.equal(article.provenance.publishedAtBasis, "published");
  const [missing] = parseFeedArticles(`<rss><channel><item><title>Release</title><pubDateExtra>2026-09-28T12:00:00Z</pubDateExtra></item></channel></rss>`);
  assert.equal(missing.provenance.publishedAtQuality, "fallback-missing");
});

test("rss provider marks html pages as invalid feeds and caches the invalid result", async () => {
  resetRssFeedValidationCacheForTests();

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response("<html><body>not a feed</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  };

  try {
    const first = await fetchRss({
      feeds: [{ label: "HTML Feed", url: "https://example.com/not-a-feed" }],
      timeoutMs: 1000
    });
    assert.equal(first.sourceMeta.feedStatus[0].status, "invalid-feed");
    assert.equal(first.sourceMeta.feedStatus[0].error, "missing-rss-or-atom-items");

    const second = await fetchRss({
      feeds: [{ label: "HTML Feed", url: "https://example.com/not-a-feed" }],
      timeoutMs: 1000
    });
    assert.equal(fetchCalls, 1);
    assert.equal(second.sourceMeta.feedStatus[0].status, "invalid-feed");
    assert.equal(second.sourceMeta.feedStatus[0].error, "cached-invalid-feed");
  } finally {
    global.fetch = originalFetch;
    resetRssFeedValidationCacheForTests();
  }
});

test("rss provider surfaces disabled feeds as skipped without fetching them", async () => {
  resetRssFeedValidationCacheForTests();

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 500 });
  };

  try {
    const result = await fetchRss({
      feeds: [
        {
          label: "ZeroHedge",
          url: "https://www.zerohedge.com/",
          disabled: true,
          reason: "disabled-until-valid-xml-feed"
        }
      ],
      timeoutMs: 1000
    });

    assert.equal(fetchCalls, 0);
    assert.equal(result.sourceMeta.feedStatus[0].status, "skipped");
    assert.equal(result.sourceMeta.feedStatus[0].error, "disabled-until-valid-xml-feed");
    assert.equal(result.sourceMeta.feedStatus[0].count, 0);
  } finally {
    global.fetch = originalFetch;
    resetRssFeedValidationCacheForTests();
  }
});

test("rss provider can disable retries for a controlled live probe", async () => {
  resetRssFeedValidationCacheForTests();
  providerRuntime.reset();

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  let requestOptions;
  global.fetch = async (_url, options) => {
    fetchCalls += 1;
    requestOptions = options;
    return new Response("temporarily unavailable", { status: 503 });
  };

  try {
    const result = await fetchRss({
      feeds: [{ label: "Failing Feed", url: "https://probe.example.test/rss.xml" }],
      timeoutMs: 1000,
      retries: 0
    });

    assert.equal(fetchCalls, 1);
    assert.equal(result.sourceMeta.feedStatus[0].status, "error");
    assert.equal(result.sourceMeta.feedStatus[0].error, "rss-upstream-503");
    assert.equal(providerRuntime.getMetrics("rss").retries, 0);
    assert.match(requestOptions.headers.Accept, /application\/rss\+xml/);
    assert.equal(requestOptions.headers["User-Agent"], "ogid/1.0");
  } finally {
    global.fetch = originalFetch;
    providerRuntime.reset();
    resetRssFeedValidationCacheForTests();
  }
});

test("rss provider sanitizes html content and extracts an embedded image when feed media is a document", async () => {
  resetRssFeedValidationCacheForTests();

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Relief Feed</title>
            <item>
              <title>Lebanon flash update</title>
              <description><![CDATA[
                <div class="tag country">Country: Lebanon</div>
                <div class="tag source">Source: OCHA</div>
                <p><img src="https://example.com/preview.png" alt=""></p>
                <p>Please refer to the attached file.</p>
                <p><strong>Hostilities have continued</strong> across multiple governorates.</p>
              ]]></description>
              <enclosure url="https://example.com/report.pdf" type="application/pdf" />
              <link>https://example.com/report</link>
              <pubDate>${new Date().toUTCString()}</pubDate>
            </item>
          </channel>
        </rss>`,
      {
        status: 200,
        headers: { "content-type": "application/xml" }
      }
    );

  try {
    const result = await fetchRss({
      feeds: [{ label: "Relief Feed", url: "https://example.com/feed.xml" }],
      timeoutMs: 1000
    });

    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].description.includes("<"), false);
    assert.equal(result.articles[0].content.includes("<"), false);
    assert.match(result.articles[0].excerpt, /Hostilities have continued/i);
    assert.equal(result.articles[0].leadImageUrl, "https://example.com/preview.png");
    assert.equal(result.articles[0].urlToImage, "https://example.com/preview.png");
  } finally {
    global.fetch = originalFetch;
    resetRssFeedValidationCacheForTests();
  }
});

test("rss provider replaces invalid publication dates and exposes timestamp fallback diagnostics", async () => {
  resetRssFeedValidationCacheForTests();

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Malformed Date Feed</title>
            <item>
              <title>Missile activity update</title>
              <description>Regional monitoring update.</description>
              <link>https://example.com/malformed-date</link>
              <pubDate>not-a-date</pubDate>
            </item>
          </channel>
        </rss>`,
      {
        status: 200,
        headers: { "content-type": "application/xml" }
      }
    );

  try {
    const result = await fetchRss({
      feeds: [{ label: "Malformed Date Feed", url: "https://example.com/feed.xml" }],
      timeoutMs: 1000
    });

    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].provenance.publishedAtQuality, "fallback-invalid");
    assert.equal(new Date(result.articles[0].publishedAt).toISOString(), result.articles[0].publishedAt);
    assert.equal(result.sourceMeta.timestampFallbackCount, 1);
    assert.equal(result.sourceMeta.feedStatus[0].timestampFallbackCount, 1);
  } finally {
    global.fetch = originalFetch;
    resetRssFeedValidationCacheForTests();
  }
});

test("RSS parser preserves official Dublin Core and central-bank publication dates", () => {
  const [dcArticle] = parseFeedArticles(`<?xml version="1.0"?><rss><channel><item>
    <title>BIS press release</title><link>https://www.bis.org/press/p260729.htm</link>
    <dc:date>2026-07-29T10:30:00Z</dc:date>
    <cb:occurrenceDate>2026-07-28T10:30:00Z</cb:occurrenceDate>
  </item></channel></rss>`);
  assert.equal(dcArticle.publishedAt, "2026-07-29T10:30:00Z");
  assert.equal(dcArticle.provenance.publishedAtQuality, "source");

  const [cbArticle] = parseFeedArticles(`<?xml version="1.0"?><rss><channel><item>
    <title>Central bank release</title><link>https://example.test/release</link>
    <cb:publicationDate>2026-07-27T09:00:00Z</cb:publicationDate>
  </item></channel></rss>`);
  assert.equal(cbArticle.publishedAt, "2026-07-27T09:00:00Z");
  assert.equal(cbArticle.provenance.publishedAtQuality, "source");
});
