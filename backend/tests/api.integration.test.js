import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../server.js";

test("REST API exposes health and snapshot payloads", async () => {
  const runtime = createAppServer({
    port: 0,
    refreshIntervalMs: 300_000,
    market: { refreshIntervalMs: 300_000, apiKey: "", fmpApiKey: "", requestReserve: 0 },
    news: { newsApiKey: "" },
    apiLimits: {
      newsapiDailyLimit: 10,
      gnewsDailyLimit: 10,
      mediastackDailyLimit: 10,
      alphavantageDailyLimit: 10
    }
  });

  await runtime.start();

  try {
    await runtime.orchestrator.runCycle("test-bootstrap");
    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const healthPayload = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.data.status, "ok");

    const snapshotResponse = await fetch(`${baseUrl}/api/intel/snapshot?countries=US,IL,IR`);
    const snapshotPayload = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotPayload.ok, true);
    assert.ok(Array.isArray(snapshotPayload.data.hotspots));
    assert.ok(snapshotPayload.data.hotspots.length <= 3);
    assert.equal(snapshotPayload.data.meta.sourceMode, "fallback");
    assert.ok(snapshotPayload.data.meta.dataQuality);
    assert.ok(snapshotPayload.data.meta.emptyStates);
    assert.ok(snapshotPayload.data.meta.refreshStatus);
    assert.ok(snapshotPayload.data.predictions);
    assert.ok("emptyReason" in snapshotPayload.data.impact);

    const refreshResponse = await fetch(`${baseUrl}/api/intel/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        countries: "US,IL,IR",
        reason: "manual"
      })
    });
    const refreshPayload = await refreshResponse.json();
    assert.equal(refreshResponse.status, 202);
    assert.equal(refreshPayload.ok, true);
    assert.equal(refreshPayload.data.accepted, true);
    assert.ok(refreshPayload.data.refreshId);
    assert.ok(refreshPayload.data.nextAllowedAt);

    let manualRefreshCompleted = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const pollResponse = await fetch(`${baseUrl}/api/intel/snapshot?countries=US,IL,IR`);
      const pollPayload = await pollResponse.json();
      const status = pollPayload?.data?.meta?.refreshStatus || {};
      if (
        status.lastRefreshId === refreshPayload.data.refreshId &&
        status.inProgress === false &&
        status.lastCompletedAt
      ) {
        manualRefreshCompleted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(manualRefreshCompleted, true);

    const refreshCooldownResponse = await fetch(`${baseUrl}/api/intel/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        countries: "US,IL,IR",
        reason: "manual"
      })
    });
    const refreshCooldownPayload = await refreshCooldownResponse.json();
    assert.equal(refreshCooldownResponse.status, 429);
    assert.equal(refreshCooldownPayload.ok, false);
    assert.equal(refreshCooldownPayload.error.code, "REFRESH_COOLDOWN");
    assert.ok(refreshCooldownResponse.headers.get("retry-after"));

    const quotesResponse = await fetch(`${baseUrl}/api/market/quotes?tickers=GD,BA,NOC`);
    const quotesPayload = await quotesResponse.json();
    assert.equal(quotesResponse.status, 200);
    assert.equal(quotesPayload.ok, true);
    assert.ok(quotesPayload.data.quotes.GD);
    assert.ok("quoteOriginStage" in quotesPayload.data.quotes.GD);
    assert.ok("quoteAgeMin" in quotesPayload.data.quotes.GD);
    assert.ok(quotesPayload.data.market.coverageByMode);

    const newsResponse = await fetch(`${baseUrl}/api/intel/news?countries=US,IL,IR&limit=25&sources=fallback`);
    const newsPayload = await newsResponse.json();
    assert.equal(newsResponse.status, 200);
    assert.equal(newsPayload.ok, true);
    assert.ok(Array.isArray(newsPayload.data.news));
    assert.ok(newsPayload.data.news.every((article) => article.dataMode === "fallback"));
    assert.ok(
      newsPayload.data.news.every((article) =>
        (article.countryMentions || []).some((iso2) => ["US", "IL", "IR"].includes(iso2))
      )
    );

    const impactResponse = await fetch(`${baseUrl}/api/market/impact?tickers=GD,BA,NOC&countries=US,IL,IR`);
    const impactPayload = await impactResponse.json();
    assert.equal(impactResponse.status, 200);
    assert.equal(impactPayload.ok, true);
    assert.ok(Array.isArray(impactPayload.data.impact.items));
    assert.ok(Array.isArray(impactPayload.data.impact.sectorBreakdown));
    assert.ok(Array.isArray(impactPayload.data.impact.scatterPoints));
    assert.ok(impactPayload.data.impact.signalWindow);

    const analyticsResponse = await fetch(`${baseUrl}/api/market/analytics?tickers=GD,BA,NOC&countries=US,IL,IR`);
    const analyticsPayload = await analyticsResponse.json();
    assert.equal(analyticsResponse.status, 200);
    assert.equal(analyticsPayload.ok, true);
    assert.ok(Array.isArray(analyticsPayload.data.impactHistory));
    assert.ok(Array.isArray(analyticsPayload.data.sectorBreakdown));
    assert.ok(Array.isArray(analyticsPayload.data.scatterPoints));
    assert.ok(Array.isArray(analyticsPayload.data.couplingSeries));
    assert.ok(Array.isArray(analyticsPayload.data.predictedSectorDirection));
    assert.ok(Array.isArray(analyticsPayload.data.tickerOutlookMatrix));
    assert.ok(analyticsPayload.data.predictions);
    assert.equal(typeof analyticsPayload.data.hasCurrentSignals, "boolean");
    assert.equal(typeof analyticsPayload.data.usesHistoricalOnly, "boolean");
    assert.equal(typeof analyticsPayload.data.dataModesByTicker, "object");
    assert.ok(Array.isArray(analyticsPayload.data.impactItems));
    assert.ok(analyticsPayload.data.signalWindow);
    assert.ok("quoteOriginStage" in analyticsPayload.data.dataModesByTicker.GD);
    assert.ok("quoteAgeMin" in analyticsPayload.data.dataModesByTicker.GD);
    assert.ok("emptyReason" in analyticsPayload.data);

    const limitsResponse = await fetch(`${baseUrl}/api/admin/api-limits`);
    const limitsPayload = await limitsResponse.json();
    assert.equal(limitsResponse.status, 200);
    assert.equal(limitsPayload.ok, true);
    assert.equal(Array.isArray(limitsPayload.data.providers), true);
    assert.ok(limitsPayload.data.providers.some((provider) => provider.provider === "newsapi"));
    assert.ok(limitsPayload.data.providers.every((provider) => "quotaBand" in provider));

    const pipelineResponse = await fetch(`${baseUrl}/api/admin/pipeline-status`);
    const pipelinePayload = await pipelineResponse.json();
    assert.equal(pipelineResponse.status, 200);
    assert.equal(pipelinePayload.ok, true);
    assert.ok(pipelinePayload.data.market);
    assert.ok(pipelinePayload.data.news);
    assert.ok("nextRecommendedRunAt" in pipelinePayload.data.market);
    assert.ok(pipelinePayload.data.market.coverageByMode);
    assert.ok(Array.isArray(pipelinePayload.data.market.providerErrors));
    assert.ok(Array.isArray(pipelinePayload.data.news.selectionBySourceName));
    assert.ok("latestSelectedArticleAgeMin" in pipelinePayload.data.news);
    assert.ok(Array.isArray(pipelinePayload.data.recentCycleErrors));
  } finally {
    await runtime.stop();
  }
});

test("pipeline status exposes provider and rss diagnostics for ok, error and skipped states", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const value = String(url);

    if (value.includes("127.0.0.1") || value.includes("localhost")) {
      return originalFetch(url, options);
    }

    if (value.includes("newsapi.org")) {
      return new Response(
        JSON.stringify({
          totalResults: 1,
          articles: [
            {
              source: { name: "BBC News" },
              title: "Shipping lane tensions return to the Red Sea",
              description: "Military escorts remain on alert.",
              content: "Defense desks are monitoring the route.",
              url: "https://www.bbc.com/news/articles/pipeline-test",
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
                <title>Regional escorts reinforce shipping corridor</title>
                <description>Maritime security remains elevated.</description>
                <link>https://www.bbc.co.uk/news/world-pipeline</link>
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

  const runtime = createAppServer({
    port: 0,
    refreshIntervalMs: 300_000,
    market: { refreshIntervalMs: 300_000, apiKey: "", fmpApiKey: "", requestReserve: 0 },
    news: {
      providers: ["newsapi", "gnews", "rss", "mediastack"],
      newsApiKey: "test-newsapi-key",
      gnewsApiKey: "test-gnews-key",
      mediastackApiKey: "",
      query: "",
      queryPacks: {
        shipping: "shipping lane OR maritime security"
      },
      rssFeeds: [
        { label: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
        {
          label: "ZeroHedge",
          url: "https://www.zerohedge.com/",
          disabled: true,
          reason: "disabled-until-valid-xml-feed"
        }
      ],
      timeoutMs: 1000,
      pageSize: 10
    },
    apiLimits: {
      newsapiDailyLimit: 10,
      gnewsDailyLimit: 10,
      mediastackDailyLimit: 10,
      rssDailyLimit: 10,
      alphavantageDailyLimit: 10
    }
  });

  await runtime.start();

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.orchestrator.runNewsCycle("test-pipeline");

    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const pipelineResponse = await fetch(`${baseUrl}/api/admin/pipeline-status`);
    const pipelinePayload = await pipelineResponse.json();
    assert.equal(pipelineResponse.status, 200);
    assert.equal(pipelinePayload.ok, true);

    const news = pipelinePayload.data.news;
    assert.equal(news.rawCountByProvider.newsapi, 1);
    assert.equal(news.rawCountByProvider.gnews, 0);
    assert.equal(news.rawCountByProvider.mediastack, 0);
    assert.equal(news.queryLengthByProvider.gnews, 0);
    assert.equal(typeof news.selectedCountByProvider.newsapi, "number");

    const attemptsByProvider = Object.fromEntries(news.attempts.map((attempt) => [attempt.provider, attempt]));
    assert.equal(attemptsByProvider.newsapi.status, "ok");
    assert.equal(attemptsByProvider.gnews.status, "skipped");
    assert.equal(attemptsByProvider.gnews.reason, "missing-base-query");
    assert.equal(attemptsByProvider.mediastack.status, "error");
    assert.equal(attemptsByProvider.rss.status, "ok");

    const zeroHedgeStatus = news.rssFeedStatus.find((feed) => feed.label === "ZeroHedge");
    const bbcStatus = news.rssFeedStatus.find((feed) => feed.label === "BBC World");
    assert.ok(zeroHedgeStatus);
    assert.equal(zeroHedgeStatus.status, "skipped");
    assert.equal(zeroHedgeStatus.error, "disabled-until-valid-xml-feed");
    assert.ok(bbcStatus);
    assert.equal(bbcStatus.status, "ok");
    assert.equal(bbcStatus.count > 0, true);

    const snapshotResponse = await fetch(`${baseUrl}/api/intel/snapshot?countries=US,IL,IR`);
    const snapshotPayload = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200);
    assert.ok(snapshotPayload.data.meta.emptyStates);
    assert.ok("insights" in snapshotPayload.data.meta.emptyStates);
    assert.ok("impact" in snapshotPayload.data.meta.emptyStates);
    assert.ok("emptyReason" in snapshotPayload.data.impact);

    const analyticsResponse = await fetch(`${baseUrl}/api/market/analytics?tickers=GD,BA,NOC&countries=US,IL,IR`);
    const analyticsPayload = await analyticsResponse.json();
    assert.equal(analyticsResponse.status, 200);
    assert.equal(typeof analyticsPayload.data.hasCurrentSignals, "boolean");
    assert.equal(typeof analyticsPayload.data.usesHistoricalOnly, "boolean");
    assert.equal(typeof analyticsPayload.data.dataModesByTicker, "object");
    assert.ok(analyticsPayload.data.signalWindow);
    assert.ok(Array.isArray(analyticsPayload.data.impactItems));
    assert.ok("emptyReason" in analyticsPayload.data);

    assert.ok(Array.isArray(pipelinePayload.data.recentCycleErrors));
    assert.ok(pipelinePayload.data.market.coverageByMode);
    assert.ok(Array.isArray(pipelinePayload.data.market.providerErrors));
    assert.ok(Array.isArray(news.selectionBySourceName));
    assert.ok("latestSelectedArticleAgeMin" in news);
  } finally {
    global.fetch = originalFetch;
    await runtime.stop();
  }
});
