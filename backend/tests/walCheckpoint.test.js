import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {setTimeout as wait} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {WalCheckpoint} from '../storage/walCheckpoint.js';
import {StorageManager} from '../storage/StorageManager.js';
import {storageConfig} from '../storage/config.js';
import {migrate} from '../storage/migrate.js';
import {acquireWriter} from '../storage/writerOwnership.js';
import {walWriteGuard,storageExecutionContext} from '../storage/walPressure.js';
import {cacheStatements} from '../storage/statementCache.js';
import {SqlActivity,createSqlActivityBuffer,trackTransactions} from '../storage/sqlActivity.js';
import {SqlCandleStore} from '../storage/sqlRepositories.js';
import {CANDLE_VALIDATION_VERSION} from '../services/market/candleValidation.js';
import {nativeThreadId,readNativeWait} from '../storage/nativeWait.js';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'ogid-wal-checkpoint-')),databasePath=join(directory,'fixture.sqlite'),writerToken=randomUUID(),db=new Database(databasePath);
  db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('wal_autocheckpoint=0');migrate(db);acquireWriter(db,writerToken);
  return {directory,databasePath,writerToken,db,options:{...storageConfig({enabled:true,databasePath}),writerToken},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const record=()=>{const at=new Date().toISOString();return {runId:randomUUID(),pipelineId:'storage',startedAt:at,completedAt:at,status:'healthy',counts:{processed:1}};};

test('native wait diagnostics read only the known local thread, bound output and express unavailable stacks',()=>{
  for(const value of [null,0,-1,'../../1',NaN])assert.equal(readNativeWait(value),null);
  const id=nativeThreadId();if(id===null)return;
  const wait=readNativeWait(id);assert.equal(wait.threadId,id);
  for(const sample of [wait.waitChannel,wait.stack,wait.ioPressure]){
    assert.equal(typeof sample.available,'boolean');
    if(sample.available){assert.ok(Buffer.byteLength(sample.value)<=2048);assert.doesNotMatch(sample.value,/\[<[a-f0-9]+>\]/);}
    else assert.equal(typeof sample.code,'string');
  }
});

test('PASSIVE checkpoints have a FULL query-only connection, retain reader debt and verify the current owner',async()=>{
  const f=fixture(),checkpoint=new WalCheckpoint({...f.options,checkpointHardBytes:1});let reader;
  try{
    await checkpoint.start();assert.deepEqual(checkpoint.status().connection,{queryOnly:true,synchronous:2});
    await checkpoint.request();
    reader=new Database(f.databasePath,{readonly:true});reader.pragma('query_only=ON');reader.exec('BEGIN');reader.prepare('SELECT * FROM runtime_meta').all();
    f.db.prepare('INSERT INTO runtime_meta VALUES(?,?)').run('retained-fixture',JSON.stringify('x'.repeat(65536)));
    checkpoint.walBytes=statSync(`${f.databasePath}-wal`).size;
    const partial=await checkpoint.request();assert.ok(partial[0].log>partial[0].checkpointed);assert.equal(checkpoint.status().backpressure,true);
    reader.exec('ROLLBACK');reader.close();reader=null;
    const complete=await checkpoint.request();assert.equal(complete[0].log,complete[0].checkpointed);assert.equal(checkpoint.status().backpressure,false);
    // PASSIVE leaves a large file allocated; its already copied pages must not
    // cause intermittent 503s on subsequent healthy checkpoints.
    assert.ok(checkpoint.walBytes>checkpoint.options.checkpointHardBytes);
    const retained=checkpoint.request();assert.equal(checkpoint.status().backpressure,false);await retained;
    f.db.prepare('UPDATE storage_writer_owner SET token=?').run('replacement-owner');
    await assert.rejects(checkpoint.request(),{code:'STORAGE_CHECKPOINT_OWNER_CHANGED'});
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM runtime_meta WHERE key=?').get('retained-fixture').n,1);
  }finally{reader?.close();await checkpoint.close();await checkpoint.close();f.close();}
});

test('WAL pressure rejects mutations before side effects, finishes admitted transactions and preserves control',()=>{
  const f=fixture(),buffer=new SharedArrayBuffer(4),pressure=new Int32Array(buffer),guard=walWriteGuard(f.db,buffer);
  try{
    cacheStatements(f.db,256,{beforeWrite:guard});trackTransactions(f.db,new SqlActivity(createSqlActivityBuffer()),{beforeBegin:guard});
    const put=f.db.prepare('INSERT INTO runtime_meta VALUES(?,?)');
    f.db.transaction(()=>{put.run('atomic-first','1');Atomics.store(pressure,0,1);put.run('atomic-last','2');}).immediate();
    assert.throws(()=>put.run('rejected','3'),{code:'STORAGE_WAL_BACKPRESSURE'});
    assert.throws(()=>f.db.transaction(()=>put.run('rejected-transaction','4')).immediate(),{code:'STORAGE_WAL_BACKPRESSURE'});
    storageExecutionContext.run({control:true},()=>f.db.transaction(()=>put.run('control','5')).immediate());
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM runtime_meta WHERE key LIKE 'rejected%'").get().n,0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM runtime_meta WHERE key IN ('atomic-first','atomic-last','control')").get().n,3);
  }finally{f.close();}
});

test('a stalled checkpoint thread cannot hold writer commits or fenced heartbeats; accepted control bypasses WAL pressure',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'ogid-checkpoint-isolation-')),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'fixture.sqlite')});
  const gate=new Int32Array(new SharedArrayBuffer(4));let checkpoint,pending;
  try{
    await manager.start();
    assert.equal(manager.getStatus().autoCheckpoint,0);assert.equal(manager.getStatus().synchronous,2);
    assert.equal(manager.analysisManager.getStatus().readOnlyConnection,true);assert.equal(manager.queryManager.getStatus().queryOnly,true);
    await manager.request('domain.configure',{rootDir:directory,news:{},rss:{rssFeeds:[]}});manager.deferEventIndex();await manager.eventIndexTask;
    const call=(method,args={})=>manager.request('agent.call',{method,args});
    const job=await call('enqueue',{task:'global_intelligence_brief',scope:'global',model:'llamacpp/fixture',key:randomUUID(),priority:10});
    const claim=await call('claim',{owner:'checkpoint-fixture'}),auth={jobId:job.jobId,owner:'checkpoint-fixture',fence:claim.fence};
    await manager.checkpoint.close();
    checkpoint=manager.checkpoint=new WalCheckpoint({...manager.options,checkpointTimeoutMs:30000},{pressureBuffer:manager.walPressureBuffer,workerFactory:()=>new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const gate=new Int32Array(workerData);
      parentPort.postMessage({type:'ready',queryOnly:true,synchronous:2});
      parentPort.on('message',message=>{if(message.type!=='checkpoint')return;
        parentPort.postMessage({type:'entered'});Atomics.wait(gate,0,0,30000);
        parentPort.postMessage({id:message.id,result:[{busy:0,log:1,checkpointed:1}],durationMs:1});
      });`,{eval:true,workerData:gate.buffer})});
    await checkpoint.start();const entered=once(checkpoint.worker,'message');
    pending=manager.request('storage.checkpoint');assert.equal(manager.request('storage.checkpoint'),pending);await entered;
    const commits=[],heartbeats=[];
    for(let i=0;i<50;i++){
      let start=performance.now();await manager.request('pipeline.record',record());commits.push(performance.now()-start);
      start=performance.now();await call('heartbeat',{...auth,renewalId:randomUUID()});heartbeats.push(performance.now()-start);
      await wait(110);
    }
    const summary=values=>{const sorted=values.toSorted((a,b)=>a-b);return {samples:values.length,p95:sorted[47],max:sorted.at(-1)};};
    t.diagnostic(JSON.stringify({injectedStall:true,commits:summary(commits),heartbeats:summary(heartbeats)}));
    for(const values of [commits,heartbeats]){assert.ok(summary(values).p95<=2000);assert.ok(summary(values).max<=5000);}
    assert.equal(checkpoint.completed,0);assert.equal(manager.state,'ready');
    Atomics.store(new Int32Array(manager.walPressureBuffer),0,1);
    await assert.rejects(manager.request('pipeline.record',record()),{code:'STORAGE_WAL_BACKPRESSURE'});
    await call('heartbeat',{...auth,renewalId:randomUUID()});
    Atomics.store(gate,0,1);Atomics.notify(gate,0);await pending;
    assert.equal(checkpoint.status().backpressure,false);
    assert.equal((await manager.request('pipeline.record',record())).persisted,true);
    // A checkpoint's own deadline is independent of the unchanged write guard.
    Atomics.store(gate,0,0);checkpoint.options.checkpointTimeoutMs=30;
    pending=manager.request('storage.checkpoint');
    await assert.rejects(pending,{code:'STORAGE_CHECKPOINT_TIMEOUT'});
    Atomics.store(gate,0,1);Atomics.notify(gate,0);
    assert.equal(manager.state,'ready');assert.equal(manager.getStatus().failure,null);
    await call('heartbeat',{...auth,renewalId:randomUUID()});
    assert.equal((await manager.request('pipeline.record',record())).persisted,true);
  }finally{Atomics.store(gate,0,1);Atomics.notify(gate,0);await pending?.catch(()=>{});await manager.close();await manager.close();rmSync(directory,{recursive:true,force:true});}
});

test('checkpoint worker death and recovery never declare a business write uncertain',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ogid-checkpoint-recovery-')),manager=new StorageManager({enabled:true,databasePath:join(directory,'fixture.sqlite')});
  try{
    await manager.start();const checkpoint=manager.checkpoint;
    await checkpoint.worker.terminate();assert.equal(checkpoint.state,'failed');assert.equal(manager.state,'ready');
    assert.equal((await manager.request('pipeline.record',record())).persisted,true);
    checkpoint.nextEligibleAt=0;checkpoint.observe(manager.metadata.walBytes);await checkpoint.recovery;
    assert.equal(checkpoint.state,'ready');assert.ok(checkpoint.completed>=2);assert.equal(manager.getStatus().failure,null);
  }finally{await manager.close();rmSync(directory,{recursive:true,force:true});}
});

test('maintenance waits for WAL progress and resumes its durable cursor without becoming failed',async()=>{
  const manager=new StorageManager({enabled:true,businessEnabled:true});manager.state='ready';
  const pressure=new Int32Array(manager.walPressureBuffer);Atomics.store(pressure,0,1);
  let dispatched=0;manager.worker={postMessage:message=>{dispatched++;setImmediate(()=>manager.handleMessage({id:message.id,result:{state:'ready'},status:{},durationMs:1}));}};
  try{
    manager.resumeEventIndex();await wait(20);
    assert.equal(dispatched,0);assert.equal(manager.eventIndexError,null);assert.equal(manager.eventIndexScheduling.reason,'wal-checkpoint');
    Atomics.store(pressure,0,0);await manager.eventIndexTask;
    assert.equal(dispatched,1);assert.equal(manager.eventIndexState.state,'ready');assert.equal(manager.eventIndexError,null);
  }finally{manager.state='closed';manager.eventIndexAbort?.abort();await manager.eventIndexTask;}
});

test('coverage aggregates use covering indexes and retain exact unknown, rejected and empty counts',()=>{
  const f=fixture();
  try{
    const store=new SqlCandleStore(f.db),id='crypto-bitcoin-us-dollar';
    store.append(Array.from({length:200},(_,i)=>({instrumentId:id,interval:'5min',openTime:new Date(Date.UTC(2026,0,1,0,i*5)).toISOString(),closeTime:new Date(Date.UTC(2026,0,1,0,(i+1)*5)).toISOString(),open:100,high:102,low:99,close:101,volume:1,adjusted:true,revision:1,raw:'x'.repeat(32768)})));
    f.db.prepare('DELETE FROM candle_validations WHERE rowid=(SELECT min(rowid) FROM candle_validations)').run();
    f.db.prepare('UPDATE candle_validations SET eligible=0 WHERE rowid=(SELECT min(rowid) FROM candle_validations)').run();
    let query;const prepare=f.db.prepare.bind(f.db);
    f.db.prepare=sql=>{if(sql.includes('AS localCandleCount'))query=sql;return prepare(sql);};
    const [row,empty]=store.coverageSummary({instrumentIds:[id,'empty-instrument']});
    assert.equal(row.localCandleCount,200);assert.equal(row.unknownCandles,1);assert.ok(row.rejectedCandles>=1);assert.equal(row.eligibleCandles+row.rejectedCandles+row.unknownCandles,200);assert.equal(empty.localCandleCount,0);
    const plan=prepare(`EXPLAIN QUERY PLAN ${query}`).all(CANDLE_VALIDATION_VERSION,store.datasetId,'5min','splits',id,'empty-instrument');
    assert.ok(plan.some(r=>r.detail.includes('COVERING INDEX candles_coverage_metadata')));
    assert.ok(plan.some(r=>r.detail.includes('COVERING INDEX candle_validations_coverage')));
    assert.ok(plan.every(r=>!r.detail.includes('SCAN c')));
  }finally{f.close();}
});
