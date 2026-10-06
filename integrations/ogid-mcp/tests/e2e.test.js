import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("cliente MCP real y backend real: diez herramientas, paginación, mercado ausente y semántica semanal", async () => {
  createRequire(import.meta.url)("../../../backend/tests/testSetup.cjs");
  const { createAppServer } = await import("../../../backend/server.js");
  const runtime = createAppServer({ port: 0, host: "127.0.0.1", disableBackgroundRefresh: true, news: { providers: [], rssFeeds: [] }, market: { tickers: [], initialTickers: [], enabled: false, historyPersist: false } }); await runtime.start();
  const archive = runtime.app.locals.newsArchive;
  archive.ingest(Array.from({ length: 43 }, (_, index) => ({ id: `fixture-${index}`, title: `NVIDIA results ${index}`, url: `https://example.org/item/${index}`, provider: "rss", publishedAt: new Date(Date.now() - 1000 * index).toISOString() })));
  const client = new Client({ name: "ogid-research-e2e", version: "1.0" }); const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/index.js", import.meta.url))], env: { PATH: process.env.PATH, OGID_BASE_URL: `http://127.0.0.1:${runtime.server.address().port}`, OGID_INSTRUMENT_AUTH: "runtime" }, stderr: "pipe" });
  try {
    await client.connect(transport); assert.equal(client.getServerVersion().version, "0.2.0"); assert.equal((await client.listTools()).tools.length, 10);
    const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, `${name}: ${result.structuredContent?.error?.code}`); return result.structuredContent.data; };
    const capabilities = await call("ogid_get_capabilities"); assert.equal(capabilities.profile, "research"); assert.ok(capabilities.operations.every(operation => operation.permission === "read:stored"));
    for (const name of ["ogid_health", "ogid_get_news", "ogid_get_awareness", "ogid_get_awareness_sources"]) await call(name);
    const resolved = await call("ogid_resolve_instruments", { references: ["NVDA"] }); assert.equal(resolved.resolutions[0].status, "resolved"); const instrumentId = resolved.resolutions[0].instrumentId;
    const first = await call("ogid_search_news", { symbols: ["NVDA"], limit: 5 }); assert.equal(first.total, 43); assert.equal(first.articles.length, 5);
    const ids = first.articles.map(article => article.id); let cursor = first.nextCursor;
    while (cursor) { const page = await call("ogid_search_news", { cursor, limit: 10 }); ids.push(...page.articles.map(article => article.id)); cursor = page.nextCursor; }
    assert.equal(new Set(ids).size, 43);
    const item = await call("ogid_get_news_item", { id: ids[0] }); assert.equal(item.article.id, ids[0]);
    const watchlist = await call("ogid_query", { operationId: "market.watchlist" }); assert.deepEqual(watchlist.selectedSymbols, []);
    const weekly = await call("ogid_get_portfolio_context", { mode: "weekly", instrumentIds: [instrumentId] }); assert.equal(weekly.market[0].usable, false); assert.ok(weekly.news.coverage.partial); assert.equal(weekly.material.deliveryAcknowledged, false);
    const quote = await call("ogid_query", { operationId: "market.quotes", parameters: { tickers: ["NVDA"] } }); assert.equal(quote.quotes.NVDA.price, null); assert.equal(quote.quotes.NVDA.changePct, null);
    const smoke = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/smoke.js", import.meta.url))], { env: { PATH: process.env.PATH, OGID_BASE_URL: `http://127.0.0.1:${runtime.server.address().port}`, OGID_INSTRUMENT_AUTH: "runtime" }, timeout: 10000 });
    const records = smoke.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records[0].tools.length, 10);
    assert.equal(new Set(records.filter(row => row.tool).map(row => row.tool)).size, 10);
    assert.deepEqual(records.filter(row => row.mode).map(row => row.mode).sort(), ["agenda", "daily", "material", "weekly"]);
  } finally { await client.close(); await runtime.stop(); }
});
