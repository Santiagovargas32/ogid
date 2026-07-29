import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../server.js";

function newsApiPayload(financial) {
  const publishedAt = new Date().toISOString();
  return {
    status: "ok",
    totalResults: 1,
    articles: [{
      source: { id: null, name: financial ? "Market Wire" : "Security Wire" },
      author: null,
      title: financial ? "Federal Reserve issues FOMC interest rate decision" : "Ballistic missile attack reported in Iran",
      description: financial ? "The Committee published its official monetary policy decision." : "Military forces intercepted missiles after the attack.",
      url: financial ? "https://example.com/fomc" : "https://example.com/security",
      urlToImage: null,
      publishedAt,
      content: null
    }]
  };
}

test("shadow collects the financial lane without publishing it into geopolitical or market analytics", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const target = new URL(String(url));
    if (["127.0.0.1", "localhost"].includes(target.hostname)) return originalFetch(url, options);
    if (target.hostname === "newsapi.org") {
      const query = target.searchParams.get("q") || "";
      const financial = /fomc|interest rate|earnings|regulatory filing/i.test(query) && !/ballistic missile|military/i.test(query);
      return new Response(JSON.stringify(newsApiPayload(financial)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("<rss><channel></channel></rss>", {
      status: 200,
      headers: { "content-type": "application/rss+xml" }
    });
  };

  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    awareness: { mode: "shadow" },
    news: {
      providers: ["newsapi"],
      newsApiKey: "awareness-shadow-test-key",
      query: "geopolitics OR conflict OR ballistic missile OR military",
      timeoutMs: 500
    },
    market: { enabled: false, provider: "", fallbackProvider: "" }
  });
  await runtime.start();
  try {
    await runtime.orchestrator.runNewsCycle("shadow-geo-1");
    await runtime.orchestrator.runNewsCycle("shadow-geo-2");
    const beforeFinancialLane = runtime.app.locals.orchestrator.stateManager.getSnapshot();
    await runtime.orchestrator.runNewsCycle("shadow-financial-3");
    const afterFinancialLane = runtime.app.locals.orchestrator.stateManager.getSnapshot();

    assert.equal(afterFinancialLane.meta.sourceMeta.queryLane, "financial");
    assert.deepEqual(afterFinancialLane.news.map((article) => article.title), beforeFinancialLane.news.map((article) => article.title));
    assert.equal(afterFinancialLane.news.some((article) => /FOMC/i.test(article.title)), false);
    assert.equal(runtime.app.locals.orchestrator.stateManager.getMarketSignalCorpus().some((article) => /FOMC/i.test(article.title)), false);
    assert.equal(runtime.awarenessService.getAdminSnapshot().recent.some((event) => /FOMC/i.test(event.title)), true);
    assert.deepEqual(runtime.awarenessService.getSnapshot().recent, []);
  } finally {
    global.fetch = originalFetch;
    await runtime.stop();
  }
});
