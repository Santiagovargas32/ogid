import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StorageManager} from '../storage/StorageManager.js';
import {ResourceAdmission} from '../storage/resourceAdmission.js';
import {RUNTIME_POLICY} from '../config/runtimePolicy.js';
import {CandleWriteCoordinator} from '../storage/candleWriteJobs.js';
import {createAppServer} from '../server.js';

const healthy={availableBytes:4*1024**3,memoryFull:0,ioFull:0};
const candle={instrumentId:'us-equity-nvidia',interval:'1day',date:'2026-10-23',openTime:'2026-10-23T13:30:00Z',closeTime:'2026-10-23T20:00:00Z',open:100,high:110,low:90,close:105,volume:100,source:'yahoo',adjusted:true,provenance:{adjustmentMode:'splits'}};
const config={instruments:[],rootDir:tmpdir(),candlesEnabled:true,news:{rssFeeds:[],providers:[]},rss:{rssFeeds:[]}};

test('real reader projection releases its heavy reservation before writer RPC and reconciles a lost ACK',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ogid-resource-projection-'));
  const pressure=new ResourceAdmission({enabled:true,policy:{...RUNTIME_POLICY.storage.resourcePressure,recoveryMs:0}});pressure.observe(healthy);
  let manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite'),pressure});
  try{
    await manager.start();await manager.request('domain.configure',config);
    await manager.request('domain.call',{service:'candles',method:'upsert',args:[[candle],{now:'2026-10-28T00:00:00Z'}]});
    const [pending]=await manager.request('market.project.pending');assert.ok(pending);
    const persist=manager.analysisManager.rpcHandler;let writes=0;
    manager.analysisManager.rpcHandler=async(operation,input)=>{
      assert.equal(pressure.status().heavyActive,0,'writer RPC must not retain the shared reader reservation');
      const result=await persist(operation,input);writes++;
      throw Object.assign(Error('ACK lost after commit'),{code:'STORAGE_OUTCOME_UNKNOWN'});
    };
    await assert.rejects(manager.request('market.project.calculate',{key:pending.key}),{code:'STORAGE_OUTCOME_UNKNOWN'});
    assert.equal((await manager.request('market.project.status',{key:pending.key})).state,'complete');
    await manager.marketProjections.flush();assert.equal(writes,1,'confirmed projection is not replayed');
    manager.analysisManager.rpcHandler=persist;
    await manager.request('domain.call',{service:'candles',method:'upsert',args:[[{...candle,close:106}],{now:'2026-10-28T00:00:00Z'}]});
    pressure.observe({...healthy,memoryFull:15});
    await manager.marketProjections.flush();assert.equal(manager.marketProjections.status().pending,1);
    await manager.close();
    pressure.observe(healthy);
    manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite'),pressure});
    await manager.start();await manager.request('domain.configure',config);
    await manager.marketProjections.flush();
    assert.equal((await manager.request('market.project.status')).pending,0);
    assert.equal((await manager.request('market.project.status',{key:pending.key})).completedRevision,2);
  }finally{await manager.close();await pressure.close();rmSync(directory,{recursive:true,force:true});}
});

test('pressure rejects new heavy work without filling queues, failing workers, or blocking durable control',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ogid-resource-control-'));
  const pressure=new ResourceAdmission({enabled:true});pressure.observe(healthy);
  const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite'),pressure});
  try{
    await manager.start();await manager.request('domain.configure',config);
    manager.deferEventIndex();await manager.eventIndexTask;await manager.marketWrites.recovery;
    pressure.observe({...healthy,ioFull:60});
    const rows=await Promise.allSettled(Array.from({length:100},()=>manager.request('domain.call',{service:'conditions',method:'getSnapshot',args:[{}]})));
    assert.ok(rows.every(row=>row.status==='rejected'&&row.reason.code==='STORAGE_RESOURCE_PRESSURE'&&row.reason.notExecuted));
    assert.equal(manager.queue.length,0);assert.equal(manager.pendingBytes,0);assert.equal(manager.state,'ready');
    assert.equal((await manager.request('storage.status')).synchronous,2);
    await manager.request('runtime.save',{kind:'resource-control-fixture',payload:{retained:true}});
    assert.equal(manager.getStatus().failure,null);
  }finally{await manager.close();await pressure.close();rmSync(directory,{recursive:true,force:true});}
});

test('candle pressure deferral uses one recovery event instead of per-job retry timers',async()=>{
  const pressure=new ResourceAdmission({enabled:true});pressure.observe({...healthy,ioFull:60});
  const coordinator=new CandleWriteCoordinator({pressure,state:'ready',localRequest:async operation=>{
    if(operation==='market.persist.status')return {pending:true};
    pressure.assert('journal');return {pending:false,committed:true};
  }});
  try{
    await assert.rejects(coordinator.dispatch('fixture-job'),{code:'STORAGE_RESOURCE_PRESSURE'});
    assert.equal(coordinator.timers.size,0);assert.equal(coordinator.status().deferred,true);
  }finally{await coordinator.close();}
});

test('readiness exposes pressure while liveness remains available and recovers without restart',async()=>{
  const pressure=new ResourceAdmission({enabled:true,policy:{...RUNTIME_POLICY.storage.resourcePressure,recoveryMs:0}});pressure.observe(healthy);
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:false,pressure},news:{providers:[],rssFeeds:[]},market:{enabled:false,provider:'',historyPersist:false,initialTickers:[]}});
  try{
    await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
    pressure.observe({...healthy,memoryFull:15});
    assert.equal((await fetch(base+'/api/health/live')).status,200);
    const blocked=await fetch(base+'/api/health/ready');assert.equal(blocked.status,503);assert.equal(blocked.headers.get('Retry-After'),'1');
    assert.equal((await blocked.json()).data.resourcePressure.state,'degraded');
    assert.equal((await (await fetch(base+'/api/health')).json()).data.diagnostics.operational.status,'degraded');
    pressure.observe(healthy);assert.equal((await fetch(base+'/api/health/ready')).status,200);
  }finally{await runtime.stop();await pressure.close();}
});

test('the shared heavy reservation serializes reader lanes and releases before accepted persistence finishes',async()=>{
  const pressure=new ResourceAdmission({enabled:false});
  const lanes=['analysis','queries'].map(()=>new StorageManager({enabled:true,analysisWorker:true,pressure}));
  const sent=[];
  for(const lane of lanes){lane.state='ready';lane.worker={postMessage:message=>sent.push({lane,message})};}
  try{
    const first=lanes[0].localRequest('domain.call',{service:'conditions',method:'getSnapshot',args:[{}]});
    const second=lanes[1].localRequest('domain.call',{service:'conditions',method:'getSnapshot',args:[{}]});
    assert.equal(sent.length,1);
    lanes[0].handleMessage({type:'command-phase',id:sent[0].message.id,phase:'persisting'});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,2);
    for(const {lane,message} of sent)lane.handleMessage({id:message.id,result:{persisted:true},status:{},durationMs:1});
    await Promise.all([first,second]);assert.equal(pressure.status().heavyActive,0);
  }finally{for(const lane of lanes){lane.state='closed';await lane.close();}}
});
