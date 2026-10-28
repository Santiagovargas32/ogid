import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {AgentRepository} from '../storage/agentRepository.js';
import {CandleWriteJobs,CandleWriteCoordinator} from '../storage/candleWriteJobs.js';
import {MarketDataStoreAdapter} from '../services/marketData/marketDataStore.js';
import {createAppServer} from '../server.js';

const now=()=>new Date('2026-10-27T18:00:00Z');
const bar={symbol:'NVDA',source:'yahoo',timestamp:'2026-10-23T00:00:00.000Z',open:100,high:110,low:90,close:105,volume:100};
const options={symbol:'NVDA',interval:'1d',ttlMs:1};

test('off reconciles only expired attempts without claiming or regenerating snapshots',()=>{
  const db=new Database(':memory:');migrate(db);let time=now().getTime();
  const repo=new AgentRepository(new BusinessRuntime(db),{now:()=>time,debounceMs:0});
  try{
    const admitted=repo.enqueue({task:'global_intelligence_brief',scope:'global',model:'llamacpp/fixture',key:'expired-fixture'});
    const running=repo.claim({owner:'owner'});assert.equal(running.jobId,admitted.jobId);
    assert.equal(repo.expireLeases().expired,0);
    time+=90001;const before=db.prepare('SELECT count(*) n FROM agent_jobs').get().n;
    assert.deepEqual(repo.expireLeases(),{expired:1,hasMore:false});
    const row=db.prepare('SELECT status,fence,attempts,snapshot_id,error_code FROM agent_jobs WHERE job_id=?').get(running.jobId);
    assert.deepEqual(row,{status:'incomplete',fence:1,attempts:1,snapshot_id:null,error_code:'AGENT_LEASE_EXPIRED'});
    assert.equal(db.prepare('SELECT status FROM agent_runs').get().status,'incomplete');
    assert.equal(db.prepare('SELECT count(*) n FROM agent_jobs').get().n,before);
    assert.equal(db.prepare('SELECT count(*) n FROM agent_snapshots').get().n,0);
    assert.equal(repo.expireLeases().expired,0);
    assert.throws(()=>repo.heartbeat({...running,owner:'owner'}),{code:'AGENT_LEASE_LOST'});
  }finally{db.close();}
});

test('lost candle ACK reconciles the durable cursor before resuming; recovered history does not poison drain',async()=>{
  const db=new Database(':memory:');migrate(db);db.exec('CREATE TABLE probe(id PRIMARY KEY)');let lost=true,pages=0,projections=0;
  const jobs=new CandleWriteJobs({db,services:{candles:{upsert(rows){let inserted=0;for(const r of rows)inserted+=db.prepare('INSERT OR IGNORE INTO probe VALUES(?)').run(r.closeTime).changes;return {inserted};}}}});
  const manager={state:'ready',localRequest:async(op,args)=>{
    const result=jobs[op.split('.').at(-1)](args);
    if(op.endsWith('.page')){pages++;if(lost){lost=false;throw Object.assign(Error('lost'),{code:'STORAGE_OUTCOME_UNKNOWN'});}}
    return result;
  }};
  const coordinator=new CandleWriteCoordinator(manager);
  const store=new MarketDataStoreAdapter({now,persistAsync:true,onPersisted:()=>{projections++;},candleStore:{
    persistDeferred:(candles,opts)=>coordinator.admit(candles,opts),waitForPersistence:r=>coordinator.wait(r)
  }});
  try{
    const result=await store.upsertBars([bar],options);
    await assert.rejects(store.waitForPersistence(result.persistence),{code:'STORAGE_OUTCOME_UNKNOWN'});
    await store.flushPersistence();await coordinator.flush();
    assert.equal(db.prepare('SELECT count(*) n FROM probe').get().n,1);
    assert.equal(pages,1,'complete cursor reconciles without replaying its page');assert.equal(projections,1);
    assert.equal(store.getPersistenceStatus().failed,1);assert.equal(store.getPersistenceStatus().unresolved,0);
    await store.flushPersistence();assert.equal(projections,1);
  }finally{await coordinator.close();db.close();}
});

test('projection failure is distinct from confirmed candles and only a successful successor clears it',async()=>{
  let fail=true;const diagnostics=[];
  const store=new MarketDataStoreAdapter({now,persistAsync:true,candleStore:{upsert:async()=>({inserted:1})},
    onPersisted:async()=>{if(fail)throw Object.assign(Error('queue'),{code:'STORAGE_QUEUE_TIMEOUT'});},
    onPersistenceError:(error,correlation)=>diagnostics.push({code:error.code,...correlation})});
  const first=await store.upsertBars([bar],options);await store.waitForPersistence(first.persistence);
  await assert.rejects(store.flushPersistence(),error=>error.persistenceFailures[0].phase==='indicators');
  assert.equal(first.persistence.committed,true);assert.equal(store.getPersistenceStatus().failed,0);
  assert.equal(diagnostics[0].phase,'indicators');
  fail=false;await store.upsertBars([{...bar,close:106}],options);await store.flushPersistence();
  assert.equal(store.getPersistenceStatus().unresolved,0);
});

test('duplicate candles cannot clear a failed projection without actually rebuilding it',async()=>{
  let first=true,fail=true,calculations=0;
  const store=new MarketDataStoreAdapter({now,persistAsync:true,candleStore:{upsert:async()=>{
    const inserted=first?1:0;first=false;return {inserted,updated:0,duplicates:inserted?0:1};
  }},onPersisted:async({persistence,projectionRequired})=>{
    if(!persistence.inserted&&!persistence.updated&&!projectionRequired)return;
    calculations++;if(fail)throw Object.assign(Error('projection failed'),{code:'STORAGE_QUEUE_TIMEOUT'});
  }});
  await store.upsertBars([bar],options);
  await assert.rejects(store.flushPersistence(),{code:'MARKET_PERSISTENCE_UNCONFIRMED'});
  await store.upsertBars([bar],options);
  await assert.rejects(store.flushPersistence(),{code:'MARKET_PERSISTENCE_UNCONFIRMED'});
  assert.equal(calculations,2);
  fail=false;await store.upsertBars([bar],options);await store.flushPersistence();
  assert.equal(calculations,3);assert.equal(store.getPersistenceStatus().unresolved,0);
});

test('uncertain storage with no readable receipt remains unconfirmed and is never replayed',async()=>{
  let writes=0,reads=0;
  const coordinator=new CandleWriteCoordinator({state:'failed',localRequest:async(op)=>{
    if(op.endsWith('.page'))writes++;else reads++;
    throw Object.assign(Error('unavailable'),{code:'STORAGE_NOT_READY'});
  }});
  try{
    await assert.rejects(coordinator.wait({jobIds:['market-unknown']}),{code:'STORAGE_NOT_READY'});
    assert.equal(writes,0);assert.equal(reads,1);assert.equal(coordinator.timers.size,0);
  }finally{await coordinator.close();}
});

test('a lost partial-page ACK resumes from the confirmed cursor without duplicate effects',async()=>{
  const db=new Database(':memory:');migrate(db);db.exec('CREATE TABLE probe(id PRIMARY KEY)');let lose=true,pages=0,statusReads=0;
  const jobs=new CandleWriteJobs({db,services:{candles:{upsert(rows){for(const r of rows)db.prepare('INSERT INTO probe VALUES(?)').run(r.id);return {inserted:rows.length};}}}});
  const coordinator=new CandleWriteCoordinator({state:'ready',localRequest:async(op,input)=>{
    if(op.endsWith('.status'))statusReads++;
    const r=jobs[op.split('.').at(-1)](input);
    if(op.endsWith('.page')){pages++;if(lose){lose=false;throw Object.assign(Error('ACK lost after commit'),{code:'STORAGE_OUTCOME_UNKNOWN'});}}
    return r;
  }});
  try{
    const receipt=jobs.admit({candles:Array.from({length:25},(_,id)=>({id}))});
    await assert.rejects(coordinator.wait({jobIds:[receipt.jobId]}),{code:'STORAGE_OUTCOME_UNKNOWN'});
    assert.equal(jobs.status(receipt).completedItems,10);
    const recovered=await coordinator.wait({jobIds:[receipt.jobId]});
    assert.equal(recovered.inserted,25);assert.equal(pages,3);assert.equal(statusReads,2);
    assert.equal(db.prepare('SELECT count(*) n FROM probe').get().n,25);
  }finally{await coordinator.close();db.close();}
});

test('off blocks admission and snapshots while deterministic ingestion and situations advance without a browser',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-d02-off-'));
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,
    agent:{mode:'off',internalToken:'fixture-token'},storage:{enabled:true,businessEnabled:true,databasePath:join(dir,'db.sqlite')},
    news:{providers:[],rssFeeds:[]},market:{enabled:false,historyDir:dir,initialTickers:[],historyPersist:false}});
  try{
    await runtime.start();const locals=runtime.app.locals,base=`http://127.0.0.1:${runtime.server.address().port}`;
    for(const method of ['claim','consume','enqueue','snapshot']){
      const res=await fetch(`${base}/api/agent/v1/internal/${method}`,{method:'POST',headers:{Authorization:'Bearer fixture-token','Content-Type':'application/json'},body:'{}'});
      assert.equal(res.status,503,method);assert.equal((await res.json()).error.code,'AGENT_DISABLED');
    }
    const at=new Date().toISOString();await locals.business.news.ingest([{id:'off-news',title:'Missile strike in Kyiv',url:'https://example.org/off-news',provider:'rss',publishedAt:at,receivedAt:at}]);
    await locals.agentMaintenance.tick();
    const status=await locals.business.situations.status();assert.equal(status.hasMore,false);assert.ok(status.streams.find(s=>s.stream==='news').lastSequence>0);
    assert.equal(locals.agentMaintenance.enabled,true);assert.equal(locals.agentRuntime.children.size,0);
    const db=new Database(join(dir,'db.sqlite'),{readonly:true});try{
      assert.equal(db.prepare('SELECT count(*) n FROM agent_runs').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM agent_snapshots').get().n,0);
      assert.equal(db.prepare('SELECT count(*) n FROM situation_outbox o LEFT JOIN situation_revisions r ON r.sequence=o.domain_sequence WHERE r.sequence IS NULL').get().n,0);
    }finally{db.close();}
    await runtime.stop();assert.deepEqual(locals.shutdownReport.unconfirmedPersistence,[]);
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown records a projection failure instead of declaring clean persistence',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-d02-stop-'));
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,
    storage:{enabled:true,businessEnabled:true,databasePath:join(dir,'db.sqlite')},news:{providers:[],rssFeeds:[]},
    market:{enabled:false,historyDir:dir,initialTickers:[],historyPersist:false}});
  try{
    await runtime.start();const store=runtime.app.locals.marketDataService.store;
    store.onPersisted=async()=>{throw Object.assign(Error('uncertain'),{code:'STORAGE_OUTCOME_UNKNOWN'});};
    await store.upsertBars([bar],options);
    await assert.rejects(runtime.stop(),{code:'MARKET_PERSISTENCE_UNCONFIRMED'});
    assert.equal(runtime.app.locals.shutdownReport.unconfirmedPersistence[0].phase,'persistence.market');
    assert.equal(runtime.storageManager.state,'closed');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a reader outcome unknown during drain cannot become a clean shutdown after handle release',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-d02-reader-stop-'));
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,
    storage:{enabled:true,businessEnabled:true,databasePath:join(dir,'db.sqlite')},news:{providers:[],rssFeeds:[]},
    market:{enabled:false,historyDir:dir,initialTickers:[],historyPersist:false}});
  try{
    await runtime.start();
    runtime.storageManager.analysisManager.fail(Object.assign(Error('uncertain reader RPC outcome'),{code:'STORAGE_OUTCOME_UNKNOWN',causeCode:'STORAGE_EXECUTION_TIMEOUT'}));
    await assert.rejects(runtime.stop(),{code:'STORAGE_OUTCOME_UNKNOWN'});
    const report=runtime.app.locals.shutdownReport;assert.equal(report.primaryCause,null);
    assert.equal(report.unconfirmedPersistence[0].phase,'persistence.analysis');
    assert.equal(report.unconfirmedPersistence[0].causeCode,'STORAGE_EXECUTION_TIMEOUT');
    assert.equal(runtime.storageManager.state,'closed');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
