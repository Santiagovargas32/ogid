import test from "node:test";
import assert from "node:assert/strict";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { fetchAggregatedNews } from "../services/news/newsAggregatorService.js";

test("news aggregator falls back when provider keys are missing", async () => {
  apiQuotaTracker.reset({
    newsapiDailyLimit: 10,
    gnewsDailyLimit: 10
  });

  const result = await fetchAggregatedNews({
    providers: ["newsapi", "gnews"],
    newsApiKey: "",
    gnewsApiKey: "",
    query: "geopolitics",
    language: "en",
    pageSize: 10,
    timeoutMs: 1000
  });

  assert.equal(result.sourceMode, "fallback");
  assert.ok(Array.isArray(result.articles));
  assert.ok(result.articles.length > 0);
  assert.ok(result.articles.every((article) => article.synthetic === true));
  assert.ok(result.articles.every((article) => article.dataMode === "fallback"));
});

test("news aggregator combines providers and keeps headline-only policy for rss feeds", async () => {
  apiQuotaTracker.reset({
    newsapiDailyLimit: 10,
    rssDailyLimit: 10
  });

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);

    if (value.includes("newsapi.org")) {
      return new Response(
        JSON.stringify({
          totalResults: 1,
          articles: [
            {
              source: { name: "BBC News" },
              title: "Sanctions pressure rises on strategic shipping routes",
              description: "Policy makers discuss sanctions and convoy security.",
              content: "Energy and defense desks are watching the sanctions angle closely.",
              url: "https://www.bbc.com/news/articles/demo",
              publishedAt: new Date().toISOString()
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    if (value.includes("feeds.bbci.co.uk")) {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <title>BBC World</title>
              <item>
                <title>Missile defense alert expands across regional bases</title>
                <description>Defense ministries cited missile defense drills near shipping lanes.</description>
                <link>https://www.bbc.co.uk/news/world-demo</link>
                <pubDate>${new Date().toUTCString()}</pubDate>
              </item>
            </channel>
          </rss>`,
        {
          status: 200,
          headers: { "content-type": "application/xml" }
        }
      );
    }

    return new Response("{}", { status: 404 });
  };

  try {
    const result = await fetchAggregatedNews({
      providers: ["newsapi", "rss"],
      newsApiKey: "test-key",
      query: "sanctions OR missile",
      queryPacks: {
        defense: "missile defense"
      },
      language: "en",
      pageSize: 10,
      sourceAllowlist: ["bbc"],
      domainAllowlist: ["bbc.com", "bbc.co.uk"],
      rssFeeds: [{ label: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" }],
      timeoutMs: 1000
    });

    assert.equal(result.sourceMode, "live");
    assert.ok(result.articles.length >= 2);
    assert.ok(result.sourceMeta.provider.includes("newsapi"));
    assert.ok(result.sourceMeta.provider.includes("rss"));
    assert.ok(result.articles.some((article) => article.provider === "rss"));
    assert.ok(result.articles.some((article) => article.usagePolicy === "headline-only-link-out"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("news aggregator trims gnews query to base NEWS_QUERY only", async () => {
  apiQuotaTracker.reset({
    gnewsDailyLimit: 10
  });

  const originalFetch = global.fetch;
  let capturedQuery = "";
  global.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    capturedQuery = requestUrl.searchParams.get("q") || "";

    return new Response(
      JSON.stringify({
        totalArticles: 1,
        articles: [
          {
            source: { name: "GNews" },
            title: "Geopolitics and sanctions provider test",
            description: "Military shipping risk stays elevated.",
            content: "Defense and sovereign risk desks are monitoring export controls.",
            url: "https://gnews.example/article",
            publishedAt: new Date().toISOString()
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  try {
    const baseQuery = "geopolitics conflict sanctions military shipping oil defense contractors semiconductors tariffs sovereign risk maritime security export controls foundry fab ";
    const result = await fetchAggregatedNews({
      providers: ["gnews"],
      gnewsApiKey: "test-key",
      query: `${baseQuery}${baseQuery}`,
      queryPacks: {
        defense: "SHOULD_NOT_APPEAR"
      },
      language: "en",
      pageSize: 10,
      timeoutMs: 1000
    });

    assert.equal(result.sourceMode, "live");
    assert.equal(result.sourceMeta.queryLengthByProvider.gnews <= 180, true);
    assert.equal(capturedQuery.length <= 180, true);
    assert.equal(capturedQuery.includes("SHOULD_NOT_APPEAR"), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("news aggregator skips gnews when NEWS_QUERY base is missing", async () => {
  apiQuotaTracker.reset({
    gnewsDailyLimit: 10
  });

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 500 });
  };

  try {
    const result = await fetchAggregatedNews({
      providers: ["gnews"],
      gnewsApiKey: "test-key",
      query: "",
      queryPacks: {
        defense: "missile defense"
      },
      language: "en",
      pageSize: 10,
      timeoutMs: 1000
    });

    assert.equal(fetchCalls, 0);
    assert.equal(result.sourceMode, "fallback");
    assert.equal(result.sourceMeta.attempts[0].status, "skipped");
    assert.equal(result.sourceMeta.attempts[0].reason, "missing-base-query");
    assert.equal(result.sourceMeta.rawCountByProvider.gnews, 0);
    assert.equal(result.sourceMeta.filteredCountByProvider.gnews, 0);
    assert.equal(result.sourceMeta.queryLengthByProvider.gnews, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("news aggregator normalizes nested query packs and injects market signal terms for newsapi-style providers", async () => {
  apiQuotaTracker.reset({
    newsapiDailyLimit: 10
  });

  const originalFetch = global.fetch;
  let capturedQuery = "";
  global.fetch = async (url) => {
    const requestUrl = new URL(String(url));
    capturedQuery = requestUrl.searchParams.get("q") || "";

    return new Response(
      JSON.stringify({
        totalResults: 1,
        articles: [
          {
            source: { name: "Reuters" },
            title: "Defense shares rise after analyst upgrade",
            description: "Premarket tone improves across aerospace names.",
            content: "Markets are reacting to guidance changes.",
            url: "https://example.com/market-signals",
            publishedAt: new Date().toISOString()
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  try {
    const result = await fetchAggregatedNews({
      providers: ["newsapi"],
      newsApiKey: "test-key",
      query: "geopolitics",
      queryPacks: {
        editorial: {
          defense: "defense contractor"
        },
        marketSignals: {
          priceAction: "upgrade OR downgrade"
        }
      },
      marketTickers: ["GD", "BA"],
      language: "en",
      pageSize: 10,
      timeoutMs: 1000
    });

    assert.equal(result.sourceMode, "live");
    assert.equal(capturedQuery.includes("defense contractor"), true);
    assert.equal(capturedQuery.includes("upgrade OR downgrade"), true);
    assert.equal(capturedQuery.includes("GD OR BA"), true);
  } finally {
    global.fetch = originalFetch;
  }
});
