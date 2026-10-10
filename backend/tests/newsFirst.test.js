import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {RssCanonicalPipeline} from '../services/news/rssCanonicalPipeline.js';
import {buildCanonicalRssCatalog} from '../services/news/rssCanonicalCatalog.js';
import {RssAggregatorService} from '../services/news/rssAggregator.js';
import {deduplicateRssArticles} from '../services/news/rssDeduplicator.js';
import {articleIdentity,publicationDate} from '../services/news/articleIdentity.js';
import {normalizeArticles} from '../services/normalizeService.js';
import {AtomicJsonWriter} from '../services/shared/atomicJsonWriter.js';
import {applyNewsFilters} from '../controllers/intelController.js';
import {NewsSelectionTracker,filterNews} from '../../frontend/js/newsFeedModel.js';
import {createAppServer} from '../server.js';
const xml=(url='https://fixture.test/article')=>`<rss><channel><item><title>Israel missile strike sanctions cyber conflict</title><link>${url}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
const feed=(i,host=`host-${i%8}.test`)=>({feedId:`feed-${i}`,url:`https://${host}/${i}`,label:`Fixture ${i}`,minPollIntervalMs:3600_000});

test('hundreds of feeds rotate fairly, one host never monopolizes global slots, and concurrency stays bounded',async()=>{
 let now=Date.now(),active=0,max=0;const hosts=new Map(),seen=new Set();
 const feeds=Array.from({length:300},(_,i)=>feed(i,i<240?'search.test':`publisher-${i%12}.test`));
 const pipeline=new RssCanonicalPipeline({catalog:buildCanonicalRssCatalog({primaryFeeds:feeds}),now:()=>now,random:()=>0,globalConcurrency:4,hostConcurrency:1,maxFeedsPerCycle:18,fetchImpl:async(url)=>{const h=new URL(url).host;hosts.set(h,(hosts.get(h)||0)+1);assert.equal(hosts.get(h),1);active++;max=Math.max(max,active);seen.add(url);await delay(1);active--;hosts.set(h,hosts.get(h)-1);return new Response(xml(url));}});
 for(let i=0;i<20;i++){await pipeline.runCycle();now+=30000;}
 assert.equal(seen.size,300);assert.ok(max<=4);assert.ok(max>=2);assert.equal(pipeline.metrics.queued,0);assert.equal(pipeline.metrics.inFlight,0);
});
test('deadline cancels queue and streaming body; deferred feeds are never marked attempted',async()=>{
 const feeds=[feed(0,'down.test'),feed(1,'down.test'),feed(2,'healthy.test')];let cancelled=false;
 const pipeline=new RssCanonicalPipeline({catalog:buildCanonicalRssCatalog({primaryFeeds:feeds}),cycleDeadlineMs:120,timeoutMs:250,fetchImpl:async url=>url.includes('down.test')?new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('<rss>'));},cancel(){cancelled=true;}})):new Response(xml())});
 const started=Date.now(),result=await pipeline.runCycle();assert.ok(Date.now()-started<550);assert.equal(cancelled,true);assert.equal(pipeline.state('feed-1').lastAttemptAt,null);assert.equal(pipeline.state('feed-1').nextEligibleAt,null);assert.ok(result.items.length);assert.equal(result.meta.metrics.deferred,1);
});
test('304, valid empty feeds and Retry-After isolate publishers; ingestion callback occurs once per useful batch',async()=>{
 let now=Date.now(),round=0,callbacks=0;
 const pipeline=new RssCanonicalPipeline({catalog:buildCanonicalRssCatalog({primaryFeeds:[feed(0),feed(1),feed(2)]}),now:()=>now,random:()=>0.5,onCollected:()=>callbacks++,fetchImpl:async url=>url.endsWith('/1')?new Response('<rss><channel></channel></rss>'):url.endsWith('/2')?new Response(null,{status:429,headers:{'Retry-After':'1800'}}):round?new Response(null,{status:304}):new Response(xml(),{headers:{ETag:'v1'}})});
 await pipeline.runCycle();assert.equal(callbacks,1);assert.equal(pipeline.state('feed-1').status,'empty');assert.ok(pipeline.state('feed-2').cooldownUntil>=now+1800000);
 round++;now+=3600_001;await pipeline.runCycle();assert.equal(callbacks,1);assert.equal(pipeline.state('feed-0').status,'not-modified');assert.equal(pipeline.metrics.newArticles,0);
});
test('responses and parsed items are bounded, queued shutdown releases all slots, and corruption is preserved',async()=>{
 const catalog=buildCanonicalRssCatalog({primaryFeeds:[feed(0)]});
 const pipeline=new RssCanonicalPipeline({catalog,maxResponseBytes:80,fetchImpl:async()=>new Response('x'.repeat(100))});await pipeline.runCycle();assert.equal(pipeline.state('feed-0').status,'error');
 const body=`<rss><channel>${Array.from({length:30},(_,i)=>`<item><title>Item ${i}</title><link>https://fixture.test/${i}</link></item>`).join('')}</channel></rss>`;
 const bounded=new RssCanonicalPipeline({catalog,maxItemsPerFeed:3,fetchImpl:async()=>new Response(body)});assert.equal((await bounded.runCycle()).items.length,3);
 const file=join(mkdtempSync(join(tmpdir(),'ogid-rss-corrupt-')),'state.json');writeFileSync(file,'broken');assert.throws(()=>new RssCanonicalPipeline({catalog,persistencePath:file}));assert.equal(readFileSync(file,'utf8'),'broken');
 const slow=new RssCanonicalPipeline({catalog,fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)))});const pending=slow.runCycle();await delay(5);await slow.stop();await pending;assert.equal(slow.metrics.inFlight,0);assert.equal(slow.hostSemaphore('host-0.test').active,0);
});
test('aggregator archives once and stored HTTP clients cannot increase acquisition; cold start is explicit',async()=>{
 const nativeFetch=globalThis.fetch;let upstream=0,ingests=0;
 globalThis.fetch=async(url,options)=>String(url).includes('127.0.0.1')?nativeFetch(url,options):(upstream++,new Response(xml()));
 const runtime=createAppServer({port:0,disableBackgroundRefresh:true,market:{enabled:false,historyPersist:false},news:{providers:['rss'],rssFeeds:[feed(0)],rssAggregateFeedsPerRun:1,rssAggregateMaxItems:50}});
 await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
 try {
  const cold=await (await nativeFetch(base+'/api/news/aggregate?stored=1')).json();assert.equal(cold.data.meta.availability,'not-collected');assert.equal(upstream,0);
  const service=runtime.app.locals.rssAggregator;service.onCollected=()=>ingests++;
  await runtime.orchestrator.runCycle('fixture');assert.equal(ingests,1);const count=upstream;
  for(const clients of [1,10])await Promise.all(Array.from({length:clients},()=>Promise.all(['/api/health','/api/intel/snapshot?countries=ALL','/api/news/aggregate?stored=1','/api/admin/news-raw?stored=1&dataset=rss-aggregate','/api/intel/advanced-snapshot'].map(async path=>{const response=await nativeFetch(base+path);assert.equal(response.status,200);await response.text();}))));
  assert.equal(upstream,count);assert.equal(upstream,1);
 }finally{await runtime.stop();globalThis.fetch=nativeFetch;}
});
test('ordered coalesced persistence flushes newest revision and reports failures for retry',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'ogid-json-')),'state.json');let value=1;const writer=new AtomicJsonWriter(file,()=>({value}));writer.mark();const first=writer.flush();value=2;writer.mark();await first;await writer.flush();assert.equal(JSON.parse(readFileSync(file)).value,2);assert.ok(writer.metrics.writes<=2);
 const blocked=join(mkdtempSync(join(tmpdir(),'ogid-json-error-')),'parent');writeFileSync(blocked,'file');const failing=new AtomicJsonWriter(join(blocked,'state.json'),()=>({value:3}));failing.mark();await assert.rejects(failing.flush());assert.ok(failing.lastError);assert.equal(failing.written,0);failing.path=file;await failing.flush();assert.equal(JSON.parse(readFileSync(file)).value,3);
});
test('identity ignores position, tracking URL and polling; source dates are not invented and severity precedes limit',()=>{
 const raw={title:'Headline',url:'https://fixture.test/story?utm_source=a',publishedAt:'2026-10-09T12:00:00Z'};
 assert.equal(articleIdentity(raw),articleIdentity({...raw,title:'Edited',url:'https://fixture.test/story#fragment',receivedAt:'2026-10-10T12:00:00Z'}));
 assert.equal(normalizeArticles([raw])[0].id,normalizeArticles([{title:'Other'},raw])[0].id);
 const restored=deduplicateRssArticles([{...raw,id:'old-feed-index-id'}]).items[0];assert.equal(restored.id,articleIdentity(raw));assert.ok(restored.aliases.includes('old-feed-index-id'));
 for(const value of [null,'invalid','2999-01-01T00:00:00Z'])assert.equal(publicationDate(value).publishedAt,null);
 const items=Array.from({length:80},(_,i)=>({id:String(i),title:`Story ${i}`,threatLevel:i===79?'critical':'low',publishedAt:new Date(Date.now()-i*1000).toISOString()}));
 assert.equal(applyNewsFilters(items,{limit:40,order:'critical'})[0].id,'79');assert.equal(filterNews(items).items[0].id,'79');
 assert.equal(applyNewsFilters(items,{limit:1,order:'recent'})[0].id,'0');
});
test('baseline, repeated revisions, reorders, market/AI and filters do not create news; reconnect and edits behave distinctly',()=>{
 const tracker=new NewsSelectionTracker();const a={id:'a',title:'A'},b={id:'b',title:'B'};
 assert.deepEqual(tracker.observe([a],'one').newIds,[]);
 assert.deepEqual(tracker.observe([a],'one').newIds,[]);
 assert.deepEqual(tracker.observe([{...a,title:'Edited'}],'two').newIds,[]);
 assert.deepEqual(tracker.observe([{...a,title:'Edited'}],'two').updatedIds,[]);
 assert.deepEqual(tracker.observe([a,b],'three').newIds,['b']);
 const restored=new NewsSelectionTracker({baseline:tracker.baseline()});assert.deepEqual(restored.observe([a,b,{id:'c'}],'four').newIds,['c']);
 assert.equal(filterNews([{id:'old',threatLevel:'critical',publishedAt:'2020-01-01'}]).items.length,0);
});

test('shutdown waits for admitted selection work before the final archive flush',async()=>{
 const runtime=createAppServer({port:0,disableBackgroundRefresh:true,market:{enabled:false,historyPersist:false},news:{providers:[],rssFeeds:[]}});
 await runtime.start();const order=[];
 runtime.orchestrator.executeNewsCycle=async()=>{await delay(20);order.push('ingest');};
 runtime.app.locals.newsArchive.flush=async()=>{order.push('flush');};
 const task=runtime.orchestrator.runNewsCycle('fixture');await runtime.stop();await task;
 assert.deepEqual(order,['ingest','flush']);assert.equal(runtime.orchestrator.pendingCycles.size,0);
});
test('slow WebSocket transport is closed for resync while a healthy client receives its envelope',async()=>{
 const {sendBoundedEnvelope}=await import('../websocket/socketServer.js');const calls=[];
 const slow={readyState:1,bufferedAmount:1000001,close:(...args)=>calls.push(args),terminate:()=>calls.push('terminate'),send:()=>assert.fail('buffer must stay bounded')};
 const fast={readyState:1,bufferedAmount:0,send:value=>calls.push(value)};
 sendBoundedEnvelope(slow,'fixture');sendBoundedEnvelope(fast,'fixture');
 assert.deepEqual(calls,[[1013,'resync-required'],'terminate','fixture']);
});

test('expired remembered selection resyncs without signalling the entire feed as new',()=>{
 const tracker=new NewsSelectionTracker({now:()=>1000000000,retentionMs:100,baseline:[['expired',0]]});
 assert.deepEqual(tracker.observe([{id:'current'}],'new-revision').newIds,[]);
});
