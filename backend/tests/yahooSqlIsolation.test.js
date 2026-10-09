import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import Database from "better-sqlite3";
import {MarketDataService} from "../services/marketData/marketDataService.js";
import {MarketDataStoreAdapter} from "../services/marketData/marketDataStore.js";
import {StorageManager} from "../storage/StorageManager.js";
import {createAppServer} from "../server.js";
import {getCandles} from "../controllers/marketController.js";
import {RssAggregatorService} from "../services/news/rssAggregator.js";
import {BusinessRuntime} from "../storage/businessRuntime.js";
import {migrate} from "../storage/migrate.js";

const now=()=>new Date("2026-07-16T12:00:00Z");
const bar=close=>({date:new Date("2026-07-14T00:00:00Z"),open:100,high:120,low:90,close,volume:1000});

test("Yahoo returns observed candles while SQL is blocked and archives overlapping ranges in order",async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const stored=[];let reads=0;
  const adapter=new MarketDataStoreAdapter({now,readThrough:false,persistAsync:true,candleStore:{query:()=>{reads++;throw new Error("SQL read forbidden");},upsert:async values=>{await gate;stored.push(values);return {inserted:values.length,duplicates:0};}}});
  let close=105;
  const service=new MarketDataService({now,store:adapter,yahooClient:{chart:async()=>({quotes:[bar(close)]})}});
  try{
    const first=await service.fetchYahooCandles("NVDA",{period:"1mo",interval:"1d"});
    assert.equal(first.candles[0].close,105);
    assert.equal(first.candles[0].source,"yahoo");
    assert.equal(first.persistence.pending,true);
    assert.equal(stored.length,0);assert.equal(reads,0);
    close=107;
    const second=await service.fetchYahooCandles("NVDA",{period:"3mo",interval:"1d"});
    assert.equal(second.candles[0].close,107);
    assert.equal(adapter.getPersistenceStatus().pending,2);
    release();await adapter.flushPersistence();
    assert.deepEqual(stored.map(values=>values[0].close),[105,107]);
    assert.equal(adapter.getPersistenceStatus().completed,2);
    assert.equal(reads,0);
  }finally{release();await adapter.flushPersistence();}
});

test("SQL archive errors remain diagnostics and do not turn successful Yahoo data into provider errors",async()=>{
  const errors=[];
  const adapter=new MarketDataStoreAdapter({now,readThrough:false,persistAsync:true,onPersistenceError:error=>errors.push(error.code),candleStore:{upsert:async()=>{throw Object.assign(new Error("offline"),{code:"STORAGE_NOT_READY"});}}});
  const service=new MarketDataService({now,store:adapter,yahooClient:{chart:async()=>({quotes:[bar(105)]})}});
  const dataset=await service.fetchYahooCandles("NVDA",{period:"1mo",interval:"1d"});
  await adapter.flushPersistence();
  assert.equal(dataset.candles[0].dataMode,"observed");
  assert.equal(dataset.stale,false);
  assert.deepEqual(errors,["STORAGE_NOT_READY"]);
  assert.equal(service.getDiagnostics().persistence.failed,1);
});

test("the direct candle view refreshes its Yahoo cache after one minute",async()=>{
  let current=now().getTime(),calls=0;
  const clock=()=>new Date(current),quotes=[];
  for(let date=Date.parse("2026-06-17");date<=Date.parse("2026-07-14");date+=86400000)
    if(![0,6].includes(new Date(date).getUTCDay()))quotes.push({...bar(105),date:new Date(date)});
  const store=new MarketDataStoreAdapter({now:clock,readThrough:false,candleStore:{upsert:async()=>({inserted:0,duplicates:quotes.length})}});
  const service=new MarketDataService({now:clock,store,yahooClient:{chart:async()=>{calls++;return {quotes};}}});
  assert.equal((await service.fetchYahooCandles("NVDA",{period:"1mo",interval:"1d"})).complete,true);
  current+=30000;assert.equal((await service.fetchYahooCandles("NVDA",{period:"1mo",interval:"1d"})).cached,true);
  current+=31000;assert.equal((await service.fetchYahooCandles("NVDA",{period:"1mo",interval:"1d"})).cached,false);
  assert.equal(calls,2);
});

test("delayed archiving retains acquisition time and rejects bars that were still open",async()=>{
  let current=Date.parse("2026-07-16T18:00:00Z"),release,latest=false;
  const gate=new Promise(resolve=>release=resolve),persisted=[];
  const clock=()=>new Date(current);
  const store=new MarketDataStoreAdapter({now:clock,readThrough:false,persistAsync:true,candleStore:{upsert:async(values,options)=>{await gate;persisted.push(...values.filter(c=>Date.parse(c.closeTime)<=new Date(options.now).getTime()));return {inserted:values.length,duplicates:0};}}});
  const service=new MarketDataService({now:clock,store,yahooClient:{chart:async()=>({quotes:[{...bar(105),...(latest?{date:new Date("2026-07-16")}: {})}]})}});
  try{
    await service.fetchYahooCandles("NVDA",{period:"1mo",interval:"1d"});
    latest=true;const open=await service.fetchYahooCandles("NVDA",{period:"1mo",interval:"1d",force:true});
    assert.ok(open.candles.every(c=>c.openTime.slice(0,10)!=="2026-07-16"));
    current=Date.parse("2026-07-16T21:00:00Z");release();await store.flushPersistence();
    assert.ok(persisted.every(c=>c.openTime.slice(0,10)!=="2026-07-16"));
  }finally{release();await store.flushPersistence();}
});

test("Market Quotes reads Nvidia directly and later archives candles and technical indicators in SQL",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"ogid-yahoo-isolation-"));
  let charts=0,release;const gate=new Promise(resolve=>release=resolve);
  const recent=new Date();recent.setUTCDate(recent.getUTCDate()-1);recent.setUTCHours(0,0,0,0);
  while([0,6].includes(recent.getUTCDay()))recent.setUTCDate(recent.getUTCDate()-1);
  const runtime=createAppServer({port:0,host:"127.0.0.1",disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(directory,"test.sqlite")},news:{providers:[],rssFeeds:[]},market:{provider:"yahoo",enabled:true,dailyCandles:{enabled:true},initialTickers:[],tickers:[],historyDir:directory,historyPersist:false},yahooClient:{chart:async()=>{charts++;return {quotes:[{...bar(105),date:recent}]};}}});
  try{
    await runtime.start();
    const archive=runtime.app.locals.dailyCandleStore.upsert.bind(runtime.app.locals.dailyCandleStore);
    runtime.app.locals.dailyCandleStore.upsert=async(...args)=>{await gate;return archive(...args);};
    const base=`http://127.0.0.1:${runtime.server.address().port}`;
    const response=await fetch(`${base}/api/market/candles?instrumentId=us-equity-nvidia&interval=1day&source=yahoo&limit=240`);
    assert.equal(response.status,200);
    const body=(await response.json()).data;
    assert.equal(body.candles[0].close,105);assert.equal(body.source,"yahoo");assert.equal(body.persistence.pending,true);
    const before=new Database(join(directory,"test.sqlite"),{readonly:true});assert.equal(before.prepare("SELECT count(*) AS n FROM candles").get().n,0);before.close();
    release();await runtime.app.locals.marketDataService.store.flushPersistence();
    const after=new Database(join(directory,"test.sqlite"),{readonly:true});
    assert.equal(after.prepare("SELECT count(*) AS n FROM candles WHERE instrument_id='us-equity-nvidia'").get().n,1);
    assert.equal(after.prepare("SELECT count(*) AS n FROM analysis_runs WHERE kind='indicators.calculate'").get().n,1);
    assert.ok(after.prepare("SELECT count(*) AS n FROM indicator_values").get().n>0);after.close();
    const history=await fetch(`${base}/api/market/candles?instrumentId=us-equity-nvidia&interval=1day`);
    assert.equal(history.status,200);assert.equal((await history.json()).data.status,"stored");assert.equal(charts,1);
  }finally{release();await runtime.stop();rmSync(directory,{recursive:true,force:true});}
});

test("direct Yahoo reads do not bypass authorization of explicit historical refreshes",async()=>{
  const req={query:{instrumentId:"us-equity-nvidia",source:"yahoo",from:"2024-01-01",to:"2024-02-01"}};
  const res={app:{locals:{config:{market:{provider:"yahoo"}}}},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  await getCandles(req,res,error=>{throw error;});
  assert.equal(res.statusCode,400);assert.equal(res.body.error.code,"INVALID_CANDLE_SOURCE");
});

test("one CPU command runs at a time while ordinary storage commands remain dispatchable",async()=>{
  const manager=new StorageManager({enabled:true,businessEnabled:true});
  const sent=[];manager.state="ready";manager.worker={postMessage:message=>sent.push(message)};
  const first=manager.request("domain.call",{service:"news",method:"getProjection"});
  const second=manager.request("domain.call",{service:"advanced",method:"getSnapshot"});
  const ordinary=manager.request("storage.status");
  assert.equal(sent.length,2);assert.equal(manager.getStatus().queue.pending,1);assert.equal(manager.getStatus().queue.cpuInFlight,1);
  manager.handleMessage({id:sent[1].id,result:{ok:true},status:{}});await ordinary;
  manager.handleMessage({id:sent[0].id,result:{ok:true},status:{}});await first;
  assert.equal(sent.length,3);assert.equal(JSON.parse(sent[2].encoded).input.service,"advanced");
  manager.handleMessage({id:sent[2].id,result:{ok:true},status:{}});await second;
  assert.equal(manager.getStatus().queue.cpuInFlight,0);manager.state="closed";
});

test("time spent waiting for a CPU slot does not consume the execution deadline",async()=>{
  const manager=new StorageManager({enabled:true,businessEnabled:true,queueTimeoutMs:500});
  const sent=[];manager.state="ready";manager.worker={postMessage:message=>sent.push(message)};
  const first=manager.request("domain.call",{service:"news",method:"getProjection"},{timeoutMs:1000});
  const second=manager.request("domain.call",{service:"conditions",method:"getSnapshot"},{timeoutMs:40});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(manager.getStatus().queue.pending,1);
  manager.handleMessage({id:sent[0].id,result:{ok:true},status:{}});await first;
  manager.handleMessage({type:"command-started",id:sent[1].id,startedAt:Date.now()});
  await new Promise(resolve=>setTimeout(resolve,10));
  manager.handleMessage({id:sent[1].id,result:{ok:true},status:{}});await second;
  assert.equal(manager.state,"ready");assert.equal(manager.getStatus().failed,0);manager.state="closed";
});

test("RSS refresh waits for asynchronous archiving before publishing its snapshot",async()=>{
  let release,entered;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const server=createServer((_req,res)=>{res.setHeader("Content-Type","application/rss+xml");res.end('<rss><channel><item><title>Russia conflict</title><link>https://example.org/story</link><pubDate>Thu, 16 Jul 2026 10:00:00 GMT</pubDate></item></channel></rss>');});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const rss=new RssAggregatorService({rssFeeds:[{url:`http://127.0.0.1:${server.address().port}/rss`}],maxFeedsPerRun:1,pipelineMode:"legacy",onCollected:async()=>{entered();await gate;}});
  try{
    let completed=false;
    const refresh=rss.refresh().then(value=>{completed=true;return value;});
    await started;assert.equal(completed,false);release();
    assert.equal((await refresh).items.length,1);
  }finally{release();await new Promise(resolve=>server.close(resolve));}
});

test("deferred supplemental RSS does not delay or duplicate primary acquisition",async()=>{
  let release,entered;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const server=createServer(async(req,res)=>{
    if(req.url==="/supplemental"){entered();await gate;}
    res.end(`<rss><channel><item><title>Russia conflict ${req.url}</title><link>https://example.org${req.url}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const directory=mkdtempSync(join(tmpdir(),"ogid-rss-separate-")),db=new Database(join(directory,"test.sqlite"));
  db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");migrate(db);
  const runtime=new BusinessRuntime(db,()=>{throw new Error("Provider bridge forbidden");});
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    runtime.configure({rootDir:directory,news:{providers:["rss"],rssFeeds:[{url:base+"/primary"}],rssAggregateIntervalMs:60000},rss:{rssFeeds:[],maxFeedsPerRun:1}});
    runtime.services.rss.feedCatalog=[{url:base+"/supplemental",generated:true}];
    const primary=await runtime.newsPipeline.collect({providers:["rss"],deferSupplemental:true});
    assert.equal(primary.supplementalDue,true);assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get().n,1);
    const extra=runtime.newsPipeline.collectSupplemental();await started;
    const anotherPrimary=await runtime.newsPipeline.collect({providers:["rss"],deferSupplemental:true});
    assert.equal(anotherPrimary.supplementalDue,false);
    assert.equal(runtime.newsPipeline.supplementalDiagnostics.stage,"fetching-and-archiving");
    release();await extra;
    assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get().n,2);
    assert.ok(runtime.load("rss-generated").nextCollectAt>Date.now());
  }finally{release();runtime.close();db.close();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
