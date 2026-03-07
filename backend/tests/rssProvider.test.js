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
