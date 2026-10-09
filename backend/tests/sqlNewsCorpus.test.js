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

test("supplemental generated RSS searches keep collecting and persist their own cursor",async()=>{
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
    assert.equal(runtime.load("rss-generated").nextOffset,1);
    await runtime.newsPipeline.collect({providers:["rss"]});
    assert.deepEqual(requests,["/primary","/generated-1","/primary"]);
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
    const raw=await (await fetch(`${base}/api/admin/news-raw?dataset=intel&page=1000&pageSize=10`)).json();assert.equal(raw.data.pagination.page,5);assert.equal(raw.data.items.length,5);assert.equal(raw.data.summary.sourceMode,"sqlite-candidates");
    assert.equal((await (await fetch(`${base}/api/admin/pipeline-status`)).json()).data.news.corpus.dailyCandidateCount,45);
    const advanced=await fetch(`${base}/api/intel/advanced-snapshot?countries=RU`);assert.equal(advanced.status,200);
    const conditions=await fetch(`${base}/api/market/conditions?countries=RU`);assert.equal(conditions.status,200);
    assert.equal(runtime.storageManager.getStatus().failed,0);
    const sql=new Database(join(dir,"test.sqlite"),{readonly:true});assert.equal(sql.prepare("SELECT count(*) AS n FROM pipeline_runs WHERE pipeline_id='rss'").get().n,0);sql.close();
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
