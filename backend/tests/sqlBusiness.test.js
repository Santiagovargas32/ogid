import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { StorageManager } from "../storage/StorageManager.js";
import { createAppServer } from "../server.js";
import { NewsArchive } from "../services/research/newsArchive.js";
import { listVerifiedInstruments, getInstrumentById } from "../services/market/instrumentRegistry.js";
import { normalizeCanonicalCandle } from "../services/market/canonicalCandle.js";
import { fetchRawNews } from "../services/newsService.js";
import { EventLedger } from "../services/research/eventLedger.js";
import { ResearchStore } from "../services/research/researchStore.js";
import { AwarenessStore } from "../services/awareness/awarenessStore.js";
import { PipelinePersistence } from "../storage/pipelinePersistence.js";
const instrumentId="us-equity-general-dynamics";
const article=(n,extra={})=>({id:`source-${n}`,title:`General Dynamics earnings ${n}`,url:`https://example.org/${n}`,publishedAt:new Date(Date.now()-86400000+n*1000).toISOString(),provider:"fixture-rss",usagePolicy:"headline-only-link-out",description:"Content must not be exposed",...extra});
async function fixture(){const dir=mkdtempSync(join(tmpdir(),"ogid-sql-business-")),db=join(dir,"test.sqlite"),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:db});await manager.start();await manager.request("domain.configure",{instruments:listVerifiedInstruments(),rootDir:dir,researchSources:[],signalPolicy:{},rss:{rssFeeds:[],maxFeedsPerRun:18,maxCorpusItems:900}});return {dir,db,manager,call:(service,method,...args)=>manager.request("domain.call",{service,method,args}),async close(){await this.manager.close();rmSync(dir,{recursive:true,force:true});}};}

test("SQL archive preserves policies, matching and frozen pagination across revisions",async()=>{
  const f=await fixture();try {
    const legacy=new NewsArchive(),values=[article(1),article(2),article(3)];legacy.ingest(values);await f.call("news","ingest",values);
    const expected=legacy.search({instrumentIds:[instrumentId],limit:1}),first=await f.call("news","search",{instrumentIds:[instrumentId],limit:1});
    assert.equal(first.total,expected.total);assert.equal(first.articles[0].id,expected.articles[0].id);assert.equal(first.articles[0].excerpt,null);
    assert.deepEqual(first.articles[0].matchReasons,expected.articles[0].matchReasons);
    await f.call("news","ingest",[article(2,{title:"General Dynamics revised earnings"})]);
    const next=await f.call("news","search",{cursor:first.nextCursor,limit:2});assert.equal(next.revision,first.revision);assert.equal(next.articles.find(a=>a.originalIds.includes("source-2")).title,"General Dynamics earnings 2");
    await assert.rejects(f.call("news","search",{cursor:first.nextCursor,q:"different"}),{code:"CURSOR_FILTER_MISMATCH",statusCode:400});
    const item=await f.call("news","getItem","source-2");assert.equal(item.article.revision,2);
    const db=new Database(f.db,{readonly:true});assert.equal(db.prepare("SELECT count(*) AS n FROM article_revisions").get().n,4);assert.equal(db.prepare("SELECT count(*) AS n FROM article_instruments").get().n,3);db.close();
    await f.manager.close();f.manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:f.db});await f.manager.start();await f.manager.request("domain.configure",{instruments:listVerifiedInstruments(),rootDir:f.dir,rss:{rssFeeds:[]}});
    const result=await f.manager.request("domain.call",{service:"news",method:"getItem",args:["source-2"]});assert.equal(result.article.revision,2);
    await assert.rejects(f.manager.request("domain.call",{service:"news",method:"search",args:[{cursor:first.nextCursor}]}),{code:"CURSOR_EXPIRED",statusCode:410});
  }finally{await f.close();}
});

test("SQL candles update one local daily session, preserve revisions and isolate datasets",async()=>{
  const f=await fixture();try{
    const {candle}=normalizeCanonicalCandle({instrumentId,interval:"1day",date:"2026-07-14",open:100,high:110,low:90,close:105,volume:1000},{instrument:getInstrumentById(instrumentId),source:"yahoo",providerSymbol:"GD",adjustmentMode:"splits",fetchedAt:"2026-07-15T23:00:00.000Z"});
    assert.equal((await f.call("candles","upsert",[candle])).inserted,1);
    const revised={...candle,close:107,fetchedAt:"2026-07-16T23:00:00.000Z"};assert.equal((await f.call("candles","upsert",[revised])).updated,1);
    assert.equal((await f.call("candles","upsert",[revised])).duplicates,1);
    const rows=await f.call("candles","query",{instrumentId});assert.equal(rows.length,1);assert.equal(rows[0].revision,2);assert.equal(rows[0].close,107);assert.equal(await f.call("candles","has",instrumentId,candle.openTime),true);
    const db=new Database(f.db,{readonly:true});assert.equal(db.prepare("SELECT count(*) AS n FROM candle_revisions").get().n,2);db.close();
    const indicator=await f.call("indicators","calculate",{instrumentId});assert.equal(indicator.instrumentId,instrumentId);
    const sql=new Database(f.db,{readonly:true});assert.equal(sql.prepare("SELECT count(*) AS n FROM analysis_runs").get().n,1);sql.close();
  }finally{await f.close();}
});

test("SQL archive filters source update time independently of receipt and archive changes",async()=>{
  const f=await fixture();try{
    const updatedAt=new Date(Date.now()-12*3600000).toISOString();
    const values=[article(1,{updatedAt}),article(2,{updatedAt:null})];
    const legacy=new NewsArchive();legacy.ingest(values);await f.call("news","ingest",values);
    const filters={timeField:"updatedAt",from:new Date(Date.parse(updatedAt)-1000).toISOString(),to:new Date(Date.parse(updatedAt)+1000).toISOString()};
    const expected=legacy.search(filters),actual=await f.call("news","search",filters);
    assert.equal(actual.total,1);
    assert.deepEqual(actual.articles.map(row=>row.id),expected.articles.map(row=>row.id));
    const archiveChanges=await f.call("news","search",{...filters,timeField:"archiveChangedAt"});
    assert.equal(archiveChanges.total,0);
  }finally{await f.close();}
});

test("offline import retains original IDs and is repeatable without modifying JSON files",async()=>{
  const f=await fixture();try{
    const source=join(f.dir,"news.json"),archive=new NewsArchive({persistencePath:source});archive.ingest([article(1),article(2)]);const before=readFileSync(source);
    await assert.rejects(f.manager.request("storage.import",{paths:{news:join(f.dir,"missing.json")}}),{code:"STORAGE_IMPORT_SOURCE_MISSING"});
    const polls=join(f.dir,"polls.jsonl");writeFileSync(polls,JSON.stringify({recordedAt:new Date().toISOString(),sourceId:"fixture-poll",poll:{completedAt:new Date().toISOString(),outcome:"ok"}})+"\n");
    const imported=await f.manager.request("storage.import",{paths:{news:source,audits:{"awareness-poll":polls}}});assert.equal(imported.results[0].articles,2);assert.equal(readFileSync(source).compare(before),0);
    const db=new Database(f.db,{readonly:true});assert.equal(db.prepare("SELECT count(*) AS n FROM source_polls").get().n,1);db.close();
    assert.equal((await f.manager.request("storage.import",{paths:{news:source}})).replayed,true);
    await f.manager.request("domain.configure",{requireImport:true,instruments:listVerifiedInstruments(),rootDir:f.dir,rss:{rssFeeds:[]}});
    assert.equal((await f.call("news","getItem","source-1")).article.originalIds[0],"source-1");
    assert.deepEqual(await f.manager.request("storage.verify"),{integrity:[{integrity_check:"ok"}],foreignKeys:[]});
  }finally{await f.close();}
});

test("provider waits leave SQL reads available and persist job retries",async()=>{
  const f=await fixture();try{
    let release,entered;const bridgeEntered=new Promise(resolve=>entered=resolve);
    f.manager.rpcHandler=()=>{entered();return new Promise(resolve=>release=resolve);};
    const job=await f.call("history","create",{requestId:"bridge-test",instrumentIds:[instrumentId],targetBars:30});
    const work=f.call("history","run",{jobId:job.jobId,maxRequests:1});await bridgeEntered;
    assert.equal((await f.manager.request("storage.status")).businessStorage,"sqlite");
    release({complete:false,error:{code:"SIMULATED_SOURCE_FAILURE"}});const result=await work;assert.equal(result.status,"retry");assert.equal(result.requestsThisRun,1);
  }finally{await f.close();}
});

test("event SQL links preserve evidence impacts and filtering",async()=>{
  const f=await fixture();try{
    const input=[article(1),article(2,{title:"Other unrelated company",instrumentIds:[]})],legacy=new EventLedger({store:new ResearchStore()});
    legacy.ingest(input);await f.call("events","ingest",input);
    const expected=legacy.search({instrumentIds:[instrumentId]}),actual=await f.call("events","search",{instrumentIds:[instrumentId]});
    assert.equal(actual.total,expected.total);assert.deepEqual(actual.events.map(e=>[e.eventId,e.impacts]),expected.events.map(e=>[e.eventId,e.impacts]));
  }finally{await f.close();}
});

test("Awareness keeps a bounded HTTP projection and reconciles older revisions in SQL",async()=>{
  const f=await fixture();try{
    const input=Array.from({length:1100},(_,n)=>({eventId:`aw-${n}`,title:`Release ${n}`,status:"released",kind:"financial-news",domains:["markets"],countries:["US"],instrumentIds:[],publishedAt:new Date(Date.now()-n*60000).toISOString(),observedAt:new Date().toISOString(),source:{sourceId:"fixture-awareness",official:true,admissionState:"active"}}));
    input[1].publishedAt="1900-invalid";
    const legacy=new AwarenessStore();legacy.reconcile(input);
    for(let offset=0;offset<input.length;offset+=100)await f.call("awareness","reconcile",input.slice(offset,offset+100));
    const actual=await f.call("awareness","getSnapshot",{mode:"visible"});assert.equal(actual.quality.total,legacy.getSnapshot({mode:"visible"}).quality.total);
    const store=new AwarenessStore(),persistence=new PipelinePersistence(f.manager);
    const aiStore={records:new Map(),upsert:r=>r,recoverInterrupted(){}};
    await persistence.hydrate({awarenessStore:store,aiStore,aiBudget:{},marketHistoryStore:{},quotaTracker:{providers:{},ensureProvider(){}}});
    assert.equal(store.events.size,1000);
    const original=input.find(row=>!store.events.has(row.eventId));assert.ok(original);assert.equal((await store.reconcile([original])).deduplicated,1);
    const changed=await store.reconcile([{...original,title:"Revised historical release"}]);assert.equal(changed.changed[0].revision,2);assert.ok(store.events.size<=1000);
    await persistence.flush();const sql=new Database(f.db,{readonly:true});assert.equal(sql.prepare("SELECT revision FROM awareness_events WHERE event_id=?").get(original.eventId).revision,2);assert.equal(sql.prepare("SELECT count(*) AS n FROM awareness_events").get().n,1100);sql.close();
  }finally{await f.close();}
});

test("CSV SQL datasets remain isolated from provider candles and replay once",async()=>{
  const f=await fixture();try{
    const input={instrumentId,source:"declared",sourceUrl:"https://example.org/data",providerSymbol:"GD",currency:"USD",adjustmentMode:"splits",startAt:"2026-07-13T00:00:00.000Z",endAt:"2026-07-17T23:00:00.000Z",csv:"Date,Open,High,Low,Close,Volume\n2026-07-14,100,110,90,105,1000",requestId:"csv-sql-once",dryRun:false};
    const result=await f.call("imports","import",input);assert.equal(result.persistence.inserted,1);
    assert.equal((await f.call("imports","import",input)).replayed,true);assert.equal((await f.call("candles","query",{instrumentId})).length,0);
    const context=await f.call("technical","get",{instrumentId,datasetId:result.datasetId,interval:"1day",adjustmentMode:"splits"});assert.equal(context.instrumentId,instrumentId);
    const db=new Database(f.db,{readonly:true});assert.equal(db.prepare("SELECT source FROM market_datasets WHERE dataset_id=?").get(result.datasetId).source,"declared");db.close();
  }finally{await f.close();}
});

test("primary news pipeline forwards its RSS worker and visibility policy",async()=>{
  const f=await fixture();const server=createServer((_req,res)=>res.end(`<rss><channel><title>Source</title><item><title>General Dynamics earnings</title><link>https://example.org/primary</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    let calls=0;
    const feeds=[{url:`http://127.0.0.1:${server.address().port}/rss`,label:"Source"}],run=(extra={})=>fetchRawNews({providers:["rss"],rssFeeds:feeds,timeoutMs:500,pageSize:20,rssWorkerFetch:input=>{calls++;return f.manager.request("rss.fetch",input);},...extra});
    const result=await run({queryLane:"financial",awarenessMode:"shadow"});assert.equal(calls,1);assert.equal(result.sourceMeta.provider,"rss");assert.equal(result.sourceMeta.rssAcquisition.queriedFeedCount,1);assert.equal((await f.call("news","coverage")).totalStored,0);
    await run({queryLane:"financial",awarenessMode:"visible"});assert.equal(calls,2);assert.equal((await f.call("news","coverage")).totalStored,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();}
});

test("RSS rotation resumes after reopening and retains diagnostics for the full configured catalog",async()=>{
  const f=await fixture();const server=createServer((req,res)=>res.end(`<rss><channel><title>Fixture</title><item><title>General Dynamics ${req.url}</title><link>https://example.org${req.url}</link></item></channel></rss>`));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const feeds=Array.from({length:23},(_,i)=>({url:`http://127.0.0.1:${server.address().port}/${i}`,label:`Feed ${i}`,disabled:i===22}));
  try{
    const first=await f.manager.request("rss.fetch",{feeds,timeoutMs:500});assert.equal(first.sourceMeta.queriedFeedCount,18);assert.ok(first.sourceMeta.feedStatus.every(feed=>feed.lastSuccessAt));
    const before=await f.manager.request("runtime.load",{kind:"rss-feeds"});assert.equal(before.nextFeedOffset,18);assert.equal(Object.keys(before.feeds).length,18);
    await f.manager.close();f.manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:f.db});await f.manager.start();await f.manager.request("domain.configure",{instruments:listVerifiedInstruments(),rootDir:f.dir,rss:{rssFeeds:[]}});
    const second=await f.manager.request("rss.fetch",{feeds,timeoutMs:500});assert.equal(second.sourceMeta.feedStatus[0].url,feeds[18].url);
    const after=await f.manager.request("runtime.load",{kind:"rss-feeds"});assert.equal(Object.keys(after.feeds).length,22);assert.ok(!after.feeds[feeds[22].url]);
    const db=new Database(f.db,{readonly:true});try{assert.equal(db.prepare("SELECT count(*) AS n FROM pipeline_runs WHERE pipeline_id='rss' AND status='healthy'").get().n,2);}finally{db.close();}
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();}
});

test("stored RSS reads do not rewrite the snapshot or advance the acquisition checkpoint",async()=>{
  const f=await fixture();try{
    const saved={generatedAt:new Date().toISOString(),items:[article(1)],meta:{availability:"live"}};
    await f.manager.request("runtime.save",{kind:"rss",payload:saved});
    await f.manager.request("domain.configure",{instruments:listVerifiedInstruments(),rootDir:f.dir,rss:{rssFeeds:[]}});
    const db=new Database(f.db);try{
      db.exec("CREATE TRIGGER reject_rss_rewrite BEFORE UPDATE ON runtime_snapshots WHEN NEW.kind='rss' BEGIN SELECT RAISE(ABORT,'Stored reads must not write'); END");
      const before=db.prepare("SELECT * FROM pipeline_checkpoints WHERE pipeline_id='rss'").get();
      for(let i=0;i<3;i++)assert.equal((await f.call("rss","getSnapshot",{stored:true})).generatedAt,saved.generatedAt);
      assert.deepEqual(db.prepare("SELECT * FROM pipeline_checkpoints WHERE pipeline_id='rss'").get(),before);
    }finally{db.close();}
  }finally{await f.close();}
});

test("signal history commits only changed buckets and rolls snapshot and checkpoint back on failure",async()=>{
  const f=await fixture();try{
    const types=["news","military","market","cyber","satellite","prediction"],countries=["US","GB","ES","FR","DE","IT","PT","CA","MX","BR","AR","CL","AU","NZ","JP","KR","IN","CN","IR","IL"];
    const history=Object.fromEntries(types.map(type=>[type,Array.from({length:100},(_,i)=>({timestamp:new Date(Math.floor(Date.now()/3600000)*3600000-(i+1)*3600000).toISOString(),value:i,byCountry:Object.fromEntries(countries.map(country=>[country,i]))}))]));
    await f.manager.request("runtime.save",{kind:"signals",payload:history});
    await f.manager.request("domain.configure",{instruments:listVerifiedInstruments(),rootDir:f.dir,rss:{rssFeeds:[]}});
    const db=new Database(f.db);try{
      db.exec("CREATE TABLE bucket_writes (kind TEXT); CREATE TRIGGER audit_bucket_insert AFTER INSERT ON signal_buckets BEGIN INSERT INTO bucket_writes VALUES('insert'); END; CREATE TRIGGER audit_bucket_update AFTER UPDATE ON signal_buckets BEGIN INSERT INTO bucket_writes VALUES('update'); END; CREATE TRIGGER audit_bucket_delete AFTER DELETE ON signal_buckets BEGIN INSERT INTO bucket_writes VALUES('delete'); END");
      const at=new Date().toISOString(),snapshot=n=>({meta:{lastRefreshAt:at},signalCorpus:Array.from({length:n},(_,i)=>article(i,{publishedAt:at,countryMentions:["US"]}))});
      await f.call("signals","recordSnapshot",snapshot(1));
      assert.equal(db.prepare("SELECT count(*) AS n FROM signal_buckets").get().n,12001);
      db.exec("DELETE FROM bucket_writes");
      await f.call("signals","recordSnapshot",snapshot(2));
      assert.deepEqual(db.prepare("SELECT kind FROM bucket_writes").all(),[{kind:"update"}]);
      const before=db.prepare("SELECT * FROM runtime_snapshots WHERE kind='signals'").get(),checkpoint=db.prepare("SELECT * FROM pipeline_checkpoints WHERE pipeline_id='signals'").get();
      db.exec("CREATE TRIGGER fail_bucket_update BEFORE UPDATE ON signal_buckets BEGIN SELECT RAISE(ABORT,'Simulated SQL failure'); END");
      await assert.rejects(f.call("signals","recordSnapshot",snapshot(3)),{code:"SQLITE_CONSTRAINT_TRIGGER"});
      assert.deepEqual(db.prepare("SELECT * FROM runtime_snapshots WHERE kind='signals'").get(),before);
      assert.deepEqual(db.prepare("SELECT * FROM pipeline_checkpoints WHERE pipeline_id='signals'").get(),checkpoint);
      db.exec("DROP TRIGGER fail_bucket_update; DELETE FROM bucket_writes");
      await f.call("signals","recordSnapshot",snapshot(4));
      assert.deepEqual(db.prepare("SELECT kind FROM bucket_writes").all(),[{kind:"update"}]);
      const bucket=new Date(Math.floor(Date.parse(at)/3600000)*3600000).toISOString();
      assert.equal(db.prepare("SELECT value FROM signal_buckets WHERE signal='news' AND country='US' AND bucket=?").get(bucket).value,4);
    }finally{db.close();}
  }finally{await f.close();}
});

test("SQL HTTP mode serves history, news, map config and health without legacy stores",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"ogid-sql-http-"));const feeds=Array.from({length:66},(_,i)=>({url:`https://example.org/feed/${i}`,label:`Feed ${i}`,disabled:i===65}));const runtime=createAppServer({port:0,storage:{enabled:true,businessEnabled:true,databasePath:join(dir,"test.sqlite")},disableBackgroundRefresh:true,news:{providers:[],rssFeeds:feeds},market:{enabled:false,historyPersist:false,initialTickers:[],tickers:[],historyDir:dir}});
  try{
    await runtime.start();assert.equal(runtime.app.locals.researchStore.state,undefined);assert.equal(runtime.app.locals.newsArchive.records instanceof Map,false);
    await runtime.app.locals.newsArchive.ingest([article(1)]);
    const base=`http://127.0.0.1:${runtime.server.address().port}`;
    const pipeline=await (await fetch(base+"/api/admin/pipeline-status")).json();assert.equal(pipeline.data.news.rss.catalog.length,66);assert.equal(pipeline.data.news.rss.availableFeedCount,65);assert.equal(pipeline.data.news.rss.catalog[0].status,"not-polled");assert.equal(pipeline.data.news.rss.catalog[65].status,"disabled");
    for(const endpoint of ["/api/health","/api/admin/history","/api/research/sources","/api/map/config","/api/intel/awareness-snapshot?limit=10","/api/news/search?limit=10","/api/news/aggregate?limit=40","/api/capabilities","/api/research/scenarios","/api/research/companyfacts?companyId=fixture-company","/api/signals/delta","/api/market/conditions",`/api/market/technical-context?instrumentId=${instrumentId}`,`/api/portfolio/context?mode=weekly&instrumentIds=${instrumentId}`]){const response=await fetch(base+endpoint);const body=await response.json();assert.equal(response.status,200,`${endpoint}: ${JSON.stringify(body)}`);assert.equal(body.ok,true);}
    assert.equal(runtime.storageManager.getStatus().businessStorage,"sqlite");
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

test("RSS deadline includes a slow body and preserves independent successful feeds",async()=>{
  const f=await fixture();const server=createServer((req,res)=>{res.setHeader("Content-Type","application/rss+xml");if(req.url==="/slow"){res.write("<rss>");const timer=setTimeout(()=>res.end("</rss>"),1500);res.on("close",()=>clearTimeout(timer));}else res.end("<rss><channel><title>Fixture</title><item><title>Stored news</title><link>https://example.org/one</link></item></channel></rss>");});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{const base=`http://127.0.0.1:${server.address().port}`,start=performance.now();const result=await f.manager.request("rss.fetch",{feeds:[{url:base+"/slow"},{url:base+"/good"}],timeoutMs:80});assert.equal(result.articles.length,1);assert.ok(performance.now()-start<1200);assert.ok(result.sourceMeta.feedStatus.some(s=>s.status==="error"));}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();}
});
