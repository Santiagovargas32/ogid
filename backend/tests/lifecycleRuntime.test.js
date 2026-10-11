import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.js';
import { AwarenessService } from '../services/awareness/awarenessService.js';
import { AwarenessStore } from '../services/awareness/awarenessStore.js';
import { YahooRequestQueue, isRetryableYahooError } from '../services/marketData/rateLimit.js';
import RefreshOrchestratorService from '../services/refreshOrchestratorService.js';

test('repeated scheduler startup admits one periodic chain and recovers after rejection',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let rssStarts=0,news=0,market=0;
  const orchestrator=new RefreshOrchestratorService({stateManager:{},socketServer:{},
    config:{news:{intervalMs:100},market:{enabled:true}},rssAggregator:{start(){rssStarts++;}}});
  orchestrator.resolveNextNewsDelayMs=()=>100;
  orchestrator.resolveNextMarketDelayMs=()=>100;
  orchestrator.executeNewsCycle=async()=>{news++;if(news===2)throw Error('fixture-cycle-failure');};
  orchestrator.executeMarketCycle=async()=>{market++;};
  const settled=()=>new Promise(resolve=>setImmediate(resolve));
  orchestrator.start();orchestrator.start();await settled();
  assert.deepEqual([rssStarts,news,market],[1,1,1]);
  t.mock.timers.tick(100);await settled();
  t.mock.timers.tick(100);await settled();
  assert.deepEqual([rssStarts,news,market],[1,3,3]);
  await orchestrator.stop();t.mock.timers.tick(120_000);await settled();
  assert.deepEqual([rssStarts,news,market],[1,3,3]);
  assert.equal(orchestrator.pendingCycles.size,0);
});

test('runtime starts and stops idempotently; readiness differs from provider availability',async()=>{
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,news:{providers:[],rssFeeds:[]},market:{enabled:false,historyPersist:false},security:{allowLocalAdmin:false,adminApiToken:'fixture-secret'}});
  const a=runtime.start(),b=runtime.start();assert.equal(a,b);await a;
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  assert.equal((await fetch(base+'/api/health/live')).status,200);
  assert.equal((await fetch(base+'/api/health/ready')).status,200);
  assert.equal((await fetch(base+'/api/admin/runtime')).status,401);
  const metrics=await (await fetch(base+'/api/admin/runtime',{headers:{'x-admin-token':'fixture-secret'}})).json();
  assert.equal(metrics.data.runtime.ready,true);assert.ok(metrics.data.runtime.http.requests>=3);
  assert.equal(metrics.data.refresh.pending,0);
  const publicHealth=await (await fetch(base+'/api/health')).json();
  assert.deepEqual(publicHealth.data.websocket.activeConnections,[]);
  assert.equal(publicHealth.data.websocket.lastConnection,null);
  const stop=runtime.stop();assert.equal(runtime.stop(),stop);await stop;
  assert.equal(runtime.server.listening,false);
  assert.equal(runtime.server.listenerCount('upgrade'),0);
  assert.equal(runtime.app.locals.runtimeMetrics.ready,false);
});

const source={sourceId:'fixture',name:'Fixture',url:'https://fixture.test/rss',hostname:'fixture.test',adapter:'rss',kind:'macro_release',enabled:true};
test('Awareness timeout covers a body stalled after headers',async()=>{
  let cancelled=false;
  const service=new AwarenessService({mode:'visible',store:new AwarenessStore(),sources:[source],timeoutMs:10,
    fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))});
  await assert.rejects(service.request(source,source.url,{}),error=>error.name==='AbortError');
  assert.equal(cancelled,true);await service.stop();
});

test('Awareness shutdown cancels a pending body',async()=>{
  const service=new AwarenessService({mode:'visible',store:new AwarenessStore(),sources:[source],timeoutMs:10_000,
    fetchImpl:async()=>new Response(new ReadableStream())});
  const pending=service.request(source,source.url,{});
  await new Promise(resolve=>setImmediate(resolve));
  await service.stop();await assert.rejects(pending,error=>error.name==='AbortError');
});

test('Yahoo honors long Retry-After, definitive statuses and a bounded queue',async()=>{
  const queue=new YahooRequestQueue({now:()=>1000,maxRateLimitCooldownMs:900_000});
  await assert.rejects(queue.run('limited',async()=>{throw Object.assign(Error('429'),{status:429,retryAfterMs:3_600_000});}));
  assert.equal(queue.snapshot().cooldownRemainingMs,3_600_000);
  assert.equal(isRetryableYahooError(Object.assign(Error('network timeout'),{status:403})),false);
  let release;const barrier=new Promise(resolve=>{release=resolve;});
  const bounded=new YahooRequestQueue({concurrency:1,maxPending:1});
  const a=bounded.run('active',()=>barrier),b=bounded.run('pending',()=>barrier);
  await assert.rejects(bounded.run('overflow',()=>barrier),error=>error.code==='YAHOO_QUEUE_FULL');
  assert.equal(bounded.snapshot().queued,1);
  release('ok');await Promise.all([a,b]);
});

test('Yahoo circuit isolates repeated upstream failures and recovers after cooldown',async()=>{
  let now=1000,calls=0;
  const queue=new YahooRequestQueue({now:()=>now,retries:0,failureThreshold:2,recoveryMs:1000});
  for(const key of ['a','b'])await assert.rejects(queue.run(key,async()=>{calls++;throw Object.assign(Error('fixture'),{status:503});}));
  await assert.rejects(queue.run('blocked',async()=>{calls++;}),error=>error.code==='YAHOO_CIRCUIT_OPEN');
  assert.equal(calls,2);assert.equal(queue.snapshot().circuit.state,'open');
  now+=1001;assert.equal(await queue.run('recovery',async()=>{calls++;return 'ok';}),'ok');
  assert.equal(queue.snapshot().circuit.state,'closed');await queue.close();
});

test('Yahoo shutdown aborts active work and rejects pending jobs without retries',async()=>{
  const queue=new YahooRequestQueue({concurrency:1,timeoutMs:10_000});let calls=0,signal;
  const active=queue.run('active',async options=>{calls++;signal=options.signal;return new Promise(()=>{});});
  const pending=queue.run('pending',async()=>{calls++;});
  const settled=Promise.allSettled([active,pending]);
  await new Promise(resolve=>setImmediate(resolve));
  await queue.close();const results=await settled;
  assert.equal(results.every(r=>r.status==='rejected'),true);
  assert.equal(signal.aborted,true);assert.equal(calls,1);
  assert.equal(queue.snapshot().active,0);assert.equal(queue.snapshot().queued,0);
  await assert.rejects(queue.run('late',()=>1),error=>error.code==='YAHOO_QUEUE_CLOSED');
});
