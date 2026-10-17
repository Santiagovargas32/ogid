import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {migrate} from "../storage/migrate.js";
import {SqlResearchStore,SqlEventLedger} from "../storage/sqlRepositories.js";
import {loadSecSources} from "../services/research/secSourceCatalog.js";
import {OfficialSourceService} from "../services/research/officialSources.js";
import {SecSourceAgent} from "../services/research/secSourceAgent.js";
import {getInstrumentByCanonicalSymbol} from "../services/market/instrumentRegistry.js";
import {createAppServer} from "../server.js";
import {loadConfig} from "../../integrations/ogid-mcp/src/config.js";
import {createReadClient} from "../../integrations/ogid-mcp/src/client.js";
import {toolDefinitions} from "../../integrations/ogid-mcp/src/tools.js";
const companyId="sec-cik-0001045810",userAgent="OGID fixture@example.test";
const filing={cik:"0001045810",filings:{recent:{accessionNumber:["0001045810-26-000001"],form:["10-Q"],acceptanceDateTime:["2026-10-16T12:00:00Z"],primaryDocument:["report.htm"]}}};
const facts={cik:1045810,facts:{"us-gaap":{Assets:{label:"Assets",units:{USD:[{val:42,end:"2026-06-30",filed:"2026-08-01",accn:"0001045810-26-000001",form:"10-Q"}]}}}}};
function fixture({fetchImpl,timeoutMs}={}){
 const dir=mkdtempSync(join(tmpdir(),"ogid-sec-agent-")),file=join(dir,"db.sqlite"),db=new Database(file);db.pragma("journal_mode=WAL");migrate(db);
 const store=new SqlResearchStore(db),events=new SqlEventLedger({store}),sources=loadSecSources();let now=Date.parse("2026-10-17T12:00:00Z"),calls=0;
 const service=new OfficialSourceService({store,eventLedger:events,sources,userAgent,now:()=>now,timeoutMs,
  fetchImpl:async(url,options)=>{calls++;assert.equal(options.headers["User-Agent"],userAgent);return fetchImpl?fetchImpl(url,options):Response.json(url.includes("companyfacts")?facts:filing);}});
 const instruments=()=>[getInstrumentByCanonicalSymbol("NVDA")];
 return {db,file,store,events,sources,service,instruments,now:()=>now,advance:ms=>{now+=ms;},calls:()=>calls,
  agent:new SecSourceAgent({service,instruments,userAgent,now:()=>now}),close(){if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}};
}

test("built-in SEC catalog has distinct issuer sources, evidenced CIKs and public read endpoints",()=>{
 const sources=loadSecSources();assert.equal(sources.length,20);assert.equal(new Set(sources.map(s=>s.sourceId)).size,20);
 assert.equal(new Set(sources.map(s=>s.companyId)).size,10);
 assert.deepEqual(sources.find(s=>s.sourceId==="sec-alphabet-submissions").symbols,["GOOG","GOOGL"]);
 for(const source of sources){assert.equal(new URL(source.url).hostname,"data.sec.gov");assert.equal(source.enabled,true);assert.match(source.companyId,/^sec-cik-\d{10}$/);assert.ok(source.verifiedAt);}
});

test("agent acquires only selected issuer sources, coalesces cycles and persists facts/events across reopen",async()=>{
 const f=fixture();try{
  const first=f.agent.tick();assert.equal(f.agent.tick(),first);await first;
  assert.equal(f.calls(),2);assert.equal(f.agent.getStatus().status,"completed");
  assert.equal(f.store.getRow("companyFacts",companyId).metrics[0].observations[0].value,42);
  const events=f.events.search({instrumentIds:[getInstrumentByCanonicalSymbol("NVDA").instrumentId]});
  assert.equal(events.total,1);assert.equal(events.events[0].claimStatus,"officially-reported");
  await f.agent.tick();assert.equal(f.calls(),2);
  const reader=new Database(f.file,{readonly:true});
  assert.equal(new SqlResearchStore(reader).getRow("companyFacts",companyId).metrics[0].observations[0].value,42);reader.close();
 }finally{await f.agent.stop();f.close();}
});

test("missing SEC identity and unmapped ETFs cause no external acquisition",async()=>{
 const f=fixture();try{
  const missing=new SecSourceAgent({service:f.service,instruments:f.instruments});await missing.tick();
  assert.equal(missing.getStatus().errorCode,"SEC_USER_AGENT_REQUIRED");assert.equal(f.calls(),0);
  const stages=[];
  const funds=new SecSourceAgent({service:f.service,instruments:()=>[{instrumentId:"fund",assetType:"etf",canonicalSymbol:"QQQ"}],userAgent,monitor:{update:(_id,stage)=>stages.push(stage)}});
  await funds.tick();assert.equal(funds.getStatus().status,"idle");assert.equal(f.calls(),0);
  assert.equal(stages.at(-1).status,"completed");
 }finally{f.close();}
});

test("SEC rate limits stop the batch, honor Retry-After and survive an agent restart without losing facts",async()=>{
 const f=fixture({fetchImpl:async()=>new Response("",{status:429,headers:{"retry-after":"7200"}})});try{
  f.store.transact(state=>{state.companyFacts[companyId]={metrics:[{value:123}]};});
  await f.agent.tick();assert.equal(f.calls(),1);assert.equal(f.agent.getStatus().status,"degraded");
  const restarted=new SecSourceAgent({service:f.service,instruments:f.instruments,userAgent,now:f.now});await restarted.tick();
  assert.equal(f.calls(),1);assert.equal(restarted.getStatus().errorCode,"SEC_ACCESS_COOLDOWN");
  assert.equal(Date.parse(restarted.getStatus().nextEligibleAt),f.now()+7200000);
  assert.deepEqual(f.store.getRow("companyFacts",companyId).metrics,[{value:123}]);
 }finally{await f.agent.stop();f.close();}
});

test("a successful SEC retry clears the previous rate limit and allows other due issuer sources",async()=>{
 let limited=true;
 const f=fixture({fetchImpl:async(url)=>limited?new Response("",{status:429}):Response.json(url.includes("companyfacts")?facts:filing)});
 try{
  await f.agent.tick();assert.equal(f.calls(),1);
  limited=false;f.advance(3600000);await f.agent.tick();
  assert.equal(f.calls(),3);assert.equal(f.agent.getStatus().status,"completed");
  assert.equal(f.store.getRow("sourceStates","sec-nvda-companyfacts").failureCode,null);
  f.advance(900000);await f.agent.tick();
  assert.equal(f.calls(),4);assert.equal(f.agent.getStatus().status,"completed");
 }finally{await f.agent.stop();f.close();}
});

test("source deadlines cover stalled response bodies and retain the last stored company facts",async()=>{
 let cancelled=false;const keepAlive=setTimeout(()=>{},500);
 const f=fixture({timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))});try{
  f.store.transact(state=>{state.companyFacts[companyId]={metrics:[{value:123}]};});
  const result=await f.service.run({sourceIds:["sec-nvda-companyfacts"]});assert.equal(result.results[0].failureCode,"SOURCE_TIMEOUT");
  assert.equal(cancelled,true);assert.deepEqual(f.store.getRow("companyFacts",companyId).metrics,[{value:123}]);
 }finally{clearTimeout(keepAlive);f.close();}
});

test("stopping the SEC agent cancels acquisition and drains accepted persistence",async()=>{
 let cancelled=false,announce;const entered=new Promise(resolve=>{announce=resolve;});
 const f=fixture({fetchImpl:async()=>{announce();return new Response(new ReadableStream({cancel(){cancelled=true;}}));}});try{
  const task=f.agent.start();await entered;await new Promise(resolve=>setImmediate(resolve));await f.agent.stop();await task;
  assert.equal(cancelled,true);assert.equal(f.agent.getStatus().running,false);assert.equal(f.service.inFlight,null);assert.equal(f.calls(),1);
  assert.equal(f.store.getRow("sourceStates","sec-nvda-companyfacts").status,"cancelled");
 }finally{await f.agent.stop();f.close();}
});

test("MCP reads acquired SEC facts and catalogs without starting acquisition or authorizing mutations",async()=>{
 const f=fixture();let runtime;try{
  await f.agent.tick();
  runtime=createAppServer({port:0,host:"127.0.0.1",disableBackgroundRefresh:true,researchStore:f.store,
   researchSources:f.sources,news:{providers:[],rssFeeds:[]},market:{enabled:false,historyPersist:false}});
  await runtime.start();let mutations=0;
  runtime.app.locals.officialSourceService.run=async()=>{mutations++;throw new Error("read must not acquire");};
  const config=loadConfig({OGID_BASE_URL:`http://127.0.0.1:${runtime.server.address().port}`,OGID_INSTRUMENT_AUTH:"runtime"}),client=createReadClient(config);
  const stored=await client.operation("research.companyfacts",{companyId});assert.equal(stored.metrics[0].observations[0].value,42);
  const catalog=await client.operation("research.sources");assert.ok(catalog.sources.some(s=>s.companyId===companyId));assert.ok(catalog.agent);
  const tools=toolDefinitions(config,client);assert.ok(tools.every(t=>t.annotations.readOnlyHint));assert.ok(!tools.some(t=>t.name==="ogid_operator"));
  const response=await fetch(`${config.baseUrl}/api/research/sources/run`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sourceIds:["sec-nvda-submissions"]})});
  assert.equal(response.status,403);assert.equal(mutations,0);
 }finally{await runtime?.stop();await f.agent.stop();f.close();}
});
