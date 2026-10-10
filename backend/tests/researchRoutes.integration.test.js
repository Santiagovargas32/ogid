import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer } from "../server.js";
import { OGID_OPERATIONS, getOperation, operationPath, OPERATIONS_VERSION } from "../contracts/ogidOperations.js";
import { projectOperation } from "../utils/researchProjection.js";
import { getInstrumentByCanonicalSymbol } from "../services/market/instrumentRegistry.js";
import { NewsArchive } from "../services/research/newsArchive.js";
import { createReadClient } from "../../integrations/ogid-mcp/src/client.js";
import { loadConfig } from "../../integrations/ogid-mcp/src/config.js";
import { executeTool, toolDefinitions } from "../../integrations/ogid-mcp/src/tools.js";
import { readOperatorCredentials } from "../middleware/mcpOperatorAuth.js";
import { ResearchStore } from "../services/research/researchStore.js";

test("research ledger capacity does not interrupt legacy news collection and reports blocked coverage",()=>{
  const runtime=createAppServer({disableBackgroundRefresh:true,researchStore:new ResearchStore({maxEntries:0}),news:{providers:[],rssFeeds:[]},market:{enabled:false,historyPersist:false,initialTickers:[],tickers:[]}});
  assert.doesNotThrow(()=>runtime.app.locals.newsArchive.ingest([{id:"offline-capacity",title:"NVIDIA results",url:"https://example.org/capacity",provider:"rss",publishedAt:"2026-10-08T12:00:00Z"}]));
  assert.equal(runtime.app.locals.newsArchive.search().total,1);assert.equal(runtime.app.locals.researchPipeline.archiveEvents.status,"blocked");assert.equal(runtime.app.locals.researchPipeline.archiveEvents.failureCode,"RESEARCH_CAPACITY");assert.equal(runtime.app.locals.researchPipeline.archiveEvents.pendingReplay,true);
  runtime.app.locals.researchStore.maxEntries=20;
  runtime.app.locals.newsArchive.ingest([{id:"offline-after-capacity",title:"NVIDIA updated results",url:"https://example.org/capacity-restored",provider:"rss",publishedAt:"2026-10-08T13:00:00Z"}]);
  assert.equal(runtime.app.locals.researchPipeline.archiveEvents.status,"partial");assert.equal(runtime.app.locals.researchPipeline.archiveEvents.pendingReplay,true);
});

test("inventario: todas las rutas JSON montadas tienen contrato y permiso; rutas nuevas sin clasificar fallan", () => {
  const malformed = join(mkdtempSync(join(tmpdir(), "ogid-credential-test-")), "operator.json");
  writeFileSync(malformed, 'PRIVATE_TOKEN_DO_NOT_REFLECT_invalid_json', { mode: 0o600 });
  assert.throws(() => readOperatorCredentials(malformed), error => !error.message.includes("PRIVATE_TOKEN") && !error.message.includes(malformed) && error.message.includes("credentials"));
  const dir = fileURLToPath(new URL("../routes/", import.meta.url));
  const enumerate = (filename, prefix, seen = new Set()) => {
    if (seen.has(filename)) throw new Error("router cycle"); seen.add(filename);
    const source = readFileSync(dir + filename, "utf8"); const imports = new Map([...source.matchAll(/import\s+(\w+)\s+from\s+(["'])\.\/(\w+\.js)\2/g)].map(match => [match[1], match[3]])); const routes = [];
    const declarations = [...source.matchAll(/router\.\w+\s*\(/g)];
    const endpoints = [...source.matchAll(/router\.(get|post|put|delete|patch)\s*\(\s*(["'`])([^"'`]+)\2/g)];
    const mounts = [...source.matchAll(/router\.use\s*\(\s*(?:(["'`])([^"'`]*)\1\s*,\s*)?(\w+)\s*\)/g)];
    assert.equal(endpoints.length + mounts.length, declarations.length, `${filename}: nueva sintaxis de rutas requiere ampliar inventario`);
    for (const match of endpoints) { assert.ok(!match[3].includes("${"), "ruta dinámica sin inventariar"); routes.push(`${match[1].toUpperCase()} ${prefix}${match[3]}`); }
    for (const match of mounts) routes.push(...enumerate(imports.get(match[3]), prefix + (match[2] || ""), new Set(seen)));
    return routes;
  };
  const mounted = new Set(enumerate("index.js", "/api")); const registered = new Set(OGID_OPERATIONS.map(op => `${op.method} ${op.path}`));
  assert.deepEqual([...mounted].sort(), [...registered].sort()); assert.equal(OPERATIONS_VERSION, "1.3.0");
  for (const operation of OGID_OPERATIONS) { assert.ok(operation.scope); assert.ok(operation.effects); assert.ok(operation.projection); assert.equal(operation.parameters.additionalProperties, false); assert.ok(["research", "operator"].includes(operation.profile)); }
});
test("todas las lecturas MCP sobre backend real: almacenadas, sin refresh/cuotas, identidades y separación operador", async () => {
  const archive = new NewsArchive();
  const token = "fixture_operator_" + "x".repeat(40);
  const runtime = createAppServer({ port: 0, host: "127.0.0.1", disableBackgroundRefresh: true, market: { tickers: [], initialTickers: [], enabled: false, historyPersist: false }, news: { providers: [], rssFeeds: [] }, security: { allowLocalAdmin: false, adminApiToken: "" }, newsArchive: archive, mcpOperatorCredentials: [{ token, scopes: ["admin:read", "alerts:ack"] }] });
  await runtime.start();
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`; const config = loadConfig({ OGID_BASE_URL: baseUrl, OGID_INSTRUMENT_AUTH: "runtime" }); const read = createReadClient(config);
  let external = 0; runtime.app.locals.rssAggregator.refresh = async () => { external++; throw new Error("unexpected-provider-query"); };
  runtime.mediaStreamService.resolveSelectedStreams = async () => { external++; throw new Error("unexpected-media-query"); };
  runtime.marketConditionsService.intradayCandleService.poll = async () => { external++; throw new Error("unexpected-market-query"); };
  runtime.app.locals.marketDataService.searchSymbols = async () => { external++; return []; };
  runtime.manualRefreshService.request = () => { throw new Error("unexpected-refresh"); };
  runtime.mediaStreamService.snapshot = { generatedAt: null, sections: { situational: [{ id: "fixture-stream", name: "Fixture", availability: "unavailable" }], webcams: [] }, summary: {} };
  archive.ingest([{ id: "fixture-original", title: "NVIDIA earnings", url: "https://example.org/nvidia", provider: "rss", publishedAt: new Date().toISOString() }]);
  const id = archive.search().articles[0].id; const nvda = getInstrumentByCanonicalSymbol("NVDA").instrumentId;
  try {
    for (const operation of OGID_OPERATIONS.filter(op => op.profile === "research")) {
      const params = ["market.candles","market.indicators","market.technical-context"].includes(operation.id) ? { instrumentId: nvda } : operation.id === "etf.holdings" ? {instrumentId:getInstrumentByCanonicalSymbol("QQQ").instrumentId} : operation.id === "market.history.job" ? {jobId:runtime.app.locals.historicalAcquisitionService.create({requestId:"fixture",instrumentIds:[nvda]}).jobId} : operation.id === "research.companyfacts" ? {companyId:"unavailable-fixture"} : operation.id === "portfolio.context" ? { mode: "weekly", instrumentIds: [nvda] } : {};
      const path = operation.pathParameters ? { id: operation.id === "news.item" ? id : "fixture-stream" } : undefined;
      const data = await read.operation(operation.id, params, undefined, path); assert.ok(data && typeof data === "object", operation.id);
      const output = JSON.stringify(projectOperation(operation, data)); assert.ok(!output.includes("/home/fedora"), operation.id);
    }
    assert.equal(external, 0);
    const filtered = await read.operation("news.search", { symbols: ["NVDA"] }); assert.equal(filtered.total, 1); assert.equal(filtered.articles[0].countryMentions.length, 0);
    const tools = toolDefinitions(config, read); assert.equal(tools.length, 10); assert.ok(!tools.some(tool => tool.name === "ogid_operator"));
    const portfolio = await executeTool(tools.find(tool => tool.name === "ogid_get_portfolio_context"), { mode: "weekly", instrumentIds: [nvda] }, config);
    assert.equal(portfolio.structuredContent.ok, true); assert.equal(portfolio.structuredContent.data.market[0].usable, false); assert.ok(portfolio.structuredContent.data.warnings.some(warning => warning.includes("semana")));
    for (const operation of OGID_OPERATIONS.filter(op => op.profile === "operator")) await assert.rejects(read.operation(operation.id, {}, operation.body ? {} : undefined, operation.pathParameters ? { id: "fixture-stream" } : undefined));
    const forged = await fetch(baseUrl + "/api/admin/pipeline-status", { headers: { "x-ogid-mcp-operation": "admin.pipeline-status", authorization: "Bearer invalid" } }); assert.equal(forged.status, 403);
    const operatorConfig = { ...config, profile: "operator", operatorCredential: { token, scopes: ["admin:read", "alerts:ack"] } }; const operatorRead = createReadClient(operatorConfig);
    const admin = await operatorRead.operation("admin.pipeline-status"); const projected = JSON.stringify(projectOperation(getOperation("admin.pipeline-status"), admin)); assert.ok(!projected.includes("requestUrls")); assert.ok(!projected.includes("/home/")); assert.ok(!projected.includes(token));
    await assert.rejects(operatorRead.operation("market.instruments.search", { q: "NVDA" }), error => error.code === "FORBIDDEN_REQUEST");
    const deniedScope = await fetch(baseUrl + "/api/intel/refresh", { method: "POST", headers: { "x-ogid-mcp-operation": "intel.refresh", authorization: "Bearer " + token, "content-type": "application/json" }, body: "{}" }); assert.equal(deniedScope.status, 403);
    assert.equal(external, 0);
  } finally { await runtime.stop(); }
});
