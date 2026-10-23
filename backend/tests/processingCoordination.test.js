import test from 'node:test';
import assert from 'node:assert/strict';
import { RssAggregatorService } from '../services/news/rssAggregator.js';
import { DailyCandleService } from '../services/market/dailyCandleService.js';
import { getInstrumentById } from '../services/market/instrumentRegistry.js';
import { SqlNewsPipeline } from '../storage/sqlNewsPipeline.js';
import { ScopedWork } from '../storage/scopedWork.js';
import { TechnicalContextService } from '../services/market/technicalContextService.js';
import { BusinessRuntime } from '../storage/businessRuntime.js';
import { AgentMaintenance } from '../services/agent/maintenance.js';
import Database from 'better-sqlite3';
import { migrate } from '../storage/migrate.js';
import { StorageManager } from '../storage/StorageManager.js';

for (const mode of ['canonical', 'legacy', 'shadow']) test(`${mode}: concurrent RSS triggers share acquisition and conditional eligibility`, async () => {
  let requests=0, archived=0, now=1000;
  const service=new RssAggregatorService({pipelineMode:mode,now:()=>now,maxFeedsPerRun:1,
    rssFeeds:[{feedId:'one',url:'https://fixture.invalid/rss',minPollIntervalMs:10000}],
    canonicalFetchImpl:async url=>{if(url.includes("fixture.invalid"))requests++;await new Promise(resolve=>setImmediate(resolve));return new Response('<rss><channel/></rss>',{headers:{etag:'"one"'}});},
    onCollected:async rows=>{archived+=rows.length;}});
  try {
    const [a,b]=await Promise.all([service.refresh({force:true}),service.refresh({force:true})]);
    assert.equal(requests,1); assert.deepEqual(a,b); assert.equal(archived,0);
    assert.equal(a.meta.acquisition.successfulChecks,1);
    service.cache.clear();now+=1;
    const next=await service.refresh({force:true});
    assert.equal(requests,1);assert.equal(next.meta.queriedFeeds.some(feed=>feed.url.includes("fixture.invalid")),false);
  } finally {await service.stop();}
});

test('supplemental RSS failures cannot refresh an old nonempty corpus', async () => {
  const saved=new Map(),old='2020-01-01T00:00:00.000Z';
  const snapshot={generatedAt:new Date().toISOString(),items:[{id:'old'}],meta:{totalItems:1,queriedFeedCount:1,acquisition:{attempted:1,successfulChecks:0,contentChanges:0},feedStatus:[{status:'error'}]}};
  const runtime={load:()=>({lastSuccessfulAt:old,lastSuccessfulCheckAt:old,lastContentChangeAt:old}),save:(key,value)=>saved.set(key,structuredClone(value)),services:{rss:{refresh:async()=>snapshot,lastSnapshot:snapshot}},rssGeneratedCursor:0};
  const pipeline=new SqlNewsPipeline(runtime,{}, {},{rssAggregateIntervalMs:30000});
  await pipeline.collectSupplemental();
  assert.equal(pipeline.diagnostics.lastSuccessfulAt,old);
  assert.equal(pipeline.diagnostics.lastContentChangeAt,old);
  assert.equal(pipeline.diagnostics.lastSuccessfulCheckAt,old);
});

test('a failed acquisition invalidates live projection freshness within the same cache bucket',async()=>{
  const originalNow=Date.now,now=originalNow();Date.now=()=>now;
  let diagnostics={lastAttemptAt:new Date(now-2000).toISOString(),lastSuccessfulCheckAt:new Date(now-1000).toISOString()};
  const runtime={load:()=>diagnostics,context:{snapshot:{}},progress(){},persistDerived(){}};
  const corpus={read:async()=>({news:[],marketSignalCorpus:[],riskResult:{countries:{}},meta:{revision:1,asOf:new Date(now).toISOString(),eligibleCount:1,latestGeopoliticalPublishedAt:new Date(now-1000).toISOString()}}),readAnalytical:async()=>({marketSignalCorpus:[],meta:{}})};
  const pipeline=new SqlNewsPipeline(runtime,{},corpus,{});
  try{
    assert.equal((await pipeline.getProjection()).sourceMode,'live');
    diagnostics={...diagnostics,lastAttemptAt:new Date(now).toISOString()};
    const failed=await pipeline.getProjection();assert.equal(failed.sourceMode,'stale');
    assert.equal(failed.meta.lastSuccessfulCheckAt,diagnostics.lastSuccessfulCheckAt);
  }finally{Date.now=originalNow;}
});

test('daily candles retry transient failures after backoff and confirm each persisted close', async () => {
  const instruments=['us-equity-general-dynamics','us-equity-boeing'].map(getInstrumentById);
  const completed=new Set();let calls=0,now=Date.parse('2026-07-11T12:00:00Z');const scopes=[];
  const store={has:async id=>completed.has(id),append:async rows=>{rows.forEach(row=>completed.add(row.instrumentId));return {inserted:rows.length};},latest:async()=>null};
  const service=new DailyCandleService({store,now:()=>new Date(now),marketConfig:{watchlistService:{selectedInstruments:()=>instruments},dailyCandles:{retryBaseMs:1000,retryMaxMs:10000}},
    fetchCandles:async input=>{calls++;scopes.push(input.instrumentIds);return {candles:calls===1?[{instrumentId:instruments[0].instrumentId}]:[{instrumentId:instruments[1].instrumentId}],errors:calls===1?[{code:'transport'}]:[],creditRejections:[]};}});
  await service.runScheduled();assert.equal(calls,1);
  await service.runScheduled();assert.equal(calls,1);
  now+=1000;await service.runScheduled();assert.equal(calls,2);
  assert.deepEqual(scopes[1],[instruments[1].instrumentId]);
  now+=100000;await service.runScheduled();assert.equal(calls,2);
});

test('one active calculation retains only the latest unfrozen successor across 100 triggers',async()=>{
  const work=new ScopedWork(),runs=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const first=work.run('technical:btc:1day','0',async()=>{runs.push(0);await gate;return 0;});
  const pending=[];
  for(let revision=1;revision<=100;revision++)pending.push(work.run('technical:btc:1day',String(revision),async()=>{runs.push(revision);return revision;}));
  assert.equal(work.scopes.size,1);release();assert.equal(await first,0);
  assert.deepEqual(await Promise.all(pending),Array(100).fill(100));
  assert.deepEqual(runs,[0,100]);assert.equal(work.scopes.size,0);
});

test('calculation admission bounds captured input bytes and releases them after failure and coalescing',async()=>{
  const work=new ScopedWork({maxBytes:10});let release;
  const first=work.run('scope','1',()=>new Promise(resolve=>{release=resolve;}),{bytes:6});
  await Promise.resolve();
  const second=work.run('scope','2',async()=>{throw Error('fixture');},{bytes:4});
  assert.equal(work.bytes,10);
  await assert.rejects(work.run('other','1',async()=>0,{bytes:1}),{code:'STORAGE_BACKPRESSURE'});
  await assert.rejects(work.run('scope','3',async()=>0,{bytes:5}),{code:'STORAGE_BACKPRESSURE'});
  const latest=work.run('scope','4',async()=>{throw Error('fixture');},{bytes:2});
  assert.equal(second,latest);assert.equal(work.bytes,8);
  const failed=assert.rejects(latest,/fixture/);release();await first;await failed;
  assert.equal(work.bytes,0);assert.equal(work.scopes.size,0);
});

test('identical technical inputs produce no extra analysis/outbox, while a new expected close changes quality',()=>{
  const instrumentId='crypto-bitcoin-us-dollar';let now=Date.parse('2026-07-11T12:00:00Z');
  const bar={instrumentId,interval:'1day',openTime:'2026-07-10T00:00:00.000Z',closeTime:'2026-07-11T00:00:00.000Z',open:100,high:110,low:90,close:105,volume:20,source:'yahoo',adjusted:true,currency:'USD',fetchedAt:'2026-07-11T00:05:00.000Z',revision:1};
  const service=new TechnicalContextService({store:{query:()=>[bar]},now:()=>new Date(now)});
  const db=new Database(':memory:');migrate(db);db.prepare('INSERT INTO market_datasets VALUES(?,?,?,?)').run('provider-yahoo','provider-observed','mixed','{}');const runtime=new BusinessRuntime(db);
  try{
    const first=service.get({instrumentId});assert.equal(first.quality.stale,false);
    runtime.recordAnalysis('technical.get',{instrumentId},first);
    const count=()=>({analysis:db.prepare('SELECT count(*) AS n FROM analysis_runs').get().n,outbox:db.prepare('SELECT count(*) AS n FROM outbox').get().n});
    const before=count();now+=60000;const second=service.get({instrumentId});
    assert.equal(second.semanticRevision,first.semanticRevision);assert.equal(second.asOf,first.asOf);
    assert.notEqual(second.queriedAt,first.queriedAt);runtime.recordAnalysis('technical.get',{instrumentId},second);
    assert.deepEqual(count(),before);assert.equal(service.metrics.calculations,1);
    now=Date.parse('2026-07-12T00:06:00Z');const stale=service.get({instrumentId});
    assert.equal(stale.quality.stale,true);assert.notEqual(stale.semanticRevision,first.semanticRevision);
    runtime.recordAnalysis('technical.get',{instrumentId},stale);assert.equal(count().analysis,before.analysis+1);assert.ok(count().outbox>before.outbox);
  }finally{db.close();}
});

test('maintenance skips unchanged dependencies and retries a failed domain',async()=>{
  let fail=true;const calls=new Map();
  const run=domain=>async()=>{calls.set(domain,(calls.get(domain)||0)+1);if(domain==='advanced' && fail)throw Error('transient');};
  const inputs={news:{revision:1},candles:{},research:1};
  const maintenance=new AgentMaintenance({enabled:true,dependencies:async()=>inputs,call:run('alerts'),business:{advanced:{getSnapshot:run('advanced')},conditions:{getSnapshot:run('conditions')},forecasts:{evaluate:run('evaluation')}}});
  await maintenance.tick();fail=false;await maintenance.tick();await maintenance.tick();
  assert.equal(calls.get('alerts'),1);assert.equal(calls.get('advanced'),2);assert.equal(calls.get('conditions'),1);
  inputs.news.revision++;await maintenance.tick();assert.equal(calls.get('alerts'),2);assert.equal(calls.get('advanced'),3);
});

test('lease control retains admission capacity while ordinary writer units stay in the parent queue',async()=>{
  const manager=new StorageManager({enabled:true,businessEnabled:true,isolateAnalysis:false,maxInFlight:8,queueMaxItems:16});
  manager.state='ready';const sent=[];manager.worker={postMessage:message=>sent.push(message)};
  const writes=Array.from({length:10},(_,i)=>manager.localRequest('runtime.save',{kind:`fixture-${i}`,payload:{i}}));
  assert.equal(sent.length,1);assert.equal(manager.active.size,1);
  const heartbeat=manager.localRequest('agent.call',{method:'heartbeat',args:{jobId:'fixture'}});
  const control=[...manager.active.values()].find(entry=>entry.control);
  assert.ok(control);assert.equal(control.timeoutMs,5000);assert.equal(control.queueTimeoutMs,35000);
  assert.equal(sent.length,2);
  while(manager.active.size){const entry=manager.active.values().next().value;manager.handleMessage({id:entry.id,result:{},status:{},durationMs:1});}
  await Promise.all([...writes,heartbeat]);assert.equal(manager.queue.length,0);manager.state='closed';
});

test('snapshot writer RPC waits share the analysis reader with one calculation without piling up captures or CPU work',async()=>{
  const owner=new StorageManager({enabled:true,businessEnabled:true}),reader=owner.createAnalysisManager();
  reader.state='ready';reader.worker={postMessage(){}};
  const tasks=[reader.localRequest('agent.snapshot',{jobId:'first'}),
    reader.localRequest('domain.call',{service:'technical',method:'get',args:[{instrumentId:'a'}]}),
    reader.localRequest('domain.call',{service:'technical',method:'get',args:[{instrumentId:'b'}]}),
    reader.localRequest('agent.snapshot',{jobId:'second'})];
  assert.equal(reader.active.size,1);assert.equal(reader.queue.length,3);
  const capture=reader.active.values().next().value;
  assert.equal(capture.capture,true);
  reader.handleMessage({type:'command-phase',id:capture.id,phase:'capture-completed',captureMs:1});
  assert.equal(reader.active.size,2);assert.equal(reader.queue.length,2);
  assert.equal([...reader.active.values()].filter(e=>e.cpu).length,1);
  assert.equal([...reader.active.values()].filter(e=>e.capture).length,0);
  const completed=entry=>reader.handleMessage({id:entry.id,result:{},status:{},durationMs:1});
  completed([...reader.active.values()].find(e=>e.cpu));
  assert.equal([...reader.active.values()].filter(e=>e.cpu).length,1);
  assert.equal(reader.queue.filter(e=>e.capture).length,1);
  while(reader.active.size)completed(reader.active.values().next().value);
  await Promise.all(tasks);reader.state='closed';
});

test('RSS and primary news waits leave acquisition capacity for independent sources and a reserved control slot',async()=>{
  const manager=new StorageManager({enabled:true,businessEnabled:true,isolateAnalysis:false,maxInFlight:8});
  manager.state='ready';manager.worker={postMessage(){}};
  const tasks=[manager.localRequest('news.collect',{}),manager.localRequest('domain.call',{service:'rss',method:'refresh'}),
    manager.localRequest('domain.call',{service:'sources',method:'run',args:[{sourceId:'first'}]}),
    manager.localRequest('domain.call',{service:'sources',method:'run',args:[{sourceId:'second'}]})];
  assert.equal(manager.active.size,4);assert.equal(manager.queue.length,0);
  tasks.push(manager.localRequest('domain.call',{service:'sources',method:'run',args:[{sourceId:'third'}]}));
  assert.equal(manager.queue.length,1);
  tasks.push(manager.localRequest('runtime.save',{kind:'commit',payload:{}}));
  tasks.push(manager.localRequest('agent.call',{method:'heartbeat',args:{jobId:'fixture'}}));
  assert.ok([...manager.active.values()].some(e=>e.control));
  assert.ok([...manager.active.values()].some(e=>e.workClass==='commit'));
  while(manager.active.size){const entry=manager.active.values().next().value;manager.handleMessage({id:entry.id,result:{},status:{},durationMs:1});}
  await Promise.all(tasks);manager.state='closed';
});
