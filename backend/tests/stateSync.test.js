import test from 'node:test';
import assert from 'node:assert/strict';
import { StateSync } from '../websocket/stateSync.js';
import { StateSynchronizer } from '../../frontend/js/stateSync.js';
import { BoundedTransport } from '../websocket/boundedTransport.js';
import stateManager from '../state/stateManager.js';

test('analysis context keeps current quotes and omits historical market timeseries before cloning',()=>{
 const original=stateManager.state.market;
 try{
  stateManager.state.market={quotes:{GD:{price:100}},revision:'fixture',timeseries:{GD:Array(10000).fill({price:100})}};
  const context=stateManager.getAnalysisSnapshot();assert.equal(context.market.quotes.GD.price,100);assert.equal(context.market.revision,'fixture');assert.equal(context.market.timeseries,undefined);
  assert.equal(stateManager.state.market.timeseries.GD.length,10000);
 }finally{stateManager.state.market=original;}
});

for (const size of [100, 1_100_000, 11_000_000]) test(`HTTP synchronization preserves ${size} bytes with bounded frames`, async () => {
  const state={news:[{id:'original',text:'ñ🌎'.repeat(Math.ceil(size/6))}],meta:{revision:1}};
  const sync=new StateSync({getSnapshot:()=>state}, {pageChars:8000});
  const updates=[];
  const api={getSyncSnapshot:async p=>{
    if(!p.resource)return sync.manifest();
    const result=sync.page(p);assert.equal(result.status,200);
    assert.ok(Buffer.byteLength(JSON.stringify(result.data))<65536);
    return result.data;
  }};
  const client=new StateSynchronizer({api,onUpdate:u=>updates.push(u)});
  await client.requestSnapshot();
  assert.deepEqual(updates[0],state); assert.deepEqual(client.applied,sync.manifest().resources);client.close();
});

test('a delayed HTTP manifest cannot roll back revisions already delivered by WebSocket', async () => {
  const state={news:[{id:'old'}]},sync=new StateSync({getSnapshot:()=>state});
  const old=sync.manifest();let release;const pending=new Promise(resolve=>{release=resolve;});
  const updates=[];const client=new StateSynchronizer({api:{getSyncSnapshot:async p=>p.resource?sync.page(p).data:pending},onUpdate:u=>updates.push(u)});
  const bootstrap=client.requestSnapshot();state.news=[{id:'new'}];sync.change(['news']);
  client.accept({data:sync.manifest()});await client.task;release(old);await bootstrap;
  assert.equal(client.applied.news,1);assert.equal(client.target.news,1);assert.equal(updates.at(-1).news[0].id,'new');client.close();
});

test('a delayed bootstrap reply from the previous process cannot undo a new epoch', async () => {
  let sync=new StateSync({getSnapshot:()=>({news:[{id:'old'}]})});
  const old=sync.manifest();let release;const pending=new Promise(resolve=>{release=resolve;});
  const updates=[];const client=new StateSynchronizer({api:{getSyncSnapshot:async p=>p.resource?sync.page(p).data:pending},onUpdate:u=>updates.push(u)});
  client.accept({data:old});await client.task;const bootstrap=client.requestSnapshot();
  sync=new StateSync({getSnapshot:()=>({news:[{id:'new-process'}]})});client.accept({data:sync.manifest()});await client.task;
  release(old);await bootstrap;assert.equal(client.epoch,sync.epoch);assert.equal(updates.at(-1).news[0].id,'new-process');client.close();
});

test('lost/coalesced events, expired journal and restart preserve recoverable resource revisions',async()=>{
  const state={news:[],market:{quotes:{}}};const sync=new StateSync({getSnapshot:()=>state},{historyLimit:2});
  const initial=sync.manifest();
  for(let i=0;i<4;i++){state.news=[{id:String(i)}];sync.change(['news']);}
  assert.equal(sync.changes(initial.epoch,initial.revision).resyncRequired,true);
  assert.equal(sync.changes(sync.epoch,sync.revision-1).resources.news,sync.revision);
  assert.equal(sync.changes('previous-process',sync.revision).resyncRequired,true);
  assert.equal(sync.page({resource:'news',revision:0}).status,409);
  const unchanged=sync.change(['news']);assert.equal(unchanged,null);
});

test('large single message requests HTTP recovery without closing a healthy socket',()=>{
  const events=[];let recovery=0;
  const socket={readyState:1,bufferedAmount:0,once:()=>{},send:(s,cb)=>cb(),close:()=>assert.fail('must not close')};
  const transport=new BoundedTransport(socket,{observe:e=>events.push(e),onOversize:()=>recovery++});
  assert.equal(transport.enqueue('x'.repeat(1_000_001),{event:'large'}),false);
  assert.equal(recovery,1);assert.equal(events[0].outcome,'payload-too-large');clearInterval(transport.timer);
});

test('replaceable invalidations coalesce while slow queues and permanent blockage remain bounded',t=>{
  t.mock.timers.enable({apis:['setInterval','setTimeout']});
  let clock=0;t.mock.method(performance,'now',()=>clock);const closes=[];
  const socket={readyState:1,bufferedAmount:999999,once:()=>{},send:()=>assert.fail('blocked'),close:(...v)=>closes.push(v),terminate:()=>{}};
  const transport=new BoundedTransport(socket,{limits:{maxQueueItems:2,slowClientMs:100}});
  for(let i=0;i<20;i++)transport.enqueue('{}',{coalesceKey:'revision'});
  assert.equal(transport.queue.length,1);clock=150;t.mock.timers.tick(150);
  assert.deepEqual(closes,[[1013,'slow-client']]);clearInterval(transport.timer);
});

test('mutable resources cannot hide a revision or serve a cached previous payload',()=>{
  const resource={value:1};const state={meta:resource};
  const sync=new StateSync({getSyncKeys:()=>['meta'],getSyncResource:()=>resource});
  sync.change(['meta']);const first=sync.page({resource:'meta'});assert.equal(JSON.parse(first.data.fragment).value,1);
  resource.value=2;const next=sync.change(['meta']);assert.ok(next.revision>first.data.revision);
  assert.equal(JSON.parse(sync.page({resource:'meta'}).data.fragment).value,2);
});
