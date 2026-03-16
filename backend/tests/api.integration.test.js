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

    if (value.includes("stooq.com/q/l/")) {
      return new Response(
        "Symbol,Date,Time,Open,High,Low,Close,Volume,Name\nGD.US,2026-03-16,18:45:00,300.00,301.00,299.00,300.50,1000,General Dynamics\nBA.US,2026-03-16,18:45:00,200.00,201.00,199.00,200.25,1100,Boeing\nNOC.US,2026-03-16,18:45:00,450.00,452.00,449.00,451.10,900,Northrop Grumman",
        {
          status: 200,
          headers: { "content-type": "text/csv" }
        }
      );
    }

    if (value.includes("stooq.com/q/d/l/")) {
      return new Response(
        "Date,Open,High,Low,Close,Volume\n2026-03-14,296.00,299.00,295.00,298.00,1000\n2026-03-15,298.00,300.00,297.00,299.00,1100",
        {
          status: 200,
          headers: { "content-type": "text/csv" }
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
    security: {
      adminMenuVisible: false,
      adminIpAllowlist: []
    },
    market: {
      provider: "web",
      fallbackProvider: "fmp",
      webSource: "stooq",
      webBaseUrl: "https://stooq.com",
      webUserAgent: "ogid/1.0",
      tickers: ["GD", "BA", "NOC"],
      refreshIntervalMs: 300_000,
      apiKey: "",
      fmpApiKey: "",
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
      mediastackDailyLimit: 10
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
    assert.equal(healthPayload.data.publicConfig.adminMenuVisible, false);
    assert.equal(healthPayload.data.market.configuredProvider, "web");
    assert.equal(healthPayload.data.market.configuredFallbackProvider, "fmp");
    assert.equal(healthPayload.data.market.effectiveProvider, "web");
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
    assert.ok(limitsPayload.data.providers.every((provider) => "quotaBand" in provider));

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
    assert.ok(pipelinePayload.data.market.webDiagnostics);
    assert.equal(pipelinePayload.data.market.configuredProvider, "web");
    assert.equal(pipelinePayload.data.market.configuredFallbackProvider, "fmp");
    assert.equal(pipelinePayload.data.market.effectiveProvider, "web");
    assert.ok(pipelinePayload.data.market.providerDiagnostics);
    assert.ok(pipelinePayload.data.market.providerDiagnostics.web);
    assert.ok(pipelinePayload.data.market.providerDiagnostics.fmp);
    assert.equal(pipelinePayload.data.market.providerDiagnostics.web.status, "ok");
    assert.equal(pipelinePayload.data.market.providerDiagnostics.fmp.status, "idle");
    assert.equal(pipelinePayload.data.market.historicalPersistence.enabled, false);
    assert.equal(pipelinePayload.data.market.webDiagnostics.configuredSource, "stooq");
    assert.equal(pipelinePayload.data.market.webDiagnostics.status, "ok");
    assert.ok(Array.isArray(pipelinePayload.data.market.webDiagnostics.returnedTickers));
    assert.ok(Array.isArray(pipelinePayload.data.market.webDiagnostics.sampleQuotes));
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
    security: {
      adminMenuVisible: false,
      adminIpAllowlist: []
    },
    market: {
      provider: "",
      fallbackProvider: "",
      refreshIntervalMs: 300_000,
      apiKey: "",
      fmpApiKey: "",
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
    assert.equal(market.webDiagnostics.status, "disabled");
    assert.equal(market.webDiagnostics.configuredSource, "stooq");
    assert.equal(market.providerDiagnostics.web.status, "disabled");
    assert.equal(market.providerDiagnostics.fmp.status, "disabled");
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

test("admin allowlist enforces trusted proxy client ip on admin routes", async () => {
  const runtime = createAppServer({
    port: 0,
    disableBackgroundRefresh: true,
    market: {
      historyPersist: false
    },
    security: {
      trustProxy: true,
      adminIpAllowlist: ["198.51.100.10/32"]
    }
  });

  await runtime.start();

  try {
    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const deniedResponse = await fetch(`${baseUrl}/api/admin/api-limits`, {
      headers: {
        "x-forwarded-for": "198.51.100.11"
      }
    });
    const deniedPayload = await deniedResponse.json();
    assert.equal(deniedResponse.status, 403);
    assert.equal(deniedPayload.ok, false);
    assert.equal(deniedPayload.error.code, "ADMIN_IP_FORBIDDEN");

    const allowedResponse = await fetch(`${baseUrl}/api/admin/api-limits`, {
      headers: {
        "x-forwarded-for": "198.51.100.10"
      }
    });
    const allowedPayload = await allowedResponse.json();
    assert.equal(allowedResponse.status, 200);
    assert.equal(allowedPayload.ok, true);

    const adminPageResponse = await fetch(`${baseUrl}/admin`, {
      headers: {
        "x-forwarded-for": "198.51.100.10"
      }
    });
    assert.equal(adminPageResponse.status, 200);
  } finally {
    await runtime.stop();
  }
});

test("market disabled skips startup and manual refresh upstream market calls", async () => {
  const originalFetch = global.fetch;
  let webCalls = 0;
  let fmpCalls = 0;

  global.fetch = async (url, options) => {
    const value = String(url);

    if (value.includes("127.0.0.1") || value.includes("localhost")) {
      return originalFetch(url, options);
    }

    if (value.includes("stooq.com")) {
      webCalls += 1;
      return new Response("{}", {
        status: 500,
        headers: { "content-type": "text/plain" }
      });
    }

    if (value.includes("financialmodelingprep.com")) {
      fmpCalls += 1;
      return new Response("{}", {
        status: 500,
        headers: { "content-type": "application/json" }
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
      apiKey: "",
      fmpApiKey: "",
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
    assert.equal(webCalls, 0);
    assert.equal(fmpCalls, 0);

    await runtime.orchestrator.runManualRefresh({
      trigger: "disabled-market-test",
      countries: ["US", "IL", "IR"]
    });

    assert.equal(webCalls, 0);
    assert.equal(fmpCalls, 0);
  } finally {
    global.fetch = originalFetch;
    await runtime.stop();
  }
});
