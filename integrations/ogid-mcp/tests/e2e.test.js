import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await client.connect(transport); assert.equal(client.getServerVersion().version, "0.4.0"); assert.equal((await client.listTools()).tools.length, 10);
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
    assert.equal(quote.market,undefined);assert.equal(quote.timeseries,undefined);
    const technical=await call("ogid_query",{operationId:"market.technical-context",parameters:{instrumentId}});assert.equal(technical.package,"standard-v1");assert.equal(technical.sampleSize,0);assert.equal(technical.indicators.sma200.value,null);
    const events=await call("ogid_query",{operationId:"research.event-impact",parameters:{instrumentIds:[instrumentId]}});assert.ok(events.total>0);assert.equal(events.events[0].claimStatus,"unconfirmed");
    runtime.app.locals.scenarioService.refresh({instrumentIds:[instrumentId]});
    const scenarios=await call("ogid_query",{operationId:"research.scenarios",parameters:{instrumentIds:[instrumentId]}});assert.ok(scenarios.scenarios.every(s=>s.status==="pending-data"));assert.equal(scenarios.scenarios.length,3);
    const deltaArgs={operationId:"signals.delta",parameters:{consumerId:"offline-e2e",limit:1}};
    const delta=await call("ogid_query",deltaArgs);const repeated=await call("ogid_query",deltaArgs);assert.equal(delta.changes[0].changeId,repeated.changes[0].changeId);assert.equal(delta.delivery.verified,false);
    const evaluation=await call("ogid_query",{operationId:"research.forecast-evaluation"});assert.equal(evaluation.status,"insufficient-evaluation");assert.equal(evaluation.sampleSize,0);
    const etf=await call("ogid_resolve_instruments",{references:["QQQ"]});
    const holdings=await call("ogid_query",{operationId:"etf.holdings",parameters:{instrumentId:etf.resolutions[0].instrumentId}});assert.equal(holdings.holdings,null);assert.equal(holdings.missingReason,"no-dated-verified-issuer-holdings");
    const missing=await client.callTool({name:"ogid_query",arguments:{operationId:"market.history.job",parameters:{jobId:"offline-absent"}}});assert.equal(missing.structuredContent.error.code,"HISTORY_JOB_NOT_FOUND");
    const directory=mkdtempSync(join(tmpdir(),"ogid-mcp-operator-fixture-"));const credentialPath=join(directory,"credential.json");
    const credential={token:"offline_fixture_token_12345678901234567890",scopes:["signals:generate","signals:ack","forecasts:write"]};writeFileSync(credentialPath,JSON.stringify(credential),{mode:0o600});runtime.app.locals.mcpOperatorCredentials=[credential];
    const operator=new Client({name:"ogid-operator-e2e",version:"1"});
    try {
      await operator.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../src/index.js",import.meta.url))],env:{PATH:process.env.PATH,OGID_BASE_URL:`http://127.0.0.1:${runtime.server.address().port}`,OGID_PROFILE:"operator",OGID_OPERATOR_CREDENTIAL_FILE:credentialPath,OGID_INSTRUMENT_AUTH:"runtime"},stderr:"pipe"}));
      const refreshed=await operator.callTool({name:"ogid_operator",arguments:{operationId:"research.scenarios.refresh",body:{instrumentIds:[instrumentId]}}});assert.ok(!refreshed.isError);assert.equal(refreshed.structuredContent.data.changes,0);
      const acknowledged=await operator.callTool({name:"ogid_operator",arguments:{operationId:"signals.checkpoint",body:{consumerId:"offline-e2e",expectedSequence:0,checkpointCursor:delta.checkpointCursor}}});assert.ok(!acknowledged.isError);assert.equal(acknowledged.structuredContent.data.deliveryVerified,false);
      const afterAck=await call("ogid_query",deltaArgs);assert.notEqual(afterAck.changes[0].changeId,delta.changes[0].changeId);
      const forecast=await operator.callTool({name:"ogid_operator",arguments:{operationId:"research.forecast.register",body:{forecastId:"offline-no-bars",instrumentId,target:"direction",direction:"up",horizonHours:24,modelVersion:"offline-v1"}}});assert.equal(forecast.structuredContent.error.code,"FORECAST_DATA_UNAVAILABLE");
    } finally {await operator.close();rmSync(directory,{recursive:true,force:true});}
    // Fixture solo en este backend de prueba: cotización observada y series globales grandes.
    const {default:stateManager}=await import("../../../backend/state/stateManager.js");
    stateManager.hydrateMarketState({updatedAt:new Date().toISOString(),quotes:{NVDA:{price:100,changePct:1,currency:"USD",exchange:"Nasdaq",instrumentId,source:"yahoo",dataMode:"observed",synthetic:false,asOf:new Date().toISOString(),fetchedAt:new Date().toISOString()},MSFT:{price:200,changePct:2}},timeseries:{NVDA:Array(10000).fill({price:100}),MSFT:Array(10000).fill({price:200})}});
    const small=new Client({name:"ogid-budget-e2e",version:"1"});
    try {await small.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../src/index.js",import.meta.url))],env:{PATH:process.env.PATH,OGID_BASE_URL:`http://127.0.0.1:${runtime.server.address().port}`,OGID_INSTRUMENT_AUTH:"runtime",OGID_MAX_OUTPUT_BYTES:"4096"},stderr:"pipe"}));const result=await small.callTool({name:"ogid_query",arguments:{operationId:"market.quotes",parameters:{tickers:["NVDA"]}}});assert.ok(!result.isError);assert.ok(Buffer.byteLength(JSON.stringify(result))<=4096);assert.deepEqual(Object.keys(result.structuredContent.data.quotes),["NVDA"]);}finally{await small.close();}
    const smoke = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/smoke.js", import.meta.url))], { env: { PATH: process.env.PATH, OGID_BASE_URL: `http://127.0.0.1:${runtime.server.address().port}`, OGID_INSTRUMENT_AUTH: "runtime" }, timeout: 10000 });
    const records = smoke.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records[0].tools.length, 10);
    assert.equal(new Set(records.filter(row => row.tool).map(row => row.tool)).size, 10);
    assert.deepEqual(records.filter(row => row.mode).map(row => row.mode).sort(), ["agenda", "daily", "material", "weekly"]);
  } finally { await client.close(); await runtime.stop(); }
});
