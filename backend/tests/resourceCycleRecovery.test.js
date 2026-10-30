import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import RefreshOrchestratorService from '../services/refreshOrchestratorService.js';
import {pressureError} from '../storage/resourceAdmission.js';
import {PipelineMonitor} from '../services/pipelineMonitor.js';
const deferred=()=>pressureError({state:'degraded',reason:'io-pressure'});
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const admission=new EventEmitter();admission.state='normal';admission.status=()=>({state:admission.state});admission.assert=()=>{if(admission.state!=='normal')throw deferred();};
 const service=new RefreshOrchestratorService({admission,stateManager:{getSnapshot:()=>({}),getMeta:()=>({}),state:{market:{revision:1},meta:{sourceMeta:{corpus:{revision:1}}}}},socketServer:{broadcast(){}},config:{news:{providers:[]},market:{enabled:true}}});
 service.stopped=false;return {service,admission};
}
test('pressure inside news stops coalesced RSS and retains a recovery intent',async()=>{
 const {service,admission}=fixture();let release,calls=0;
 service.newsArchive={getFeed:async()=>{calls++;await new Promise(r=>{release=r;});admission.state='degraded';throw deferred();}};
 const first=service.runNewsCycle('fixture');await tick();const joined=service.runNewsCycle('rss-selected',{rssOnly:true});
 release();assert.equal(first,joined);await assert.rejects(first,{code:'STORAGE_RESOURCE_PRESSURE'});
 assert.equal(calls,1);assert.equal(service.resourceDeferred.has('news'),true);assert.equal(service.newsBackoffMs,0);
 assert.equal(service.getNewsCycleTelemetry().lastErrorCode,'STORAGE_RESOURCE_PRESSURE');await service.stop();
});
test('projection candidate survives pressure and recovering, then publishes on normal',async()=>{
 const {service,admission}=fixture();let calls=0,published=0;
 service.stateManager.updateIntel=()=>{published++;return {meta:{}};};
 service.config.market.analyzeInWorker=async()=>{calls++;if(calls===1){admission.state='degraded';throw deferred();}return {newsCoverage:{revision:1}};};
 const input={marketRevision:1,newsRevision:1};await service.scheduleMarketProjection(input);
 assert.equal(service.marketProjectionPending,input);admission.state='recovering';service.resumeResources();await tick();assert.equal(calls,1);
 admission.state='normal';service.resumeResources();await tick();await service.marketProjectionTask;assert.equal(published,1);assert.equal(calls,2);await service.stop();
});
test('pipeline preserves pressure as a recoverable degradation',async()=>{
 const monitor=new PipelineMonitor();await assert.rejects(monitor.run('news',async()=>{throw deferred();}),{code:'STORAGE_RESOURCE_PRESSURE'});
 const value=monitor.snapshot().news;assert.equal(value.status,'degraded');assert.equal(value.errorCode,'STORAGE_RESOURCE_PRESSURE');assert.match(value.reason,/resources/);
});

import {CycleContinuation} from '../services/shared/cycleContinuation.js';
import {createBusinessAdapters} from '../storage/businessAdapters.js';
import {compactError} from '../websocket/errorEnvelope.js';
import {AwarenessService} from '../services/awareness/awarenessService.js';
import ManualRefreshService from '../services/manualRefreshService.js';

test('continuation resumes the failed phase, never the confirmed acquisition',async()=>{
 let acquired=0,writes=0,tries=0;
 const steps=function*(){const input=yield {phase:'acquire',work:()=>++acquired};yield {phase:'persist',work:()=>{if(++tries===1)throw deferred();writes+=input;}};return 'done';};
 const continuation=new CycleContinuation(steps());await assert.rejects(continuation.run(),{code:'STORAGE_RESOURCE_PRESSURE'});
 assert.equal(await continuation.run(),'done');assert.equal(acquired,1);assert.equal(writes,1);
});
test('unknown result closes continuation and is never classified as a safe deferral',async()=>{
 let finalized=0;
 const steps=function*(){try{yield {phase:'persist',work:()=>{throw Object.assign(Error('unknown'),{code:'STORAGE_OUTCOME_UNKNOWN'});}};}finally{finalized++;}};
 const continuation=new CycleContinuation(steps());await assert.rejects(continuation.run(),{code:'STORAGE_OUTCOME_UNKNOWN'});assert.equal(finalized,1);
});
test('news batch cursor survives pressure between batches and after commit before coverage',async()=>{
 const rows=Array.from({length:205},(_,id)=>({id})),confirmed=[];let rejected=false,coverageRejected=false;
 const manager={options:{maxCommandBytes:1000000},request:async(operation,input)=>{
   if(input.method==='coverage'){if(!coverageRejected){coverageRejected=true;throw deferred();}return {totalStored:205};}
   if(input.method==='ingest'){if(confirmed.length===100&&!rejected){rejected=true;throw deferred();}confirmed.push(...input.args[0].map(x=>x.id));return {accepted:input.args[0].length};}
 }};
 const {news}=createBusinessAdapters(manager),progress={};
 await assert.rejects(news.ingest(rows,{},progress),{code:'STORAGE_RESOURCE_PRESSURE'});assert.equal(confirmed.length,100);
 await assert.rejects(news.ingest(rows,{},progress),{code:'STORAGE_RESOURCE_PRESSURE'});assert.equal(confirmed.length,205);
 const result=await news.ingest(rows,{},progress);assert.equal(result.accepted,205);assert.equal(new Set(confirmed).size,205);assert.equal(confirmed.length,205);
});
test('error projection excludes corpus and bounds Unicode by UTF-8 bytes',()=>{
 const original={message:'😀'.repeat(40000),details:'é'.repeat(10000),code:'STORAGE_RESOURCE_PRESSURE',recoverable:true};
 const value=compactError(original,{sourceMeta:{corpus:'x'.repeat(400000)},requestId:'id'});
 assert.equal(Buffer.byteLength(value.data.message),512);assert.equal(Buffer.byteLength(value.data.details),512);
 assert.equal(value.meta.sourceMeta,undefined);assert.ok(Buffer.byteLength(JSON.stringify(value))<65536);assert.equal(value.data.recoverable,true);
});
test('awareness resumes a source persistence phase without refetching or penalizing upstream',async()=>{
 let fetches=0,persists=0;
 const service=new AwarenessService({mode:'shadow',sources:[],store:{getSnapshot:()=>({sourceStatus:[],upcoming:[],recent:[],revision:1}),},stateManager:{setAwareness(){}}});
 service.pollSteps=function*(source){yield {phase:'fetch',work:()=>++fetches};yield {phase:'persist',work:()=>{if(++persists===1)throw deferred();}};return {sourceId:source.sourceId,status:'ok',changed:[]};};
 const source={sourceId:'one'};assert.equal((await service.pollSource(source)).status,'deferred');
 assert.equal(service.sourceContinuations.size,1);assert.equal((await service.pollSource(source)).status,'ok');assert.equal(fetches,1);assert.equal(persists,2);assert.equal(service.sourceContinuations.size,0);
});
test('manual admission rejects pressure before accepting work or consuming cooldown',()=>{
 let started=0;const refresh=new ManualRefreshService({orchestrator:{admission:{assert(){throw deferred();}},runManualRefresh(){started++;}}});
 assert.throws(()=>refresh.request(),{code:'STORAGE_RESOURCE_PRESSURE'});assert.equal(started,0);assert.equal(refresh.lastAcceptedAtMs,0);
});
test('shutdown closes a suspended cycle and prevents recovery successors',async()=>{
 const {service,admission}=fixture();let finalized=0,runs=0;
 service.newsSteps=function*(){try{yield {phase:'pause',work:()=>{runs++;admission.state='degraded';throw deferred();}};}finally{finalized++;}};
 await assert.rejects(service.runNewsCycle(),{code:'STORAGE_RESOURCE_PRESSURE'});await service.stop();admission.state='normal';service.resumeResources();await tick();assert.equal(runs,1);assert.equal(finalized,1);
});

import {AwarenessStore} from '../services/awareness/awarenessStore.js';
import {createAppServer} from '../server.js';
import {WebSocket} from 'ws';
import {once} from 'node:events';
test('real awareness parser and store resume after pressure without a second request',async()=>{
 const store=new AwarenessStore();let requests=0,attempts=0;
 const source={sourceId:'fixture-rss',name:'Fixture',url:'https://fixture.test/feed',hostname:'fixture.test',adapter:'rss',kind:'macro_release',domains:['financial'],minPollIntervalMs:300000,enabled:true,role:'official',official:true};
 const body='<rss><channel><item><title>Official policy release</title><link>https://fixture.test/item</link><pubDate>Fri, 30 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>';
 const service=new AwarenessService({mode:'shadow',store,sources:[source],fetchImpl:async()=>{requests++;return new Response(body,{headers:{'content-type':'application/rss+xml'}});}});
 const reconcile=store.reconcile.bind(store);store.reconcile=(...args)=>{if(++attempts===1)throw deferred();return reconcile(...args);};
 assert.equal((await service.runCycle()).status,'deferred');assert.equal(service.getAdminSnapshot().sourceStatus[0].consecutiveErrors || 0,0);
 assert.equal((await service.runCycle('resource-recovered')).status,'ok');assert.equal(requests,1);assert.equal(attempts,2);await service.stop();
});
test('actual WebSocket error frames stay compact without transport resync',async()=>{
 const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,market:{enabled:false},news:{providers:[],rssFeeds:[]},awareness:{mode:'off'},ai:{provider:'none',mode:'off'}});let client;
 try{
  await runtime.start();client=new WebSocket(`ws://127.0.0.1:${runtime.server.address().port}/ws`);await once(client,'open');
  const message=new Promise(resolve=>client.on('message',raw=>{const value=JSON.parse(raw);if(value.type==='error')resolve({value,bytes:raw.length});}));
  runtime.app.locals.socketServer.broadcast('error',{message:'Failure',details:'😀'.repeat(100000),code:'FIXTURE'},{sourceMeta:{corpus:'x'.repeat(400000)}});
  const result=await message;assert.ok(result.bytes<=65536);assert.equal(result.value.meta.sourceMeta,undefined);
  const health=runtime.app.locals.socketServer.getHealth();assert.equal(health.metrics.dropped,0);
 }finally{client?.close();await runtime.stop();}
});
test('recovery arriving before the failed task finalizes is not lost',async()=>{
 const {service,admission}=fixture();let calls=0;
 service.newsSteps=function*(){yield {phase:'pause',work:()=>{if(++calls===1)throw deferred();}};};
 await assert.rejects(service.runNewsCycle(),{code:'STORAGE_RESOURCE_PRESSURE'});await tick();
 assert.equal(calls,2);assert.equal(service.resourceDeferred.size,0);assert.equal(service.continuations.size,0);await service.stop();
});
test('pressure without notExecuted is not automatically resumed',async()=>{
 const {service}=fixture();service.newsSteps=function*(){yield {phase:'uncertain',work:()=>{throw Object.assign(deferred(),{notExecuted:false});}};};
 await assert.rejects(service.runNewsCycle(),{code:'STORAGE_RESOURCE_PRESSURE'});await tick();assert.equal(service.resourceDeferred.size,0);assert.equal(service.continuations.size,0);await service.stop();
});
test('RSS callback honors failure backoff while retaining newest selection intent',async()=>{
 const {service}=fixture();let calls=0;service.newsRetryAt=Date.now()+60000;service.executeNewsCycle=async()=>{calls++;};
 assert.deepEqual(await service.runNewsCycle('rss-selected',{rssOnly:true}),{skipped:true,reason:'backoff'});assert.equal(calls,0);assert.equal(service.rssSelectionPending,true);await service.stop();
});
test('awareness entry deferral preserves its machine-readable cause',async()=>{
 const {admission}=fixture();admission.state='degraded';const service=new AwarenessService({mode:'shadow',store:new AwarenessStore(),sources:[]});service.admission=admission;
 const result=await service.runCycle();assert.equal(result.status,'deferred');assert.equal(result.code,'STORAGE_RESOURCE_PRESSURE');await service.stop();
});
