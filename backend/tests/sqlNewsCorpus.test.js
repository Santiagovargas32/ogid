import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { StorageManager } from "../storage/StorageManager.js";
import { SqlNewsArchive } from "../storage/sqlNewsArchive.js";
import { SqlNewsCorpus, newsDayStart } from "../storage/sqlNewsCorpus.js";
import { migrate } from "../storage/migrate.js";
import { createAppServer } from "../server.js";
import { createBusinessAdapters } from "../storage/businessAdapters.js";
import { BusinessRuntime } from "../storage/businessRuntime.js";

const at="2026-10-09T18:00:00.000Z";
const article=(id, extra={})=>({id:`source-${id}`,title:`Russia military conflict update number ${id}`,url:`https://example.org/news/${id}`,provider:"rss",sourceName:"Fixture source",publishedAt:at,usagePolicy:"standard-link-out",...extra});

test('rediscovery through known feeds preserves the primary discovery source without producing revisions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-rediscovery-')),db=new Database(join(dir,'fixture.sqlite'));db.pragma('journal_mode=WAL');migrate(db);
 let now=Date.parse(at);const archive=new SqlNewsArchive(db,{now:()=>now});
 const item=sourceId=>article('same',{sourceId,discoverySourceId:sourceId,publisher:'Reuters',url:'https://www.reuters.com/world/fixture',provenance:{sourceId,fetchedAt:new Date(now).toISOString()}});
 try{
  archive.ingest([item('feed-a')]);const id=archive.getItem('source-same').article.id;
  archive.ingest([item('feed-b')]);const revision=archive.getRecord(id).revision,head=db.prepare('SELECT max(sequence) n FROM news_comparison_changes').get().n;
  for(let n=0;n<12;n++){now+=60000;archive.ingest([item(n%2?'feed-a':'feed-b')]);}
  const current=archive.getRecord(id);assert.equal(current.discoverySourceId,'feed-a');assert.equal(current.provenances.length,2);
  assert.equal(current.revision,revision);assert.equal(db.prepare('SELECT max(sequence) n FROM news_comparison_changes').get().n,head);
  assert.equal(current.archiveLastSeenAt,new Date(now).toISOString());
  archive.ingest([{...item('feed-a'),title:'Russia issues a corrected military conflict report'}]);
  assert.equal(archive.getRecord(id).revision,revision+1);
 }finally{archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('cold projection reads follow physical row order and retain publication-order deduplication',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-cold-projection-')),db=new Database(join(dir,'fixture.sqlite'));db.pragma('journal_mode=WAL');migrate(db);
 const archive=new SqlNewsArchive(db,{now:()=>Date.parse(at)}),corpus=new SqlNewsCorpus(archive,{payloadCacheBytes:0}),readOrder=[],prepare=Database.prototype.prepare;
 try{
  archive.ingest(Array.from({length:400},(_,n)=>article(n,{publishedAt:new Date(Date.parse(at)-(n*137%400)*1000).toISOString()})));
  archive.ingest([article('duplicate-old',{title:'Russia military duplicate report',publishedAt:new Date(Date.parse(at)-10000).toISOString()}),article('duplicate-new',{title:'Russia military duplicate report'})]);
  Database.prototype.prepare=function(sql){const statement=prepare.call(this,sql);if(sql.startsWith('SELECT rowid,payload_json FROM articles WHERE rowid IN')){const iterate=statement.iterate;statement.iterate=function*(...args){for(const row of iterate.apply(this,args)){readOrder.push(row.rowid);yield row;}};}return statement;};
  const result=await corpus.read({now:Date.parse(at)});
  assert.equal(readOrder.length,402);assert.ok(readOrder.every((id,i)=>!i||id>readOrder[i-1]),'cold payload hydration must be globally sequential');
  assert.equal(result.meta.duplicateCount,1);
  assert.ok(result.marketSignalCorpus.some(row=>row.url.endsWith('duplicate-new')));assert.ok(!result.marketSignalCorpus.some(row=>row.url.endsWith('duplicate-old')));
 }finally{Database.prototype.prepare=prepare;corpus.close();archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test("projection rereads only changed row versions across new transactions and minute windows",async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-projection-cache-')),db=new Database(join(dir,'db.sqlite'));db.pragma('journal_mode=WAL');migrate(db);
 let now=Date.parse(at),bodyReads=0;const archive=new SqlNewsArchive(db,{now:()=>now}),corpus=new SqlNewsCorpus(archive,{watchlistCountries:['RU']});
 const original=Database.prototype.prepare,plans=[];
 try{
  archive.ingest(Array.from({length:320},(_,n)=>article(n)));
  Database.prototype.prepare=function(sql){
   const stmt=original.call(this,sql);
   if(sql.startsWith('SELECT rowid,payload_json FROM articles WHERE rowid IN')){const iterate=stmt.iterate;stmt.iterate=function*(ids){for(const row of iterate.call(this,ids)){bodyReads++;yield row;}};}
   if(sql.startsWith('SELECT rowid,revision,last_seen_at')){const iterate=stmt.iterate,database=this;stmt.iterate=function(...args){plans.push(original.call(database,'EXPLAIN QUERY PLAN '+sql).all(...args));return iterate.apply(this,args);};}
   return stmt;
  };
  await corpus.read({now});assert.equal(bodyReads,320);
  bodyReads=0;now+=60000;const cached=await corpus.read({now});assert.equal(bodyReads,0);
  assert.ok(plans.length>0&&plans.every(plan=>plan.some(p=>p.detail.includes('USING COVERING INDEX articles_projection_window'))));
  archive.ingest([article(0,{title:'Russia updated military conflict report'})]);bodyReads=0;
  const changed=await corpus.read({now});assert.equal(bodyReads,1);assert.ok(changed.signalCorpus.some(a=>a.title==='Russia updated military conflict report'));
  const revision=archive.getItem('source-0').article.revision;
  now+=60000;archive.ingest([article(0,{title:'Russia updated military conflict report'})]);assert.equal(archive.getItem('source-0').article.revision,revision);
  bodyReads=0;await corpus.read({now});assert.equal(bodyReads,1);
  const uncached=new SqlNewsCorpus(archive,{watchlistCountries:['RU'],payloadCacheBytes:0}),baseline=await uncached.read({now});
  const actual=await corpus.read({now});assert.deepEqual(actual.riskResult,baseline.riskResult);assert.deepEqual(actual.news,baseline.news);assert.equal(cached.meta.scannedCount,320);
  uncached.close();
 }finally{Database.prototype.prepare=original;corpus.close();archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test("payload cache eviction remains bounded and never reduces corpus coverage or changes calculations",async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-projection-evict-')),db=new Database(join(dir,'db.sqlite'));db.pragma('journal_mode=WAL');migrate(db);
 const now=Date.parse(at),archive=new SqlNewsArchive(db,{now:()=>now}),small=new SqlNewsCorpus(archive,{payloadCacheBytes:8192}),uncached=new SqlNewsCorpus(archive,{payloadCacheBytes:0});
 try{
  archive.ingest(Array.from({length:270},(_,n)=>article(n)));await small.read({now});
  const value=await small.read({now:now+60000}),baseline=await uncached.read({now:now+60000});
  assert.equal(value.meta.scannedCount,270);assert.deepEqual(value.riskResult,baseline.riskResult);assert.deepEqual(value.news,baseline.news);
  assert.ok(small.payloadCache.status().evictions>0);assert.ok(small.payloadCache.status().bytes<=8192);
 }finally{small.close();uncached.close();archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test("SQL corpus accumulates rotations and providers; daily risk ignores display and analysis caps",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"ogid-news-corpus-")),db=new Database(join(dir,"test.sqlite"));
  db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");migrate(db);
  const archive=new SqlNewsArchive(db,{now:()=>Date.parse(at),retentionDays:365});
  const corpus=new SqlNewsCorpus(archive,{analyzeLimit:80,displayLimit:40,watchlistCountries:["RU","CN"],maxPerSource:3,maxSimilarHeadline:1,dayTimeZone:"Europe/Madrid"});
  try{
    archive.ingest(Array.from({length:60},(_,i)=>article(i)));
    archive.ingest(Array.from({length:60},(_,i)=>article(i+60,{provider:"newsapi"})));
    archive.ingest([article("cn",{title:"China military situation worsens",provider:"gnews"}),article("old",{publishedAt:"2026-10-08T20:00:00.000Z"}),article("unknown",{publishedAt:null}),article("future",{publishedAt:"2026-10-10T00:00:00.000Z"}),article("synthetic",{synthetic:true}),article("wire-copy",{title:article(0).title,url:"https://example.net/syndicated"}),article("financial",{title:"Federal Reserve issues FOMC interest rate decision"})]);
    const first=await corpus.read({now:Date.parse(at),awarenessMode:"visible"});
    assert.equal(first.riskResult.countries.RU.metrics.newsVolume,120);
    assert.equal(first.riskResult.countries.CN.metrics.newsVolume,1);
    assert.equal(first.meta.dailyCandidateCount,121);
    assert.equal(first.news.length,40);
    assert.equal(first.signalCorpus.length,80);
    assert.equal(first.meta.analysisTruncated,true);
    assert.ok(first.news.some(item=>item.countryMentions.includes("CN")));
    assert.equal(first.meta.geopoliticalCandidateCount,122);
    assert.equal(first.news.some(item=>["old","unknown","future","synthetic"].some(id=>item.url.endsWith(`/${id}`))),false);
    assert.equal(first.marketSignalCorpus.some(item=>/FOMC/.test(item.title)),true);
    const countryFeed=await corpus.getLiveFeed({countries:["CN"],sources:["gnews"],limit:40});
    assert.equal(countryFeed.news.length,1);assert.equal(countryFeed.meta.filteredDailyCandidateCount,1);
    assert.equal(countryFeed.meta.dayStart,first.meta.dayStart);
    archive.ingest([article(0),article("new",{provider:"gnews"})]);
    const second=await corpus.read({now:Date.parse(at),awarenessMode:"visible"});
    assert.equal(second.riskResult.countries.RU.metrics.newsVolume,121);
    assert.equal(second.meta.dailyCandidateCount,122);
    assert.notEqual(second.meta.revision,first.meta.revision);
    assert.equal(db.prepare("SELECT count(*) AS n FROM news_query_snapshots").get().n,0);
  }finally{archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test("current news day follows local midnight and DST",()=>{
  assert.equal(newsDayStart(Date.parse("2026-10-09T22:30:00Z"),"Europe/Madrid"),"2026-10-09T22:00:00.000Z");
  assert.equal(newsDayStart(Date.parse("2026-03-29T12:00:00Z"),"Europe/Madrid"),"2026-03-28T23:00:00.000Z");
  assert.equal(newsDayStart(Date.parse("2026-10-25T12:00:00Z"),"Europe/Madrid"),"2026-10-24T22:00:00.000Z");
});

test('archive filtering releases its consistent SQLite view before asynchronous classification',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-archive-capture-')),db=new Database(join(dir,'db.sqlite'));
 db.pragma('journal_mode=WAL');migrate(db);
 const archive=new SqlNewsArchive(db),corpus=new SqlNewsCorpus(archive);
 try{
  archive.ingest(Array.from({length:300},(_,n)=>article(n)));
  const revision=archive.revision;
  const reading=corpus.getArchiveFeed({limit:500});
  // getArchiveFeed has yielded after row 256; the detached cut is now complete.
  archive.ingest([article(0,{title:'Changed after the captured cut'})]);
  const checkpoint=db.pragma('wal_checkpoint(TRUNCATE)')[0];assert.equal(checkpoint.busy,0);
  const result=await reading;assert.equal(result.meta.revision,revision);
  assert.equal(result.news.length,300);assert.equal(result.news.some(row=>row.title==='Changed after the captured cut'),false);
 }finally{corpus.close();archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test("SQL preserves derived news features without storing restricted provider text and invalidates revised evidence",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"ogid-news-features-")),db=new Database(join(dir,"test.sqlite"));db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");migrate(db);
  const archive=new SqlNewsArchive(db,{now:()=>Date.parse(at)}),corpus=new SqlNewsCorpus(archive,{watchlistCountries:["RU"]});
  const description="Russia faces a military attack with civilian casualties.";
  try{
    archive.ingest([article("features",{title:"Official update",description,usagePolicy:"headline-only-link-out"})]);
    const stored=archive.getItem("source-features").article,first=await corpus.read({now:Date.parse(at)});
    assert.equal(stored.excerpt,null);assert.equal(JSON.stringify(stored).includes(description),false);
    assert.equal(first.news.length,1);assert.equal(first.riskResult.countries.RU.metrics.newsVolume,1);
    assert.ok(first.riskResult.countries.RU.metrics.conflictTagWeight>0);
    archive.ingest([article("features",{title:"Official update",description:"Russia signs a peace agreement.",usagePolicy:"headline-only-link-out"})]);
    const second=await corpus.read({now:Date.parse(at)});
    assert.ok(second.meta.revision>first.meta.revision);
    assert.notEqual(second.riskResult.countries.RU.metrics.conflictTagWeight,first.riskResult.countries.RU.metrics.conflictTagWeight);
  }finally{archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test("concurrent SQL windows keep independent iterators while yielding",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"ogid-news-concurrency-")),db=new Database(join(dir,"test.sqlite"));
  db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");migrate(db);
  const archive=new SqlNewsArchive(db,{now:()=>Date.parse(at)}),corpus=new SqlNewsCorpus(archive,{watchlistCountries:["RU"]});
  try{
    archive.ingest(Array.from({length:300},(_,i)=>article(i)));
    const results=await Promise.all([1,4,24,48].map(windowHours=>corpus.read({now:Date.parse(at),windowHours})));
    for(const result of results){assert.equal(result.meta.dailyCandidateCount,300);assert.equal(result.riskResult.countries.RU.metrics.newsVolume,300);}
    const oldWindow=corpus.read({now:Date.parse(at),windowHours:96});
    archive.ingest([article("new-during-read")]);
    const newWindow=corpus.read({now:Date.parse(at),windowHours:4});
    const [oldSnapshot,newSnapshot]=await Promise.all([oldWindow,newWindow]);
    assert.equal(oldSnapshot.meta.dailyCandidateCount,300);assert.equal(newSnapshot.meta.dailyCandidateCount,301);
    assert.ok(newSnapshot.meta.revision>oldSnapshot.meta.revision);
  }finally{archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test("worker domain messages omit large maps and unrelated history",async()=>{
  const requests=[],manager={options:{timeoutMs:30000},request:async(operation,input)=>{requests.push(input);return {};}};
  const adapters=createBusinessAdapters(manager,{context:()=>({newsFromStorage:true,snapshot:{}})});
  const snapshot={meta:{lastRefreshAt:at},countries:{RU:{score:30}},news:[],market:{quotes:{}},impact:{items:[]},predictions:{tickers:[]},mapAssets:{huge:"x".repeat(9*1024*1024)}};
  await adapters.news.recordContext(snapshot);
  await adapters.map.getDashboardMapAssets({snapshot});
  await adapters.signals.recordSnapshot(snapshot,{items:[]});
  assert.equal(requests.length,3);
  for(const input of requests){assert.ok(Buffer.byteLength(JSON.stringify(input))<1000);assert.equal(JSON.stringify(input).includes('"huge"'),false);}
});
test('signal recording transports complete counts instead of an oversized article corpus',async()=>{
 const maximum=8*1024*1024,requests=[];
 const manager={options:{maxCommandBytes:maximum},request:async(operation,input)=>{
  const bytes=Buffer.byteLength(JSON.stringify({operation,input}));
  if(bytes>maximum)throw Object.assign(Error('oversized'),{code:'STORAGE_COMMAND_TOO_LARGE'});
  requests.push({input,bytes});return {};
 }};
 const items=Array.from({length:600},(_,i)=>({id:`signal-${i}`,title:'Satellite launch',url:`https://example.org/signal-${i}`,publishedAt:at,countryMentions:['US'],description:'private corpus text '.repeat(1024)}));
 const adapters=createBusinessAdapters(manager);
 await adapters.signals.recordSnapshot({meta:{lastRefreshAt:at},signalCorpus:items,market:{quotes:{}}},{items});
 assert.equal(requests.length,1);assert.ok(requests[0].bytes<65536);
 assert.equal(JSON.stringify(requests[0].input).includes('private corpus text'),false);
 assert.equal(requests[0].input.args[0].values.news,600);
 assert.equal(requests[0].input.args[0].countryValues.news.US,600);
});

test("worker collects each rotating RSS batch into SQL before returning and preserves previous batches",async()=>{
  const server=createServer((req,res)=>{const feed=Number(req.url.slice(1));res.end(`<rss version="2.0"><channel>${Array.from({length:2},(_,i)=>`<item><title>Russia military conflict report ${feed}-${i}</title><link>https://example.org/${feed}/${i}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join("")}</channel></rss>`);});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const dir=mkdtempSync(join(tmpdir(),"ogid-news-collector-")),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(dir,"test.sqlite")});
  const feeds=Array.from({length:22},(_,i)=>({url:`http://127.0.0.1:${server.address().port}/${i}`,label:`Feed ${i}`}));
  try{
    await manager.start();await manager.request("domain.configure",{rootDir:dir,news:{providers:["rss"],rssFeeds:feeds,rssFeedsPerCycle:4,analyzeLimit:3000,displayLimit:40,watchlistCountries:["RU"]},rss:{rssFeeds:[]}});
    for(let i=0;i<6;i++){
      const result=await manager.request("news.collect",{providers:["rss"],countries:["RU"],timeoutMs:500,queryLane:"geopolitical"});
      assert.equal(result.sourceMeta.persistedBeforeAnalysis,true);
      assert.equal(result.articles.length,0);
    }
    const sql=new Database(manager.options.databasePath,{readonly:true});
    assert.equal(sql.prepare("SELECT count(*) AS n FROM articles").get().n,44);sql.close();
    const projection=await manager.request("domain.call",{service:"news",method:"getProjection",args:[{countries:["RU"]}]});
    assert.equal(projection.riskResult.countries.RU.metrics.newsVolume,44);
    assert.equal(projection.news.length,40);
    assert.equal(projection.meta.sourceCount,22);
  }finally{await manager.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test("supplemental RSS shares durable eligibility and never downloads a primary twice",async()=>{
  const requests=[];
  const server=createServer((req,res)=>{requests.push(req.url);res.end(`<rss version="2.0"><channel><item><title>Russia military conflict ${req.url}</title><link>https://example.org${req.url}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const dir=mkdtempSync(join(tmpdir(),"ogid-news-generated-")),db=new Database(join(dir,"test.sqlite"));db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");migrate(db);
  const base=`http://127.0.0.1:${server.address().port}`,runtime=new BusinessRuntime(db,()=>{throw new Error("Unexpected provider bridge");});
  try{
    runtime.configure({rootDir:dir,news:{providers:["rss"],rssFeeds:[{url:base+"/primary"}],rssAggregateIntervalMs:60000},rss:{rssFeeds:[],refreshIntervalMs:60000,maxFeedsPerRun:1}});
    runtime.services.rss.feedCatalog=[{url:base+"/generated-1",generated:true},{url:base+"/generated-2",generated:true}];
    await runtime.newsPipeline.collect({providers:["rss"]});
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get().n,2);
    assert.ok(runtime.load("rss-generated").nextCollectAt>Date.now());
    const states=runtime.services.rss.canonicalPipeline.states;
    assert.equal([...states.values()].filter(state=>state.lastSuccessAt).length,2);
    await runtime.newsPipeline.collect({providers:["rss"]});
    assert.equal(requests.filter(path=>path==="/primary").length,1);
    assert.equal(requests.length,2);
    assert.ok(runtime.load("news-collection").lastSuccessfulAt);
  }finally{runtime.close();db.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test("HTTP SQL mode hydrates the daily feed at startup and reads stored articles without provider requests",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"ogid-news-http-"));
  const runtime=createAppServer({port:0,watchlistCountries:["RU"],disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(dir,"test.sqlite")},news:{providers:["rss"],rssFeeds:[],analyzeLimit:3000,displayLimit:40},market:{enabled:false,provider:"",fallbackProvider:"",historyDir:dir}});
  const db=new Database(join(dir,"test.sqlite"));db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");migrate(db);
  const archive=new SqlNewsArchive(db);archive.ingest(Array.from({length:45},(_,i)=>article(i,{publishedAt:new Date().toISOString()})));archive.close();db.close();
  try{
    await runtime.start();
    const snapshot=runtime.orchestrator.stateManager.getSnapshot();assert.equal(snapshot.news.length,40);assert.equal(snapshot.countries.RU.metrics.newsVolume,45);
    const base=`http://127.0.0.1:${runtime.server.address().port}`;
    const response=await fetch(`${base}/api/news/aggregate?force=1&limit=100`);assert.equal(response.status,200);
    const data=(await response.json()).data;assert.equal(data.items.length,45);assert.equal(data.meta.stored,true);
    const feed=await (await fetch(`${base}/api/intel/news?countries=RU&limit=40`)).json();assert.equal(feed.data.news.length,40);assert.equal(feed.data.meta.newsRead.filteredDailyCandidateCount,45);
    const capped=await (await fetch(`${base}/api/intel/news?countries=RU&limit=100`)).json();assert.equal(capped.data.news.length,40);assert.equal(capped.data.meta.newsRead.limit,40);
    const defaultFeed=await (await fetch(`${base}/api/intel/news?countries=RU`)).json();assert.equal(defaultFeed.data.news.length,40);
    const smaller=await (await fetch(`${base}/api/intel/news?countries=RU&limit=12`)).json();assert.equal(smaller.data.news.length,12);
    const history=await (await fetch(`${base}/api/intel/news?countries=RU&includeOlder=1&limit=100`)).json();assert.equal(history.data.news.length,45);
    const raw=await (await fetch(`${base}/api/admin/news-raw?dataset=intel&page=1000&pageSize=10`)).json();assert.equal(raw.data.pagination.page,5);assert.equal(raw.data.items.length,5);assert.equal(raw.data.summary.sourceMode,"sqlite-candidates");
    assert.equal((await (await fetch(`${base}/api/admin/pipeline-status`)).json()).data.news.corpus.dailyCandidateCount,45);
    const advanced=await fetch(`${base}/api/intel/advanced-snapshot?countries=RU`);assert.equal(advanced.status,200);
    const conditions=await fetch(`${base}/api/market/conditions?countries=RU`);assert.equal(conditions.status,200);
    assert.equal(runtime.storageManager.getStatus().failed,0);
    const sql=new Database(join(dir,"test.sqlite"),{readonly:true});assert.equal(sql.prepare("SELECT count(*) AS n FROM pipeline_runs WHERE pipeline_id='rss'").get().n,0);sql.close();
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

for(const displayLimit of [12,100])test(`HTTP SQL live feed uses configured ${displayLimit} as default and ceiling`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),"ogid-news-cap-")),databasePath=join(dir,"test.sqlite");
  const runtime=createAppServer({port:0,host:"127.0.0.1",watchlistCountries:["RU"],disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath},news:{providers:[],rssFeeds:[],analyzeLimit:3000,displayLimit},market:{enabled:false,provider:"",fallbackProvider:"",historyDir:dir}});
  const db=new Database(databasePath);db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");migrate(db);
  const archive=new SqlNewsArchive(db);archive.ingest(Array.from({length:125},(_,i)=>article(i,{publishedAt:new Date().toISOString()})));archive.close();db.close();
  try{
    await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
    for(const suffix of ["","&limit=100","&limit=200"]){
      const response=await fetch(`${base}/api/intel/news?countries=RU${suffix}`);assert.equal(response.status,200);
      const payload=(await response.json()).data;
      assert.equal(payload.news.length,displayLimit);assert.equal(payload.meta.newsRead.displayLimit,displayLimit);assert.equal(payload.meta.newsRead.limit,displayLimit);
    }
    const smaller=(await (await fetch(`${base}/api/intel/news?countries=RU&limit=5`)).json()).data;assert.equal(smaller.news.length,5);
    const history=(await (await fetch(`${base}/api/intel/news?countries=RU&includeOlder=1&limit=125`)).json()).data;assert.equal(history.news.length,125);
    assert.equal(runtime.storageManager.getStatus().failed,0);
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

test("HTTP JSON live feed also caps supplied news by the configured display limit",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"ogid-news-json-cap-"));
  const runtime=createAppServer({port:0,host:"127.0.0.1",watchlistCountries:["RU"],disableBackgroundRefresh:true,storage:{enabled:false,businessEnabled:false},news:{providers:[],rssFeeds:[],displayLimit:12},market:{enabled:false,provider:"",fallbackProvider:"",historyDir:dir}});
  try{
    await runtime.start();runtime.orchestrator.stateManager.updateIntel({news:Array.from({length:50},(_,i)=>({...article(i,{publishedAt:new Date().toISOString()}),countryMentions:["RU"]}))});
    const base=`http://127.0.0.1:${runtime.server.address().port}`;
    for(const suffix of ["","&limit=100"]){const payload=(await (await fetch(`${base}/api/intel/news?countries=RU${suffix}`)).json()).data;assert.equal(payload.news.length,12);assert.equal(payload.meta.newsRead.displayLimit,12);}
    const smaller=(await (await fetch(`${base}/api/intel/news?countries=RU&limit=5`)).json()).data;assert.equal(smaller.news.length,5);
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

test('SQL history preserves main search, ordering and page contracts without hydrating the archive',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-history-filters-')),db=new Database(join(dir,'db.sqlite'));migrate(db);
  const archive=new SqlNewsArchive(db),corpus=new SqlNewsCorpus(archive);
  try{
    archive.ingest([article(1,{title:'Russia market update',publishedAt:'2025-01-01T12:00:00Z'}),article(2,{title:'Russia ballistic missile strike conflict airstrike troop deployment',publishedAt:'2025-01-02T12:00:00Z'}),article(3,{title:'China economics report',publishedAt:'2025-01-03T12:00:00Z'})]);
    const first=await corpus.getLiveFeed({includeOlder:true,countries:['RU'],order:'critical',limit:1});
    assert.match(first.news[0].title,/ballistic/);assert.equal(first.meta.total,2);assert.equal(first.meta.hasMore,true);
    const next=await corpus.getLiveFeed({includeOlder:true,countries:['RU'],order:'critical',limit:1,page:2});assert.match(next.news[0].title,/market/);
    const searched=await corpus.getLiveFeed({includeOlder:true,q:'China',limit:500});assert.equal(searched.news.length,1);assert.ok(searched.news[0].identity);
    const cutoff=await corpus.getLiveFeed({includeOlder:true,windowHours:1});assert.equal(cutoff.news.length,0);
  }finally{archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
