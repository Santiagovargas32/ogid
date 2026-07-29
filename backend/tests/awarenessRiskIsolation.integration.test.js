import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../server.js";

function projectCountryRisk(countries) {
  return Object.fromEntries(Object.entries(countries).map(([iso2, country]) => [iso2, {
    score: country.score,
    level: country.level,
    trend: country.trend,
    metrics: country.metrics,
    topTags: country.topTags
  }]));
}

test("country-free Fed release reaches Markets while geopolitical country risk remains unchanged", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (["127.0.0.1", "localhost"].includes(new URL(String(url)).hostname)) return originalFetch(url, options);
    return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><item>
      <title>Federal Reserve issues FOMC interest rate decision</title>
      <description>The Committee maintained the target range for the federal funds rate.</description>
      <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm</link>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item></channel></rss>`, { status: 200, headers: { "content-type": "application/rss+xml" } });
  };
  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    awareness: { mode: "visible" },
    news: {
      providers: ["rss"],
      rssFeeds: [{
        sourceId: "rss-federal-reserve-press-releases",
        label: "Federal Reserve Press Releases",
        publisher: "Federal Reserve",
        role: "official",
        url: "https://example.com/fed.xml"
      }],
      query: "geopolitics OR conflict OR sanctions OR military",
      timeoutMs: 500
    },
    market: { enabled: false, provider: "", fallbackProvider: "" }
  });
  await runtime.start();
  try {
    const before = projectCountryRisk(runtime.app.locals.orchestrator.stateManager.getSnapshot().countries);
    await runtime.orchestrator.runNewsCycle("financial-risk-isolation");
    const after = runtime.app.locals.orchestrator.stateManager.getSnapshot();
    assert.deepEqual(projectCountryRisk(after.countries), before);
    assert.equal(after.news.some((article) => /FOMC/i.test(article.title)), false);
    assert.equal(runtime.app.locals.orchestrator.stateManager.getMarketSignalCorpus().some((article) => /FOMC/i.test(article.title)), true);
    const awareness = runtime.awarenessService.getSnapshot();
    assert.equal(awareness.recent.some((event) => /FOMC/i.test(event.title) && event.domains.includes("financial")), true);
    const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    for (const path of ["/api/market/impact?tickers=SPY", "/api/market/analytics?tickers=SPY"]) {
      const response = await originalFetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      const items = payload.data.impact?.items || payload.data.impactItems || [];
      assert.equal(items.some((item) => Number(item.eventScore || 0) > 0), true);
    }
  } finally {
    global.fetch = originalFetch;
    await runtime.stop();
  }
});
