import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../server.js";

test("REST API exposes health and snapshot payloads", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const value = String(url);
    if (value.includes("127.0.0.1") || value.includes("localhost")) {
      return originalFetch(url, options);
    }

    if (value.includes("youtube.com")) {
      return new Response(
        `<!doctype html>
        <html>
          <body>
            <script>
              var ytInitialData = {"contents":{"twoColumnBrowseResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[{"itemSectionRenderer":{"contents":[{"gridRenderer":{"items":[{"gridVideoRenderer":{"videoId":"EcOPAnQb1w0","thumbnailOverlays":[{"thumbnailOverlayTimeStatusRenderer":{"style":"LIVE","text":{"runs":[{"text":"LIVE"}]}}}]}}]}}]}}]}}}}]}};
            </script>
          </body>
        </html>`,
        {
          status: 200,
          headers: { "content-type": "text/html" }
        }
      );
    }

    if (value.includes("api.twelvedata.com/quote")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              symbol: "GD",
              close: "300.50",
              percent_change: "0.25",
              previous_close: "299.75",
              high: "301.20",
              low: "298.80",
              volume: "1000",
              datetime: "2026-03-16 18:45:00",
              market_state: "REGULAR"
            },
            {
              symbol: "BA",
              close: "200.25",
              percent_change: "0.80",
              previous_close: "198.66",
              high: "201.00",
              low: "199.00",
              volume: "1100",
              datetime: "2026-03-16 18:45:00",
              market_state: "REGULAR"
            },
            {
              symbol: "NOC",
              close: "451.10",
              percent_change: "0.24",
              previous_close: "450.02",
              high: "452.00",
              low: "449.00",
              volume: "900",
              datetime: "2026-03-16 18:45:00",
              market_state: "REGULAR"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>API Test Feed</title>
          <item>
            <title>Sanctions and cyber pressure increase around Israel</title>
            <description>Regional defenses remain on alert.</description>
            <link>https://example.com/api-test</link>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
        </channel>
      </rss>`,
      {
        status: 200,
        headers: { "content-type": "application/xml" }
      }
    );
  };

  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    refreshIntervalMs: 300_000,
    market: {
      provider: "twelve",
      fallbackProvider: "yahoo",
      offHoursStrategy: "skip",
      twelveApiKey: "demo",
      twelveBaseUrl: "https://api.twelvedata.com",
      yahooBaseUrl: "https://finance.yahoo.com",
      yahooUserAgent: "ogid/1.0",
      tickers: ["GD", "BA", "NOC"],
      refreshIntervalMs: 300_000,
      requestReserve: 0,
      historyPersist: false
    },
    news: {
      providers: ["rss"],
      rssFeeds: [{ label: "API Test Feed", url: "https://example.com/rss.xml" }],
      newsApiKey: "",
      gnewsApiKey: "",
      mediastackApiKey: "",
      timeoutMs: 200
    },
    apiLimits: {
      newsapiDailyLimit: 10,
      gnewsDailyLimit: 10,
      mediastackDailyLimit: 10,
      twelveDailyLimit: 800,
      twelveDailyBudget: 600,
      twelveMinuteLimit: 8
    }
  });

  await runtime.start();

  try {
    await runtime.orchestrator.runCycle("test-bootstrap");
    await runtime.orchestrator.runMarketCycle("test-bootstrap-market");
    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const healthPayload = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.data.status, "ok");
    assert.equal(healthPayload.data.websocketClients, 0);
    assert.equal(healthPayload.data.websocket.clientCount, 0);
    assert.equal(healthPayload.data.websocket.path, "/ws");
    assert.equal(healthPayload.data.market.configuredProvider, "twelve");
    assert.equal(healthPayload.data.market.configuredFallbackProvider, "yahoo");
    assert.equal(healthPayload.data.market.providerChain, "twelve+yahoo");
    assert.equal(healthPayload.data.market.effectiveProvider, "twelve");
    assert.equal(typeof healthPayload.data.market.providerScore, "number");
    assert.ok(healthPayload.data.market.session);
    assert.equal(healthPayload.data.market.historicalPersistence.enabled, false);

    const snapshotResponse = await fetch(`${baseUrl}/api/intel/snapshot?countries=US,IL,IR`);
    const snapshotPayload = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotPayload.ok, true);
    assert.ok(Array.isArray(snapshotPayload.data.hotspots));
    assert.ok(snapshotPayload.data.hotspots.length <= 3);
    assert.ok(snapshotPayload.data.mapAssets);
    assert.ok(Array.isArray(snapshotPayload.data.mapAssets.staticPoints));
    assert.equal(snapshotPayload.data.meta.sourceMode, "live");
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
    assert.equal(quotesPayload.data.quotes.GD.sourceDetail, "twelve");
    assert.ok("providerScore" in quotesPayload.data.quotes.GD);
    assert.ok("providerLatencyMs" in quotesPayload.data.quotes.GD);
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
    assert.ok(newsPayload.data.news.every((article) => typeof article.excerpt === "string"));
    assert.ok(newsPayload.data.news.every((article) => typeof article.fullText === "string"));
    assert.ok(newsPayload.data.news.every((article) => !article.description.includes("<")));

    const aggregateNewsResponse = await fetch(`${baseUrl}/api/news/aggregate?limit=10`);
    const aggregateNewsPayload = await aggregateNewsResponse.json();
    assert.equal(aggregateNewsResponse.status, 200);
    assert.equal(aggregateNewsPayload.ok, true);
    assert.ok(Array.isArray(aggregateNewsPayload.data.items));
    assert.ok(aggregateNewsPayload.data.items.every((item) => typeof item.excerpt === "string"));
    assert.ok(aggregateNewsPayload.data.items.every((item) => typeof item.fullText === "string"));
    assert.ok(aggregateNewsPayload.data.items.every((item) => !String(item.description || "").includes("<")));

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
    assert.ok(limitsPayload.data.providers.some((provider) => provider.provider === "twelve"));
    assert.ok(limitsPayload.data.providers.every((provider) => "quotaBand" in provider));
    assert.ok(
      limitsPayload.data.providers.some(
        (provider) =>
          provider.provider === "twelve" &&
          provider.hardDailyLimit === 800 &&
          provider.budgetDailyLimit === 600 &&
          "operationalStatus" in provider
      )
    );

    const pipelineResponse = await fetch(`${baseUrl}/api/admin/pipeline-status`);
    const pipelinePayload = await pipelineResponse.json();
    assert.equal(pipelineResponse.status, 200);
    assert.equal(pipelinePayload.ok, true);
    assert.ok(pipelinePayload.data.market);
    assert.ok(pipelinePayload.data.news);
    assert.ok("nextRecommendedRunAt" in pipelinePayload.data.market);
    assert.ok("lastDurationMs" in pipelinePayload.data.market);
    assert.ok("lastStartedAt" in pipelinePayload.data.market);
    assert.ok("lastCompletedAt" in pipelinePayload.data.market);
    assert.ok("lastStatus" in pipelinePayload.data.market);
    assert.ok(Array.isArray(pipelinePayload.data.market.providersUsed));
    assert.ok(Array.isArray(pipelinePayload.data.market.unresolvedTickers));
    assert.ok(Array.isArray(pipelinePayload.data.market.sampleQuotes));
    assert.equal(pipelinePayload.data.market.providerChain, "twelve+yahoo");
    assert.equal(pipelinePayload.data.market.configuredProvider, "twelve");
    assert.equal(pipelinePayload.data.market.configuredFallbackProvider, "yahoo");
    assert.equal(pipelinePayload.data.market.offHoursStrategy, "skip");
    assert.equal(pipelinePayload.data.market.effectiveProvider, "twelve");
    assert.equal(typeof pipelinePayload.data.market.providerScore, "number");
    assert.ok(pipelinePayload.data.market.session);
    assert.ok(Array.isArray(pipelinePayload.data.market.providerSlots));
    assert.equal(pipelinePayload.data.market.providerSlots.length, 2);
    assert.equal(pipelinePayload.data.market.providerSlots[0].provider, "twelve");
    assert.equal(pipelinePayload.data.market.providerSlots[0].status, "ok");
    assert.equal(pipelinePayload.data.market.providerSlots[0].quotaSnapshot.budgetDailyLimit, 600);
    assert.equal(pipelinePayload.data.market.providerSlots[1].provider, "yahoo");
    assert.equal(pipelinePayload.data.market.providerSlots[1].status, "idle");
    assert.equal(pipelinePayload.data.market.historicalPersistence.enabled, false);
    assert.ok(pipelinePayload.data.market.coverageByMode);
    assert.ok(Array.isArray(pipelinePayload.data.market.providerErrors));
    assert.ok(Array.isArray(pipelinePayload.data.news.selectionBySourceName));
    assert.ok("latestSelectedArticleAgeMin" in pipelinePayload.data.news);
    assert.ok("lastDurationMs" in pipelinePayload.data.news);
    assert.ok("lastStartedAt" in pipelinePayload.data.news);
    assert.ok("lastCompletedAt" in pipelinePayload.data.news);
    assert.ok("lastStatus" in pipelinePayload.data.news);
    assert.ok(Array.isArray(pipelinePayload.data.recentCycleErrors));

    const mediaStreamsResponse = await fetch(`${baseUrl}/api/media/streams`);
    const mediaStreamsPayload = await mediaStreamsResponse.json();
    assert.equal(mediaStreamsResponse.status, 200);
    assert.equal(mediaStreamsPayload.ok, true);
    assert.ok(mediaStreamsPayload.data.generatedAt);
    assert.ok(mediaStreamsPayload.data.summary);
    assert.ok(Array.isArray(mediaStreamsPayload.data.sections.situational));
    assert.ok(Array.isArray(mediaStreamsPayload.data.sections.webcams));
    assert.ok(mediaStreamsPayload.data.sections.situational.some((item) => item.id === "bbc-news"));
  } finally {
    global.fetch = originalFetch;
    await runtime.stop();
  }
});

test("pipeline status exposes provider and rss diagnostics for ok, error and skipped states", async () => {
  const originalFetch = global.fetch;
  let rssFetchCount = 0;
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
      rssFetchCount += 1;
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
    disableBackgroundRefresh: true,
    refreshIntervalMs: 300_000,
    market: {
      provider: "",
      fallbackProvider: "",
      refreshIntervalMs: 300_000,
      requestReserve: 0,
      historyPersist: false
    },
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
      rssDailyLimit: 10
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
    const market = pipelinePayload.data.market;
    assert.equal(market.enabled, false);
    assert.equal(market.sourceMode, "disabled");
    assert.equal(market.requestMode, "disabled");
    assert.equal(market.disabledReason, "market-provider-empty");
    assert.deepEqual(market.providerErrors, []);
    assert.deepEqual(market.providersUsed, []);
    assert.deepEqual(market.unresolvedTickers, []);
    assert.deepEqual(market.sampleQuotes, []);
    assert.deepEqual(market.providerSlots, []);
    assert.ok(market.session);
    assert.equal(market.historicalPersistence.enabled, false);
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
    assert.ok("lastDurationMs" in pipelinePayload.data.market);
    assert.ok("lastStatus" in pipelinePayload.data.market);
    assert.ok(Array.isArray(news.selectionBySourceName));
    assert.ok("latestSelectedArticleAgeMin" in news);
    assert.ok("lastDurationMs" in news);
    assert.ok("lastStatus" in news);

    const intelRawResponse = await fetch(`${baseUrl}/api/admin/news-raw?dataset=intel&page=1&pageSize=100`);
    const intelRawPayload = await intelRawResponse.json();
    assert.equal(intelRawResponse.status, 200);
    assert.equal(intelRawPayload.ok, true);
    assert.equal(intelRawPayload.data.summary.rawTotal, 2);
    assert.equal(
      intelRawPayload.data.summary.selectedTotal,
      Object.values(news.selectedCountByProvider).reduce((total, value) => total + Number(value || 0), 0)
    );
    assert.equal(
      intelRawPayload.data.summary.queryLengthTotal,
      Object.values(news.queryLengthByProvider).reduce((total, value) => total + Number(value || 0), 0)
    );
    assert.equal(intelRawPayload.data.pagination.page, 1);
    assert.equal(intelRawPayload.data.pagination.pageSize, 100);
    assert.equal(intelRawPayload.data.pagination.totalItems, 2);
    assert.equal(intelRawPayload.data.items.length, 2);

    const rssFetchCountBeforeRawEndpoint = rssFetchCount;
    const aggregateRawResponse = await fetch(`${baseUrl}/api/admin/news-raw?dataset=rss-aggregate&page=1&pageSize=100`);
    const aggregateRawPayload = await aggregateRawResponse.json();
    assert.equal(aggregateRawResponse.status, 200);
    assert.equal(aggregateRawPayload.ok, true);
    assert.ok(aggregateRawPayload.data.summary.rawTotal >= 1);
    assert.equal(aggregateRawPayload.data.pagination.page, 1);
    assert.equal(rssFetchCount, rssFetchCountBeforeRawEndpoint);
  } finally {
    global.fetch = originalFetch;
    await runtime.stop();
  }
});

test("admin routes remain open without IP allowlisting", async () => {
  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    market: {
      historyPersist: false
    },
    security: {}
  });

  await runtime.start();

  try {
    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const allowedResponse = await fetch(`${baseUrl}/api/admin/api-limits`, {
      headers: {
        "x-forwarded-for": "198.51.100.11"
      }
    });
    const allowedPayload = await allowedResponse.json();
    assert.equal(allowedResponse.status, 200);
    assert.equal(allowedPayload.ok, true);

    const adminPageResponse = await fetch(`${baseUrl}/admin`, {
      headers: {
        "x-forwarded-for": "198.51.100.11"
      }
    });
    assert.equal(adminPageResponse.status, 200);
  } finally {
    await runtime.stop();
  }
});

test("market disabled skips startup and manual refresh upstream market calls", async () => {
  const originalFetch = global.fetch;
  let twelveCalls = 0;
  let yahooCalls = 0;

  global.fetch = async (url, options) => {
    const value = String(url);

    if (value.includes("127.0.0.1") || value.includes("localhost")) {
      return originalFetch(url, options);
    }

    if (value.includes("api.twelvedata.com")) {
      twelveCalls += 1;
      return new Response("{}", {
        status: 500,
        headers: { "content-type": "text/plain" }
      });
    }

    if (value.includes("finance.yahoo.com")) {
      yahooCalls += 1;
      return new Response("{}", {
        status: 500,
        headers: { "content-type": "text/plain" }
      });
    }

    if (value.includes("youtube.com")) {
      return new Response("<html><body>offline</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Disabled Market Feed</title>
          <item>
            <title>Market provider remains disabled while RSS keeps flowing</title>
            <description>Manual refresh should not hit market APIs.</description>
            <link>https://example.com/disabled-market</link>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
        </channel>
      </rss>`,
      {
        status: 200,
        headers: { "content-type": "application/xml" }
      }
    );
  };

  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: false,
    news: {
      providers: ["rss"],
      rssFeeds: [{ label: "Disabled Market Feed", url: "https://example.com/rss.xml" }],
      newsApiKey: "",
      gnewsApiKey: "",
      mediastackApiKey: "",
      timeoutMs: 200
    },
    market: {
      provider: "",
      fallbackProvider: "",
      refreshIntervalMs: 300_000,
      requestReserve: 0,
      historyPersist: false
    },
    apiLimits: {
      newsapiDailyLimit: 10,
      gnewsDailyLimit: 10,
      mediastackDailyLimit: 10
    }
  });

  await runtime.start();

  try {
    await runtime.orchestrator.waitForIdle();
    assert.equal(twelveCalls, 0);
    assert.equal(yahooCalls, 0);

    await runtime.orchestrator.runManualRefresh({
      trigger: "disabled-market-test",
      countries: ["US", "IL", "IR"]
    });

    assert.equal(twelveCalls, 0);
    assert.equal(yahooCalls, 0);
  } finally {
    global.fetch = originalFetch;
    await runtime.stop();
  }
});

test("off-hours skip blocks only automated market cycles", async () => {
  const originalFetch = global.fetch;
  let twelveCalls = 0;
  let yahooCalls = 0;

  global.fetch = async (url, options) => {
    const value = String(url);

    if (value.includes("127.0.0.1") || value.includes("localhost")) {
      return originalFetch(url, options);
    }

    if (value.includes("api.twelvedata.com/quote")) {
      twelveCalls += 1;
      return new Response(
        JSON.stringify({
          data: [
            {
              symbol: "GD",
              close: "300.50",
              percent_change: "0.25",
              previous_close: "299.75",
              datetime: "2026-03-16 18:45:00",
              market_state: "CLOSED"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }

    if (value.includes("finance.yahoo.com")) {
      yahooCalls += 1;
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Off Hours Feed</title>
          <item>
            <title>Off hours cycle test</title>
            <description>Automated market cycles should stay paused.</description>
            <link>https://example.com/off-hours</link>
            <pubDate>${new Date().toUTCString()}</pubDate>
          </item>
        </channel>
      </rss>`,
      {
        status: 200,
        headers: { "content-type": "application/xml" }
      }
    );
  };

  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    market: {
      provider: "twelve",
      fallbackProvider: "yahoo",
      offHoursStrategy: "skip",
      twelveApiKey: "demo",
      twelveBaseUrl: "https://api.twelvedata.com",
      yahooBaseUrl: "https://finance.yahoo.com",
      yahooUserAgent: "ogid/1.0",
      tickers: ["GD"],
      historyPersist: false
    },
    news: {
      providers: ["rss"],
      rssFeeds: [{ label: "Off Hours Feed", url: "https://example.com/rss.xml" }],
      timeoutMs: 200
    },
    apiLimits: {
      twelveDailyLimit: 800,
      twelveDailyBudget: 600,
      twelveMinuteLimit: 8
    }
  });

  await runtime.start();

  try {
    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await runtime.orchestrator.runMarketCycle("manual-market", {
      now: "2026-03-20T15:20:00Z"
    });
    assert.equal(twelveCalls, 1);
    assert.equal(yahooCalls, 0);

    const openQuotesResponse = await fetch(`${baseUrl}/api/market/quotes?tickers=GD`);
    const openQuotesPayload = await openQuotesResponse.json();
    assert.equal(openQuotesResponse.status, 200);
    assert.equal(openQuotesPayload.data.market.session.state, "open");
    assert.equal(openQuotesPayload.data.market.sourceMeta.upstreamPaused, false);

    await runtime.orchestrator.runMarketCycle("interval-market", {
      now: "2026-03-21T15:10:00Z"
    });
    assert.equal(twelveCalls, 1);
    assert.equal(yahooCalls, 0);

    const skippedQuotesResponse = await fetch(`${baseUrl}/api/market/quotes?tickers=GD`);
    const skippedQuotesPayload = await skippedQuotesResponse.json();
    assert.equal(skippedQuotesResponse.status, 200);
    assert.equal(skippedQuotesPayload.data.market.session.state, "closed");
    assert.equal(skippedQuotesPayload.data.market.sourceMeta.upstreamPaused, true);
    assert.equal(skippedQuotesPayload.data.market.sourceMeta.pauseReason, "offhours-skip");

    await runtime.orchestrator.runMarketCycle("manual-market", {
      now: "2026-03-21T15:20:00Z"
    });
    assert.equal(twelveCalls, 2);
    assert.equal(yahooCalls, 0);
  } finally {
    global.fetch = originalFetch;
    await runtime.stop();
  }
});
