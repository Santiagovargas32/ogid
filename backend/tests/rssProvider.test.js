import test from "node:test";
import assert from "node:assert/strict";
import { fetchRss, resetRssFeedValidationCacheForTests } from "../services/news/providers/rssProvider.js";

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
