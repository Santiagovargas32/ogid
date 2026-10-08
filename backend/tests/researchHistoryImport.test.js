import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchStore } from "../services/research/researchStore.js";
import { HistoricalImportService } from "../services/market/historicalImportService.js";
import { HistoricalAcquisitionService } from "../services/market/historicalAcquisitionService.js";
import { TechnicalContextService } from "../services/market/technicalContextService.js";
import { EventLedger } from "../services/research/eventLedger.js";
import { getInstrumentByCanonicalSymbol } from "../services/market/instrumentRegistry.js";
import { addDate, tradingDay } from "../services/market/exchangeCalendar.js";
import { parseAwarenessSource } from "../services/awareness/awarenessParsers.js";
import { createAppServer } from "../server.js";
import { YahooClient } from "../services/marketData/yahooClient.js";
import { MarketDataService } from "../services/marketData/marketDataService.js";

const instrument=getInstrumentByCanonicalSymbol("MSFT");
const now=Date.parse("2026-10-08T22:00:00Z");
function fixtureInput() {
  const dates=[];for(let date="2024-01-01";date<="2026-10-07";date=addDate(date,1))if(!tradingDay(instrument,date).closed)dates.push(date);
  return {requestId:"fixture-import",instrumentId:instrument.instrumentId,source:"fixture",sourceUrl:"https://example.org/history",providerSymbol:"MSFT",currency:"USD",adjustmentMode:"splits",startAt:"2024-01-01T00:00:00Z",endAt:new Date(now).toISOString(),csv:"Date,Open,High,Low,Close,Volume\n"+dates.slice(-500).map((date,i)=>`${date},${100+i},${102+i},${99+i},${101+i},1000`).join("\n")};
}
test("500 CSV daily bars: preview has no writes, import durable/idempotent, SMA200 available and Yahoo isolated",async()=>{
  const rootDir=mkdtempSync(join(tmpdir(),"ogid-csv-")),ledgerPath=join(rootDir,"ledger.json"),ledger=new ResearchStore({persistencePath:ledgerPath});
  const imports=new HistoricalImportService({ledger,rootDir,now:()=>now});const input=fixtureInput();
  const preview=await imports.import(input);assert.equal(preview.validBars,500);assert.equal(preview.sma200Warmup,true);assert.equal(ledger.state.revision,0);assert.deepEqual(readdirSync(rootDir),[]);
  const saved=await imports.import({...input,dryRun:false});assert.equal(saved.persistence.inserted,500);assert.equal((await imports.import({...input,dryRun:false})).replayed,true);
  await assert.rejects(imports.import({...input,csv:input.csv+"\n",dryRun:false}),e=>e.code==="IDEMPOTENCY_CONFLICT");
  const restored=new HistoricalImportService({ledger:new ResearchStore({persistencePath:ledgerPath}),rootDir,now:()=>now});
  const technical=new TechnicalContextService({store:{query:()=>[]},imports:restored,now:()=>new Date(now)});
  const context=technical.get({instrumentId:instrument.instrumentId,datasetId:saved.datasetId});assert.equal(context.sampleSize,500);assert.equal(context.indicators.sma200.value,500.5);assert.equal(context.quality.provider[0],"fixture");assert.equal(context.quality.reason,null);
  assert.equal(technical.get({instrumentId:instrument.instrumentId}).sampleSize,0);
  assert.throws(()=>technical.get({instrumentId:instrument.instrumentId,datasetId:saved.datasetId,adjusted:"none"}),e=>e.code==="HISTORY_DATASET_MISMATCH");
  assert.throws(()=>technical.get({instrumentId:instrument.instrumentId,datasetId:saved.datasetId,benchmarkInstrumentId:instrument.instrumentId}),e=>e.code==="HISTORY_DATASET_MISMATCH");
  assert.equal(technical.get({instrumentId:instrument.instrumentId,datasetId:saved.datasetId,interval:"1wk"}).interval,"1wk");
});
test("CSV rejects invalid dates/OHLCV/currency, future closes, conflicting duplicates and secrets before writes",async()=>{
  const ledger=new ResearchStore(),imports=new HistoricalImportService({ledger,rootDir:mkdtempSync(join(tmpdir(),"ogid-csv-invalid-")),now:()=>now}),input=fixtureInput();
  for(const change of [{currency:"EUR"},{sourceUrl:"https://example.org/history?apikey=secret"},{adjustmentMode:"total-return"},{csv:"Date,Open,High,Low,Close\n2026-02-30,1,2,1,2"},{csv:"Date,Open,High,Low,Close\n2026-10-08,100,90,99,101"},{csv:"Date,Open,High,Low,Close,Volume\n2026-10-08,100,102,99,101,-1"},{csv:"Date,Open,High,Low,Close\n2026-10-08,100,102,99,101\n2026-10-08,100,103,99,102"},{csv:"Date,Open,High,Low,Close,Adj Close\n2026-10-08,100,102,99,101,90"}])await assert.rejects(imports.import({...input,...change,dryRun:false}),e=>e.code==="INVALID_HISTORY_IMPORT");
  assert.equal(ledger.state.revision,0);
  const excessive="Date,Open,High,Low,Close\n"+Array.from({length:5001},()=>"2026-10-07,100,102,99,101").join("\n");
  await assert.rejects(imports.import({...input,csv:excessive}),e=>e.code==="INVALID_HISTORY_IMPORT");
  const early=new HistoricalImportService({ledger,rootDir:"unused",now:()=>Date.parse("2026-10-08T18:00:00Z")});await assert.rejects(early.import({...input,endAt:"2026-10-08T18:00:00Z",csv:"Date,Open,High,Low,Close\n2026-10-08,100,102,99,101"}),e=>e.code==="INVALID_HISTORY_IMPORT");
});
test("explicit history windows bound requests and coverage to requested dates",async()=>{
  const ledger=new ResearchStore();let requests=0;
  const service=new HistoricalAcquisitionService({ledger,now:()=>now,candleStore:{query:args=>{assert.equal(args.from,"2026-10-01T00:00:00Z");assert.equal(args.to,new Date(now).toISOString());return [];}},marketDataService:{fetchYahooBars:async(_symbol,options)=>{requests++;assert.equal(options.from,"2026-10-01T00:00:00.000Z");return {complete:true};}}});
  const job=service.create({requestId:"window",instrumentIds:[instrument.instrumentId],startAt:"2026-10-01T00:00:00Z",endAt:new Date(now).toISOString()});assert.equal(job.estimatedRequests,1);
  // Stored start is normalized; both the HTTP call and coverage share that bound.
  service.candleStore.query=args=>{assert.equal(args.from,"2026-10-01T00:00:00.000Z");return [];};
  const done=await service.run({jobId:job.jobId,maxRequests:4});assert.equal(requests,1);assert.equal(done.status,"completed");assert.equal(done.coverage[0].goalMet,false);
});
test("BLS/BEA shared URLs stay separate; source IDs scoped; real corrections keep revision; legacy quarantined",()=>{
  const store=new ResearchStore(),ledger=new EventLedger({store,now:()=>now});
  const item={title:"CPI",eventId:"cpi-oct",kind:"macro_release",url:"https://www.bls.gov/schedule/",scheduledAt:"2026-10-08T12:30:00Z",instrumentIds:[instrument.instrumentId],source:{sourceId:"bls",official:true}};
  ledger.ingest([item,{...item,eventId:"employment-oct",title:"Employment"},{...item,eventId:"ppi-oct",title:"PPI"},{...item,source:{sourceId:"bea",official:true}}]);assert.equal(ledger.search().total,4);
  const cpi=ledger.search().events.find(e=>e.sourceEventId==="cpi-oct"&&e.evidence[0].sourceId==="bls");
  ledger.ingest([{...item,title:"CPI corrected"}]);const corrected=ledger.search({eventIds:[cpi.eventId]}).events[0];assert.equal(corrected.revision,2);assert.equal(corrected.evidence.length,1);
  ledger.ingest([{...item,title:"CPI corrected"}]);assert.equal(ledger.search({eventIds:[cpi.eventId]}).events[0].revision,2);
  store.transact(state=>state.events.legacy={...corrected,eventId:"legacy",identityVersion:undefined,identityKey:undefined});
  const old=ledger.search({eventIds:["legacy"]}).events[0];assert.equal(old.quality.identityVerified,false);assert.deepEqual(old.impacts,[]);assert.ok(!ledger.search({instrumentIds:[instrument.instrumentId]}).events.some(e=>e.eventId==="legacy"));
  ledger.ingest([{title:"Microsoft earnings",url:"https://example.org/releases",sourceId:"weak-source",instrumentIds:[instrument.instrumentId]}]);
  const weak=ledger.search().events.find(e=>e.title==="Microsoft earnings");assert.equal(weak.quality.identityVerified,false);assert.equal(weak.quality.identityReason,"publication_identity_insufficient");assert.deepEqual(weak.impacts,[]);assert.equal(weak.evidence[0].sourceId,"weak-source");
});
test("BEA schedule recurring titles and common links identify release dates independently",()=>{
  const source={sourceId:"bea",url:"https://www.bea.gov/news/schedule",name:"BEA",adapter:"bea-schedule-html",timezone:"America/New_York",kind:"macro_release"};
  const body='<table><tr><td>October 8, 2026 8:30 AM</td><td><a href="/news/schedule">Gross Domestic Product</a></td></tr><tr><td>November 8, 2026 8:30 AM</td><td><a href="/news/schedule">Gross Domestic Product</a></td></tr></table>';
  const events=parseAwarenessSource(body,source,{observedAt:new Date(now).toISOString()});assert.equal(events.length,2);assert.notEqual(events[0].eventId,events[1].eventId);
});
test("local Awareness replay previews mapping, rejects changed snapshots and preserves legacy audit",()=>{
  const store=new ResearchStore(),ledger=new EventLedger({store,now:()=>now});
  const snapshot={mode:"visible",revision:1,recent:[],upcoming:[{eventId:"awe-cpi",title:"CPI",canonicalUrl:"https://www.bls.gov/schedule",scheduledAt:"2026-10-09T12:30:00Z",source:{sourceId:"bls",official:true}}]};
  const preview=ledger.replayAwareness(snapshot);assert.equal(preview.dryRun,true);assert.equal(preview.count,1);assert.equal(store.state.revision,0);
  assert.throws(()=>ledger.replayAwareness({...snapshot,revision:2},{dryRun:false,snapshotId:preview.snapshotId}),e=>e.code==="EVENT_REPLAY_SNAPSHOT_CHANGED");
  assert.throws(()=>ledger.replayAwareness({...snapshot,mode:"shadow"}),e=>e.code==="AWARENESS_NOT_VISIBLE");
  const saved=ledger.replayAwareness(snapshot,{dryRun:false,snapshotId:preview.snapshotId});assert.equal(saved.result.changed,1);assert.equal(ledger.replayAwareness(snapshot,{dryRun:false,snapshotId:preview.snapshotId}).result.changed,0);
});
test("history disables hidden chart retries and honors provider Retry-After",async()=>{
  let chartCalls=0;
  const client=new YahooClient({retries:2,client:{chart:async()=>{chartCalls++;throw Object.assign(new Error("fixture unavailable"),{status:503});}}});
  const service=new MarketDataService({yahooClient:client,store:{getBars:()=>({bars:[],cached:false})},now:()=>new Date(now)});
  await assert.rejects(service.fetchYahooBars("MSFT",{from:"2026-10-01T00:00:00Z",to:new Date(now).toISOString(),interval:"1d",force:true,allowStale:false,providerRetries:0}));assert.equal(chartCalls,1);
  const history=new HistoricalAcquisitionService({ledger:new ResearchStore(),candleStore:{query:()=>[]},now:()=>now,marketDataService:{fetchYahooBars:async(_symbol,options)=>{assert.equal(options.providerRetries,0);throw Object.assign(new Error("fixture limit"),{code:"YAHOO_RATE_LIMITED",retryAfterMs:7200000});}}});
  const job=history.create({requestId:"limited",instrumentIds:[instrument.instrumentId],targetBars:30});const result=await history.run({jobId:job.jobId,maxRequests:4});assert.equal(result.requestsThisRun,1);assert.equal(Date.parse(result.chunks[0].nextRetryAt),now+7200000);
});
test("admin history requires authentication and CSV preview/import/read works over real HTTP without providers",async()=>{
  const rootDir=mkdtempSync(join(tmpdir(),"ogid-csv-http-"));
  const runtime=createAppServer({port:0,host:"127.0.0.1",disableBackgroundRefresh:true,market:{tickers:[],initialTickers:[],enabled:false,historyPersist:false,historyDir:rootDir},news:{providers:[],rssFeeds:[]},security:{allowLocalAdmin:false,allowLanAdmin:false,adminApiToken:"fixture-admin"}});await runtime.start();
  const base=`http://127.0.0.1:${runtime.server.address().port}`,headers={"content-type":"application/json",authorization:"Bearer fixture-admin"};
  try {
    const input=fixtureInput();input.endAt=new Date(Math.min(now,Date.now())).toISOString();
    assert.equal((await fetch(base+"/api/admin/history")).status,401);
    assert.equal((await fetch(base+"/api/admin/history/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)})).status,401);
    const preview=await fetch(base+"/api/admin/history/import",{method:"POST",headers,body:JSON.stringify(input)});assert.equal(preview.status,200);assert.equal((await preview.json()).data.dryRun,true);
    const saved=await fetch(base+"/api/admin/history/import",{method:"POST",headers,body:JSON.stringify({...input,dryRun:false})});assert.equal(saved.status,200);const datasetId=(await saved.json()).data.datasetId;
    const datasets=await fetch(base+"/api/market/history/datasets");assert.equal((await datasets.json()).data.datasets.length,1);
    const context=await fetch(base+`/api/market/technical-context?instrumentId=${instrument.instrumentId}&datasetId=${datasetId}`);assert.equal(context.status,200);assert.equal((await context.json()).data.sampleSize,500);
    const status=await fetch(base+"/api/admin/history",{headers});assert.equal(status.status,200);assert.equal((await status.json()).data.datasets.length,1);
  } finally {await runtime.stop();}
});
