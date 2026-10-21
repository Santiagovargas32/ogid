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
import { SqlAwarenessStore, loadAwarenessProjection } from "../storage/sqlAwarenessStore.js";
import { migrate } from "../storage/migrate.js";
import { createAwarenessEvent } from "../services/awareness/awarenessParsers.js";
import { SqlNewsArchive } from "../storage/sqlNewsArchive.js";
import { SqlEventLedger, SqlCandleStore } from "../storage/sqlRepositories.js";
const instrumentId="us-equity-general-dynamics";
const article=(n,extra={})=>({id:`source-${n}`,title:`General Dynamics earnings ${n}`,url:`https://example.org/${n}`,publishedAt:new Date(Date.now()-86400000+n*1000).toISOString(),provider:"fixture-rss",usagePolicy:"headline-only-link-out",description:"Content must not be exposed",...extra});

test("Awareness startup reads bounded indexed candidates, prioritizes upcoming events and retains recent poll audits",()=>{
 const db=new Database(':memory:');migrate(db);const now=Date.parse('2026-10-19T12:00:00Z'),store=new SqlAwarenessStore(db);
 const insert=db.prepare('INSERT INTO awareness_events VALUES(?,?,?,?,?)');
 const source={sourceId:'boot-source',official:true};
 try{
  store.events.set('initial',{eventId:'initial',source,revision:1,observedAt:'2026-10-19T11:00:00Z',status:'released'});
  db.transaction(()=>{for(let n=0;n<12000;n++){
   const event={eventId:`old-${n}`,source,revision:1,status:'released',observedAt:new Date(now-n*60000).toISOString(),padding:'historical-body'.repeat(64)};
   insert.run(event.eventId,source.sourceId,event.observedAt,1,JSON.stringify(event));
  }})();
  for(const [id,status,scheduledAt]of [['upcoming','scheduled','2026-10-20T00:00:00Z'],['live','live','2026-10-21T00:00:00Z'],['expired','scheduled','2026-10-18T00:00:00Z'],['released-future','released','2026-10-22T00:00:00Z']]){
   const event={eventId:id,source,revision:1,status,scheduledAt,observedAt:'2020-01-01T00:00:00Z'};insert.run(id,source.sourceId,event.observedAt,1,JSON.stringify(event));
  }
  const poll=db.prepare('INSERT INTO source_polls VALUES(?,?,?,?,?)');
  poll.run('recent',source.sourceId,'2026-10-19T00:00:00Z','ok',JSON.stringify({completedAt:'2026-10-19T00:00:00Z',outcome:'ok'}));
  poll.run('wrapped',source.sourceId,'2026-10-18T00:00:00Z','ok',JSON.stringify({poll:{completedAt:'2026-10-18T00:00:00Z',outcome:'ok'}}));
  poll.run('expired',source.sourceId,'2026-10-01T00:00:00Z','ok','{}');
  const plans=[],prepare=db.prepare.bind(db);
  db.prepare=sql=>{
   const statement=prepare(sql);if(!sql.startsWith('SELECT'))return statement;
   for(const method of ['all','get']){const original=statement[method];statement[method]=function(...args){if(sql.includes('FROM awareness_events') || sql.includes('FROM source_polls'))plans.push({sql,plan:prepare('EXPLAIN QUERY PLAN '+sql).all(...args)});return original.apply(this,args);};}
   return statement;
  };
  const projection=loadAwarenessProjection(db,{now});
  assert.equal(projection.events.length,1000);assert.deepEqual(new Set(projection.events.slice(0,2).map(e=>e.eventId)),new Set(['upcoming','live']));
  assert.ok(projection.events.some(e=>e.eventId==='old-0'));assert.ok(!projection.events.some(e=>['expired','released-future'].includes(e.eventId)));
  assert.equal(projection.polls.length,2);assert.ok(projection.polls.every(p=>p.poll.outcome==='ok'));
  assert.ok(plans.some(p=>p.plan.some(r=>r.detail.includes('awareness_upcoming_schedule'))));
  assert.ok(plans.some(p=>p.plan.some(r=>r.detail.includes('awareness_by_time'))));
  assert.ok(plans.some(p=>p.plan.some(r=>r.detail.includes('source_polls_completed'))));
  assert.ok(!plans.some(p=>p.plan.some(r=>r.detail==='SCAN awareness_events')));
  assert.equal(db.prepare('SELECT count(*) AS n FROM awareness_events').get().n,12005);
 }finally{db.close();}
});

test("Awareness boot projection runs on the reader while the writer continues committing",async t=>{
 const f=await fixture();let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const reader=f.manager.queryManager,request=reader.localRequest.bind(reader);
 t.mock.method(reader,'localRequest',async(operation,input,options)=>{if(operation==='runtime.load' && input.kind==='awareness'){entered();await gate;}return request(operation,input,options);});
 try{
  const projection=f.manager.request('runtime.load',{kind:'awareness'});await started;
  await f.manager.request('runtime.save',{kind:'during-awareness-boot',payload:{committed:true}});
  assert.deepEqual(await f.manager.request('runtime.load',{kind:'during-awareness-boot'}),{committed:true});
  release();assert.deepEqual((await projection).events,[]);assert.equal(reader.getStatus().queryOnly,true);
 }finally{release();await f.close();}
});

test("SQL stale transitions preserve revisions without loading poll audits; snapshots retain complete poll history",()=>{
 const db=new Database(':memory:');migrate(db);const store=new SqlAwarenessStore(db),now=new Date().toISOString();
 const source={sourceId:'poll-isolation',name:'Fixture',url:'https://fixture.invalid/calendar',official:true,admissionState:'active',domains:['financial'],countries:['US']};
 try{
  const event=createAwarenessEvent({source,rawId:'release',title:'Fixture release',canonicalUrl:source.url,publishedAt:now,observedAt:now});
  store.reconcile([event],{sourceId:source.sourceId});
  db.prepare('INSERT INTO source_polls VALUES(?,?,?,?,?)').run('poll',source.sourceId,now,'ok',JSON.stringify({poll:{completedAt:now,outcome:'ok'}}));
  const prepare=db.prepare.bind(db);let pollReads=0;
  const read=prepare('SELECT payload_json FROM awareness_events WHERE event_id=?'),get=read.get.bind(read);let decoded=0;
  db.prepare=sql=>{if(sql==='SELECT payload_json FROM awareness_events WHERE event_id=?'){read.get=(...args)=>{decoded++;return get(...args);};return read;}return sql.includes('FROM source_polls')?(pollReads++,prepare(sql)):prepare(sql);};
  assert.equal(store.setSourceStale(source.sourceId,false).changed.length,0);assert.equal(decoded,0);
  assert.equal(store.setSourceStale(source.sourceId,true).changed[0].dataMode,'stale');
  const fresh=store.setSourceStale(source.sourceId,false);assert.equal(fresh.changed[0].revision,3);assert.equal(fresh.changed[0].dataMode,'observed');assert.equal(pollReads,0);
  store.getSnapshot({mode:'visible',publicView:false});assert.equal(pollReads,1);assert.equal(store.pollHistories.get(source.sourceId).length,1);
 }finally{db.close();}
});

test("event time windows probe membership by primary key instead of materializing instrument history",()=>{
 const db=new Database(':memory:');migrate(db);
 try{
  const insert=db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)');
  const impact=db.prepare('INSERT INTO event_instruments VALUES(?,?,?)');
  db.prepare('INSERT INTO instruments VALUES(?,?,?,?,?,?)').run(instrumentId,'GD','equity','USD','America/New_York','{}');
  for(const [id,at]of [['old','2020-01-01T00:00:00.000Z'],['recent','2026-10-19T10:00:00.000Z']]){
   insert.run(id,null,'source-publication-v2',1,at,at,'verified',JSON.stringify({eventId:id,identityVersion:'source-publication-v2'}));
   impact.run(id,instrumentId,JSON.stringify({instrumentId}));
  }
  const prepare=db.prepare.bind(db),plans=[];
  db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('SELECT count(*) AS n FROM events')){const get=statement.get;statement.get=function(...args){plans.push(prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>r.detail));return get.apply(this,args);};}return statement;};
  const ledger=new SqlEventLedger({store:{db,state:{revision:1}}});
  const result=ledger.search({instrumentIds:[instrumentId],from:'2026-10-19T00:00:00.000Z'});
  assert.equal(result.total,1);assert.equal(result.events[0].eventId,'recent');
  assert.ok(plans[0].some(p=>p.includes('SEARCH events USING COVERING INDEX events_by_time')));
  assert.ok(plans[0].some(p=>p.startsWith('SEARCH ei ') && p.includes('COVERING INDEX') && p.includes('event_id=?')),JSON.stringify(plans[0]));
  assert.ok(!plans[0].some(p=>p.includes('LIST SUBQUERY')));
  const before=plans.length,preview=ledger.search({instrumentIds:[instrumentId],from:'2026-10-19T00:00:00.000Z',includeTotal:false});
  assert.deepEqual(preview.events,result.events);assert.equal(preview.total,null);assert.equal(plans.length,before);assert.equal(preview.coverage.totalsNotRequested,true);
 }finally{db.close();}
});

test('candle windows reuse versioned bodies and invalidate corrected bars without exposing cached mutations',()=>{
 const db=new Database(':memory:');migrate(db);const store=new SqlCandleStore(db);try{
  const bar={instrumentId,interval:'1day',openTime:'2026-10-12T13:30:00.000Z',closeTime:'2026-10-12T20:00:00.000Z',fetchedAt:'2026-10-13T00:00:00.000Z',open:100,high:105,low:95,close:101,volume:100,adjusted:true,source:'fixture',provenance:{adjustmentMode:'splits'}};
  store.append([bar]);const args={instrumentId,interval:'1day',limit:240};
  const first=store.query(args);assert.equal(first[0].close,101);const misses=store.payloadCache.status().misses;first[0].close=9000;
  assert.equal(store.query(args)[0].close,101);assert.equal(store.payloadCache.status().misses,misses);
  store.upsert([{...bar,close:103,fetchedAt:'2026-10-13T01:00:00.000Z'}]);assert.equal(store.query(args)[0].close,103);assert.equal(store.payloadCache.status().misses,misses+1);
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT rowid,revision,fetched_at FROM candles INDEXED BY candles_payload_window WHERE instrument_id=? AND interval=? AND adjustment_mode=? AND dataset_id=? ORDER BY open_time DESC LIMIT ?').all(instrumentId,'1day','splits','provider-yahoo',240);
  assert.ok(plan.some(r=>r.detail.includes('COVERING INDEX candles_payload_window')));
 }finally{db.close();}
});

test("quote migration preserves distinct provenance at the same price and timestamp", async () => {
  const f = await fixture();
  try {
    const history = join(f.dir, "history"); mkdirSync(history);
    const observation = {timestamp: "2026-10-12T12:00:00Z", price: 100, source: "yahoo", provenance: {endpoint: "quote"}};
    const revised = {...observation, provenance: {endpoint: "chart"}};
    writeFileSync(join(history, "GD.jsonl"), [observation, revised, observation].map(JSON.stringify).join("\n"));
    await f.manager.request("storage.import", {paths: {candlesDir: f.dir}});
    const db = new Database(f.db, {readonly: true});
    try {
      const rows = db.prepare("SELECT payload_json FROM quote_observations").all().map(r => r.payload_json);
      assert.equal(rows.length, 2);
      assert.ok(rows.includes(JSON.stringify(observation))); assert.ok(rows.includes(JSON.stringify(revised)));
    } finally { db.close(); }
    assert.equal((await f.manager.request("storage.import", {paths: {candlesDir: f.dir}})).replayed, true);
  } finally { await f.close(); }
});

test("SQL startup runs background news ingestion without requiring a legacy RSS timer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogid-sql-startup-"));
  const feed = createServer((_req, res) => res.end(`<rss><channel><title>Fixture</title><item><title>General Dynamics earnings startup</title><link>https://example.org/startup</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`));
  await new Promise(resolve => feed.listen(0, "127.0.0.1", resolve));
  const runtime = createAppServer({
    port: 0, host: "127.0.0.1", disableBackgroundRefresh: false,
    storage: { enabled: true, businessEnabled: true, databasePath: join(dir, "test.sqlite") },
    news: { providers: ["rss"], rssFeeds: [{url: `http://127.0.0.1:${feed.address().port}/rss`, label: "Fixture"}], rssAggregateIntervalMs: 0 },
    market: { enabled: false, historyPersist: false, historyDir: dir },
    awareness: { mode: "off" }, ai: { provider: "none", mode: "off" }
  });
  try {
    await runtime.start();
    const deadline = Date.now() + 15000;
    while (!["completed", "degraded"].includes(runtime.app.locals.pipelineMonitor.snapshot().news?.status)) {
      assert.ok(Date.now() < deadline, JSON.stringify(runtime.app.locals.pipelineMonitor.snapshot()));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(runtime.app.locals.pipelineMonitor.snapshot()["news.normalize"].status, "completed");
    const db = new Database(join(dir, "test.sqlite"), {readonly: true});
    try { assert.ok(db.prepare("SELECT count(*) AS n FROM articles").get().n > 0); }
    finally { db.close(); }
    const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/health`);
    assert.equal(response.status, 200);
  } finally {
    await runtime.stop();
    await new Promise(resolve => feed.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
async function fixture(){const dir=mkdtempSync(join(tmpdir(),"ogid-sql-business-")),db=join(dir,"test.sqlite"),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:db});await manager.start();await manager.request("domain.configure",{instruments:listVerifiedInstruments(),rootDir:dir,researchSources:[],signalPolicy:{},rss:{rssFeeds:[],maxFeedsPerRun:18,maxCorpusItems:900}});return {dir,db,manager,call:(service,method,...args)=>manager.request("domain.call",{service,method,args}),async close(){await this.manager.close();rmSync(dir,{recursive:true,force:true});}};}

test("news feed and archive reads run on the read-only analysis worker without occupying the writer",async()=>{
  const f=await fixture();
  try{
    await f.call("news","ingest",[article(1,{title:"United States defense forces strike after Russia attack",publishedAt:new Date(Date.now()-1000).toISOString()})]);
    const writerBefore=f.manager.metrics.completed,analysisBefore=f.manager.queryManager.metrics.completed;
    const [feed,live,archive]=await Promise.all([
      f.call("news","getFeed",{}),f.call("news","getLiveFeed",{}),
      f.call("news","getLiveFeed",{includeOlder:true,q:"Russia"})
    ]);
    assert.equal(feed.items.length,1);assert.equal(live.news.length,1);assert.equal(archive.news.length,1);
    assert.equal(f.manager.metrics.completed,writerBefore);
    assert.equal(f.manager.queryManager.metrics.completed,analysisBefore+3);
    assert.equal(f.manager.queryManager.getStatus().queryOnly,true);
    assert.equal(f.manager.queryManager.metrics.failed,0);
    const before=f.manager.queryManager.metrics.completed;
    const copies=await Promise.all(Array.from({length:12},()=>f.call('news','getFeed',{limit:7})));
    assert.equal(f.manager.queryManager.metrics.completed,before+1);
    copies[0].items.length=0;assert.equal(copies[1].items.length,1);
    assert.equal((await f.manager.request("pipeline.record",{runId:"after-feed",pipelineId:"storage",startedAt:new Date().toISOString(),status:"healthy",counts:{}})).persisted,true);
  }finally{await f.close();}
});

test("portfolio reads can wait independently while the writer commits; research reads use the reader",async t=>{
  const f=await fixture();let release,announce;
  const barrier=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{announce=resolve;});
  const reader=f.manager.analysisManager,request=reader.localRequest.bind(reader);
  t.mock.method(reader,"localRequest",async(operation,input,options)=>{
    if(operation==="domain.call" && input.service==="portfolio"){announce();await barrier;}
    return request(operation,input,options);
  });
  try{
    let completed=false;
    const portfolio=f.call("portfolio","getContext",{mode:"daily",instrumentIds:[instrumentId]}).then(result=>{completed=true;return result;});
    await started;
    await f.call("news","ingest",[article(22)]);
    assert.equal(completed,false);assert.equal(f.manager.state,"ready");
    release();assert.equal((await portfolio).news.articles.length,1);
    const analysisBefore=reader.metrics.completed,queriesBefore=f.manager.queryManager.metrics.completed;
    await f.call("events","search",{});await f.call("forecasts","evaluate",{});
    await f.call("news","coverage",{});await f.call("news","getHistory",{});
    assert.equal(reader.metrics.completed,analysisBefore+1);assert.equal(f.manager.queryManager.metrics.completed,queriesBefore+3);
    assert.equal(reader.getStatus().queryOnly,true);
  }finally{release();await f.close();}
});

test("material portfolio preparation registers candidates through the writer and respects later acknowledgements",async()=>{
  const f=await fixture();
  try{
    await f.call("news","ingest",[article(23,{publishedAt:new Date().toISOString(),title:"General Dynamics bankruptcy warning"})]);
    const options={mode:"material",instrumentIds:[instrumentId],includeUncorroborated:true};
    const reader=f.manager.analysisManager,before=reader.metrics.completed;
    const first=await f.call("portfolio","getContext",options);
    assert.equal(reader.metrics.completed,before+1);assert.equal(first.material.candidates.length,1);
    const ids=first.material.candidates.map(row=>row.candidateId);
    const db=new Database(f.db,{readonly:true});
    try{assert.equal(db.prepare("SELECT count(*) AS n FROM alert_rows WHERE collection='observed'").get().n,1);}finally{db.close();}
    await f.call("alerts","acknowledge",{candidateIds:ids,deliveredAt:new Date().toISOString()});
    const second=await f.call("portfolio","getContext",options);
    assert.equal(second.material.candidates.length,0);assert.equal(reader.getStatus().queryOnly,true);
  }finally{await f.close();}
});

test("ten concurrent analyses use read-only SQL and commit results through the ingestion writer", async () => {
  const f = await fixture();
  try {
    await f.call("news", "ingest", [article(1)]);
    await Promise.all([
      f.call("news", "getProjection", {countries: ["US"]}),
      ...Array.from({length: 10}, (_, i) => f.call(i % 2 ? "conditions" : "advanced", "getSnapshot", {countries: ["US"]})),
      f.call("news", "ingest", Array.from({length: 100}, (_, i) => article(i + 2)))
    ]);
    await Promise.allSettled(f.manager.advancedCoordinator.tasks.values());
    assert.equal(f.manager.analysisManager.getStatus().queryOnly, true);
    assert.equal(f.manager.analysisManager.getStatus().failed, 0);
    const db = new Database(f.db, {readonly: true});
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get().n, 101);
      assert.ok(db.prepare("SELECT count(*) AS n FROM analysis_runs").get().n >= 2);
      assert.ok(db.prepare("SELECT revision FROM pipeline_checkpoints WHERE pipeline_id='news'").get());
      assert.ok(db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='news-projection'").get());
    } finally { db.close(); }
    assert.equal((await f.manager.request("storage.verify")).integrity[0].integrity_check, "ok");
  } finally { await f.close(); }
});

test("shutdown drains an accepted analysis before closing its persistence writer", async () => {
  const f=await fixture();
  try {
    const calculation=f.call("indicators","calculate",{instrumentId});
    const closing=f.manager.close();
    assert.equal((await calculation).instrumentId,instrumentId);
    await closing;
    const db=new Database(f.db,{readonly:true});
    try{assert.ok(db.prepare("SELECT count(*) AS n FROM analysis_runs").get().n>0);}
    finally{db.close();}
  }finally{await f.close();}
});

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
    const timing=f.manager.analysisManager.getStatus();
    assert.equal(timing.queryOnly,true);
    assert.ok(timing.lastExecutionMs>=0);assert.ok(timing.lastQueueMs>=0);assert.ok(timing.lastTotalMs>=0);
    if(typeof process.threadCpuUsage === "function")assert.ok(Number.isFinite(timing.lastCpuMs)&&timing.lastCpuMs>=0);
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

test("bounded immutable archive windows use date indexes before decoding, with stable pagination",async()=>{
 const f=await fixture();let archive,db;
 try{
  await f.call('news','ingest',[article(41,{updatedAt:new Date().toISOString()}),article(42,{updatedAt:new Date().toISOString()})]);
  db=new Database(f.db,{readonly:true});archive=new SqlNewsArchive(db,{analysisOnly:true});
  const prepare=archive.reader.prepare.bind(archive.reader),plans=[];
  archive.reader.prepare=sql=>{
   const statement=prepare(sql);
   if(sql.startsWith('SELECT r.rowid')){const iterate=statement.iterate;statement.iterate=function(...args){plans.push(prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>r.detail));return iterate.apply(this,args);};}
   return statement;
  };
  for(const [field,index]of [['publishedAt','article_revisions_window'],['receivedAt','article_revisions_received_window'],['updatedAt','article_revisions_updated_window'],['archiveChangedAt','article_revisions_changed_window']]){
   const first=archive.search({timeField:field,from:'2020-01-01T00:00:00.000Z',to:'2099-01-01T00:00:00.000Z',limit:1});
   assert.equal(first.total,2);assert.equal(first.hasMore,true);
   assert.ok(plans.at(-1).some(p=>/^SEARCH r USING (?:COVERING )?INDEX /.test(p) && p.includes(index)),JSON.stringify(plans.at(-1)));
   const second=archive.search({cursor:first.nextCursor,limit:1});assert.equal(second.hasMore,false);assert.notEqual(second.articles[0].id,first.articles[0].id);
  }
 }finally{archive?.close();db?.close();await f.close();}
});

test("offline import retains original IDs and is repeatable without modifying JSON files",async()=>{
  const f=await fixture();try{
    const source=join(f.dir,"news.json"),archive=new NewsArchive({persistencePath:source});archive.ingest([article(1),article(2)]);await archive.flush();const before=readFileSync(source);
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

test('financial RSS kept in shadow survives restart and archives all facts beyond the preview when visible',async()=>{
 const f=await fixture();let requests=0;
 const server=createServer((_req,res)=>{requests++;res.setHeader('etag','"held"');res.end('<rss><channel>'+Array.from({length:205},(_,i)=>`<item><title>General Dynamics report ${i}</title><link>https://example.org/held-${i}</link></item>`).join('')+'</channel></rss>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const feeds=[{url:`http://127.0.0.1:${server.address().port}/held`}];
 try{
  await f.manager.request('domain.configure',{rootDir:f.dir,rss:{rssFeeds:feeds,maxCorpusItems:1}});
  await f.manager.request('rss.fetch',{feeds,lane:'financial',awarenessMode:'shadow'});
  assert.equal((await f.call('news','coverage')).totalStored,0);
  await f.manager.close();f.manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:f.db});await f.manager.start();
  await f.manager.request('domain.configure',{rootDir:f.dir,rss:{rssFeeds:feeds,maxCorpusItems:1}});
  await f.manager.request('rss.fetch',{feeds,lane:'financial',awarenessMode:'visible'});
  assert.equal((await f.manager.request('domain.call',{service:'news',method:'coverage',args:[]})).totalStored,205);assert.equal(requests,1);
  const db=new Database(f.db,{readonly:true});try{assert.equal(db.prepare("SELECT count(*) AS n FROM runtime_snapshots WHERE kind GLOB 'rss-held:*'").get().n,0);}finally{db.close();}
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
    const second=await f.manager.request("rss.fetch",{feeds,timeoutMs:500});assert.equal(second.sourceMeta.feedStatus.length,4);
    assert.ok(second.sourceMeta.feedStatus.every(feed=>!before.feeds[feed.url]),"restart must select only previously unqueried feeds");
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
    const adminResponse=await fetch(base+"/api/admin/runtime");assert.equal(adminResponse.status,200);
    const admin=(await adminResponse.json()).data;assert.equal(admin.runtime.ready,true);assert.equal(admin.refresh.pending,0);assert.ok(Object.hasOwn(admin,"rss"));
    for(const endpoint of ["/api/health","/api/admin/history","/api/research/sources","/api/map/config","/api/intel/awareness-snapshot?limit=10","/api/news/search?limit=10","/api/news/aggregate?limit=40","/api/capabilities","/api/research/scenarios","/api/research/companyfacts?companyId=fixture-company","/api/signals/delta","/api/market/conditions",`/api/market/technical-context?instrumentId=${instrumentId}`,`/api/portfolio/context?mode=weekly&instrumentIds=${instrumentId}`]){const response=await fetch(base+endpoint);const body=await response.json();assert.equal(response.status,200,`${endpoint}: ${JSON.stringify(body)}`);assert.equal(body.ok,true);}
    assert.equal(runtime.storageManager.getStatus().businessStorage,"sqlite");
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

test("an unfinished RSS response does not retain SQLite dispatch or delay a committed write",{timeout:15000},async()=>{
  const f=await fixture();let announce,release,pending;
  const entered=new Promise(resolve=>{announce=resolve;});
  const server=createServer((_req,res)=>{res.setHeader("Content-Type","application/rss+xml");res.write("<rss><channel>");release=()=>res.end("</channel></rss>");announce();});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    let finished=false;
    pending=f.manager.request("rss.fetch",{feeds:[{url:`http://127.0.0.1:${server.address().port}/slow`}],timeoutMs:10000}).then(value=>{finished=true;return value;});
    await entered;
    const saved=await f.manager.request("runtime.save",{kind:"rss-network-isolation",payload:{committed:true}});
    assert.equal(saved.persisted,true);assert.equal(finished,false);
    assert.deepEqual(await f.manager.request("runtime.load",{kind:"rss-network-isolation"}),{committed:true});
    assert.equal(f.manager.state,"ready");release();await pending;
  }finally{release?.();await pending?.catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();}
});

test("RSS deadline includes a slow body and preserves independent successful feeds",async()=>{
  const f=await fixture();const server=createServer((req,res)=>{res.setHeader("Content-Type","application/rss+xml");if(req.url==="/slow"){res.write("<rss>");const timer=setTimeout(()=>res.end("</rss>"),1500);res.on("close",()=>clearTimeout(timer));}else res.end("<rss><channel><title>Fixture</title><item><title>Stored news</title><link>https://example.org/one</link></item></channel></rss>");});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{const base=`http://127.0.0.1:${server.address().port}`,start=performance.now();const result=await f.manager.request("rss.fetch",{feeds:[{url:base+"/slow"},{url:base+"/good"}],timeoutMs:80});assert.equal(result.articles.length,1);assert.ok(performance.now()-start<1200);assert.ok(result.sourceMeta.feedStatus.some(s=>s.status==="error"));}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();}
});
