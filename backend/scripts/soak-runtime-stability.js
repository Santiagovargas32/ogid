// No external traffic or operator data. Default: thirty real minutes.
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

createRequire(import.meta.url)("../tests/testSetup.cjs");
process.env.LOG_LEVEL = "error";
const { createAppServer, readConfig } = await import("../server.js");
const nativeFetch = globalThis.fetch;
let externalRequests = 0,
  marketRequests = 0;
const fixturePublishedAt = new Date().toUTCString();
globalThis.fetch = async (url, options) => {
  if (new URL(String(url)).hostname === "127.0.0.1")
    return nativeFetch(url, options);
  externalRequests++;
  await delay(20, undefined, { signal: options?.signal });
  const items = Array.from(
    { length: 20 },
    (_, i) =>
      `<item><title>Fixture Israel conflict sanctions ${i}</title><link>https://fixture.test/${encodeURIComponent(new URL(String(url)).origin + new URL(String(url)).pathname)}/${i}</link><pubDate>${fixturePublishedAt}</pubDate></item>`,
  ).join("");
  return new Response(`<rss><channel>${items}</channel></rss>`);
};
const durationMs = Number(process.env.OGID_SOAK_DURATION_MS || 1_800_000);
const directory = await mkdtemp(join(tmpdir(), "ogid-runtime-soak-"));
const guard = fileURLToPath(new URL("./soak-network-guard.cjs", import.meta.url));
if (
  process.env.OGID_SOAK_SQL === "1" &&
  !process.env.NODE_OPTIONS?.includes(guard)
)
  throw Error(
    `SQL soak requires worker network guard: NODE_OPTIONS=--require=${guard}`,
  );
const fixtureServer = createServer(async (req, res) => {
  externalRequests++;
  await delay(20);
  res.setHeader("Content-Type", "application/rss+xml");
  res.end(
    "<rss><channel>" +
      Array.from(
        { length: 20 },
        (_, i) =>
          `<item><title>Fixture Israel conflict sanctions ${i}</title><link>https://fixture.test/${encodeURIComponent(req.url)}/${i}</link><pubDate>${fixturePublishedAt}</pubDate></item>`,
      ).join("") +
      "</channel></rss>",
  );
});
fixtureServer.listen(0, "127.0.0.1");
await once(fixtureServer, "listening");
const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
process.env.OGID_SOAK_FEED_BASE = fixtureBase;
const configuredFeeds = readConfig().news.rssFeeds;
const runtime = createAppServer({
  ...(process.env.OGID_SOAK_SQL === "1"
    ? {
        storage: {
          enabled: true,
          businessEnabled: true,
          databasePath: join(directory, "soak.sqlite"),
        },
      }
    : {}),
  port: 0,
  host: "127.0.0.1",
  disableBackgroundRefresh: true,
  wsHeartbeatMs: 1_000,
  news: {
    providers: ["rss"],
    // Keep the complete source catalog, including disabled entries and generated
    // searches. The worker preload redirects transport without changing IDs.
    rssFeeds: configuredFeeds,
    rssAggregateIntervalMs: 2_000,
    rssAggregateFeedsPerRun: 18,
    rssAggregateMaxItems: 900,
    rssCanonicalStateFile: join(directory, "rss.json"),
  },
  market: {
    provider: "yahoo",
    enabled: true,
    tickers: ["GD", "BA"],
    historyPersist: false,
    dailyCandles: { enabled: false },
    intradayCandles: { enabled: false },
  },
  marketDataService: {
    fetchQuotes: async (symbols) => {
      marketRequests++;
      // Regular outages exercise stale data without synthesizing a current quote.
      if (marketRequests % 5 === 0)
        throw Object.assign(Error("fixture-upstream"), { status: 503 });
      return symbols.map((symbol) => ({
        symbol,
        price: 100,
        previousClose: 99,
        changePercent: 1,
        high: 101,
        low: 98,
        volume: 1000,
        currency: "USD",
        exchange: "NYSE",
        timezone: "America/New_York",
        timestamp: new Date().toISOString(),
        marketState: "CLOSED",
      }));
    },
  },
  awareness: { mode: "off" },
  ai: { provider: "none", mode: "off" },
});
const started = performance.now(),
  cpu = process.cpuUsage(),
  elu = performance.eventLoopUtilization();
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const clients = [],
  samples = [],
  latencies = [];
let unexpectedCloses = 0,
  wsMessages = 0,
  wsBytes = 0,
  cycles = 0;
let result;
const checkpoint = async (value) => {
  const target = join(directory, "progress.json");
  await writeFile(target + ".tmp", JSON.stringify(value, null, 2));
  await rename(target + ".tmp", target);
};
const storageSample = () => {
  const writer = runtime.storageManager.getStatus();
  return {
    state: writer.state,
    walBytes: writer.walBytes,
    databaseBytes: writer.databaseBytes,
    analysisRecoveries: writer.analysisRecovery.recoveries,
    queryRecoveries: writer.queryRecovery.recoveries,
    queue: writer.queue,
    completed: writer.completed,
    failed: writer.failed,
    rejected: writer.rejected,
    analysis: writer.analysis && {
      state: writer.analysis.state,
      queue: writer.analysis.queue,
      completed: writer.analysis.completed,
      failed: writer.analysis.failed,
      rejected: writer.analysis.rejected,
    },
    queries: writer.queries && {state:writer.queries.state,queue:writer.queries.queue,failed:writer.queries.failed,rejected:writer.queries.rejected},
  };
};
console.log(JSON.stringify({ state: "starting", directory, durationMs }));
await checkpoint({
  state: "starting",
  durationMs,
  startedAt: new Date().toISOString(),
});
try {
  await runtime.start();
  if (runtime.config.market.tickers.length !== 2)
    throw Error("fixture-watchlist-not-loaded");
  const startupMs = performance.now() - started;
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  for (let i = 0; i < 10; i++) {
    const client = new WebSocket(base.replace("http:", "ws:") + "/ws", {
      origin: base,
    });
    client.on("message", (raw) => {
      wsMessages++;
      wsBytes += raw.length;
    });
    client.on("close", () => {
      unexpectedCloses++;
    });
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    clients.push(client);
  }
  const until = performance.now() + durationMs;
  while (performance.now() < until) {
    const refresh = Promise.all([
      runtime.orchestrator.runCycle("soak"),
      runtime.orchestrator.runMarketCycle("soak"),
    ]);
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const t = performance.now();
        const response = await nativeFetch(
          base +
            (i % 2
              ? "/api/health"
              : "/api/intel/snapshot?countries=ALL&limit=100"),
        );
        await response.arrayBuffer();
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        latencies.push(performance.now() - t);
        if (latencies.length > 10_000) latencies.shift();
      }),
    );
    await refresh;
    cycles++;
    if (
      !samples.length ||
      performance.now() - started - samples.at(-1).elapsedMs >= 60_000
    ) {
      globalThis.gc?.();
      samples.push({
        elapsedMs: performance.now() - started,
        memory: process.memoryUsage(),
        pending: runtime.orchestrator.pendingCycles.size,
        clients: runtime.socketServer.clientCount(),
        storage: storageSample(),
        rss: runtime.app.locals.rssAggregator.getStatus?.() || null,
        rssCanonical: (await runtime.storageManager.request('domain.call',{service:'rss',method:'getSnapshot',args:[{stored:true}]})).meta,
      });
      await checkpoint({ state: "running", durationMs, cycles, samples });
    }
    await delay(Math.min(2_000, Math.max(0, until - performance.now())));
  }
  latencies.sort((a, b) => a - b);
  const at = (p) =>
    latencies[
      Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)
    ];
  result = {
    networkIsolation:
      "complete production RSS catalog redirected to loopback fixtures by worker preload; no external providers",
    configuredFeedCount:configuredFeeds.length,
    node: process.version,
    durationMs,
    elapsedMs: performance.now() - started,
    startupMs,
    cycles,
    cpu: process.cpuUsage(cpu),
    memory: process.memoryUsage(),
    eventLoopUtilization: performance.eventLoopUtilization(elu),
    eventLoopDelayMs: {
      p50: lag.percentile(50) / 1e6,
      p95: lag.percentile(95) / 1e6,
      p99: lag.percentile(99) / 1e6,
      max: lag.max / 1e6,
    },
    httpMs: {
      samples: latencies.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
    },
    externalRequests,
    marketRequests,
    unexpectedCloses,
    wsMessages,
    wsBytes,
    websocket: runtime.socketServer.getHealth().metrics,
    samples,
  };
  await checkpoint({ state: "completed", durationMs, cycles, samples });
} catch (error) {
  await checkpoint({
    state: "failed",
    errorCode: error.code || error.message,
    elapsedMs: performance.now() - started,
    durationMs,
    cycles,
    samples,
    storage: storageSample(),
  });
  throw error;
} finally {
  for (const client of clients) client.removeAllListeners("close");
  await Promise.all(
    clients.map(
      (client) =>
        new Promise((resolve) => {
          if (client.readyState === WebSocket.CLOSED) return resolve();
          client.once("close", resolve);
          client.close(1000, "soak-complete");
        }),
    ),
  );
  await runtime.stop();
  await new Promise((r) => fixtureServer.close(r));
  lag.disable();
  globalThis.fetch = nativeFetch;
}
if (result) {
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify(
      { ...result, artifact: join(directory, "result.json") },
      null,
      2,
    ),
  );
  if (
    result.unexpectedCloses ||
    result.eventLoopDelayMs.p95 >= 100 ||
    result.samples.some((s) => s.pending || s.clients !== 10)
    || result.samples.some(s=>s.storage.analysisRecoveries || s.storage.queryRecoveries || s.rssCanonical?.canonicalMetrics?.errors)
  )
    process.exitCode = 1;
}
