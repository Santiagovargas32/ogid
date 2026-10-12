import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelineMonitor } from '../services/pipelineMonitor.js';

test('pipeline stages are single-flight and distinguish completion, degradation and blocked storage',async()=>{
 const monitor=new PipelineMonitor();let release,calls=0;const barrier=new Promise(r=>{release=r;});
 const a=monitor.run('normalize',async()=>{calls++;await barrier;return {count:4};},{counts:r=>({processed:r.count}),revision:()=>7});
 const b=monitor.run('normalize',()=>assert.fail('duplicate'));assert.equal(a,b);
 await new Promise(r=>setImmediate(r));assert.equal(monitor.snapshot().normalize.status,'running');release();await a;
 assert.equal(calls,1);assert.equal(monitor.snapshot().normalize.processed,4);assert.equal(monitor.snapshot().normalize.revision,7);assert.ok(monitor.snapshot().normalize.lastSuccessAt);
 await monitor.run('quotes',async()=>[],{counts:()=>({degraded:true,reason:'provider-unavailable'})});assert.equal(monitor.snapshot().quotes.status,'degraded');
 await assert.rejects(monitor.run('store',async()=>{throw Object.assign(Error('store'),{code:'STORAGE_NOT_READY'});}));assert.equal(monitor.snapshot().store.status,'blocked');
 await monitor.run('off',()=>assert.fail('disabled'),{enabled:false});assert.equal(monitor.snapshot().off.enabled,false);
});

test('persistence failures remain observable and do not become unhandled rejections',async()=>{
 let fail=true;const published=[];
 const monitor=new PipelineMonitor({publish:(id,stage)=>published.push({id,...stage}),persist:async()=>{if(fail)throw Object.assign(Error('disk'),{code:'SQLITE_FULL'});}});
 await monitor.run('rss',async()=>({}));await monitor.flush();assert.equal(monitor.snapshot()['rss.persistence'].status,'blocked');assert.equal(monitor.snapshot()['rss.persistence'].errorCode,'SQLITE_FULL');
 assert.ok(published.some(s=>s.id==='rss.persistence'&&s.status==='blocked'));
 fail=false;await monitor.run('rss',async()=>({}));await monitor.flush();
 assert.equal(monitor.snapshot()['rss.persistence'].status,'completed');assert.equal(monitor.snapshot()['rss.persistence'].errorCode,null);
 assert.ok(published.some(s=>s.id==='rss.persistence'&&s.status==='completed'));
});
