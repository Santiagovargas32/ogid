import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { StorageManager } from "../storage/StorageManager.js";
import { storageConfig } from "../storage/config.js";
import { createAppServer } from "../server.js";
function fixture(options={}) {
  const directory=mkdtempSync(join(tmpdir(),"ogid-storage-test-"));
  const databasePath=join(directory,"ogid.sqlite");
  return { directory,databasePath,manager:new StorageManager({enabled:true,databasePath,...options}),async close(){await this.manager.close();rmSync(directory,{recursive:true,force:true});} };
}
function run(runId=randomUUID()) { const now=new Date().toISOString();return {runId,pipelineId:"storage",startedAt:now,completedAt:now,status:"healthy",counts:{processed:1}}; }

test("SQLite migrations, idempotency, rollback and reopen preserve committed rows",async()=>{
  const f=fixture();
  try {
    await f.manager.start();
    const status=await f.manager.request("storage.status");assert.equal(status.migrations.length,31);assert.equal(status.businessStorage,"legacy-json");
    const row=run(),requestId=randomUUID();
    const first=await f.manager.request("pipeline.record",row,{requestId});
    assert.deepEqual(await f.manager.request("pipeline.record",{counts:row.counts,status:row.status,completedAt:row.completedAt,startedAt:row.startedAt,pipelineId:row.pipelineId,runId:row.runId},{requestId}),first);
    await assert.rejects(f.manager.request("pipeline.record",{...row,counts:{processed:2}},{requestId}),{code:"STORAGE_IDEMPOTENCY_CONFLICT"});
    await assert.rejects(f.manager.request("pipeline.record",{...run(),pipelineId:"missing"}),{code:"SQLITE_CONSTRAINT_FOREIGNKEY"});
    const integrity=await f.manager.request("storage.verify");assert.deepEqual(integrity.foreignKeys,[]);assert.equal(integrity.integrity[0].integrity_check,"ok");
    await f.manager.close();
    const db=new Database(f.databasePath,{readonly:true});assert.equal(db.prepare("select count(*) as n from pipeline_runs").get().n,1);assert.equal(db.prepare("select count(*) as n from storage_commands").get().n,1);db.close();
    f.manager=new StorageManager({enabled:true,databasePath:f.databasePath});await f.manager.start();assert.equal((await f.manager.request("storage.status")).migrations.length,31);
  } finally {await f.close();}
});

test("bounded queue rejects excess work and shutdown drains accepted writes",async()=>{
  const f=fixture({queueMaxItems:1});
  try {
    await f.manager.start();
    const pending=f.manager.request("pipeline.record",run());
    await assert.rejects(f.manager.request("storage.status"),{code:"STORAGE_BACKPRESSURE"});
    const closing=f.manager.close();await assert.rejects(f.manager.request("storage.status"),{code:"STORAGE_NOT_READY"});
    assert.equal((await pending).persisted,true);await closing;assert.equal(f.manager.state,"closed");assert.equal(f.manager.getStatus().queue.bytes,0);await assert.rejects(f.manager.start(),{code:"STORAGE_NOT_READY"});
  } finally {await f.close();}
});

test("byte limits and immutable command envelopes bound worker messages",async()=>{
  const f=fixture({queueMaxBytes:300,maxCommandBytes:200});
  try {
    await f.manager.start();
    await assert.rejects(f.manager.request("storage.status",{content:"x".repeat(300),apiKey:"private-fixture-value"}),reason=>{
      assert.equal(reason.code,"STORAGE_COMMAND_TOO_LARGE");
      assert.equal(reason.diagnostic.operation,"storage.status");
      assert.equal(reason.diagnostic.maxCommandBytes,200);
      assert.ok(reason.diagnostic.bytes>200);
      assert.ok(!JSON.stringify(reason.diagnostic).includes("private-fixture-value"));
      return true;
    });
    assert.equal(f.manager.getStatus().queue.bytes,0);
    assert.equal(f.manager.getStatus().queue.maxCommandBytes,200);
    assert.equal(f.manager.state,"ready");
    await assert.rejects(f.manager.request("sql.execute",{}),{code:"STORAGE_UNKNOWN_OPERATION"});
  }
  finally {await f.close();}
});

test("worker death rejects work and does not leave a ready manager",async()=>{
  const f=fixture();
  try {await f.manager.start();await f.manager.worker.terminate();assert.equal(f.manager.state,"failed");await assert.rejects(f.manager.request("storage.status"),{code:"STORAGE_NOT_READY"});}
  finally {await f.close();}
});

test("concurrent startup waits for the isolated analysis worker",async t=>{
  const f=fixture({businessEnabled:true});
  let release,announce;
  const barrier=new Promise(resolve=>{release=resolve;});
  const childStarted=new Promise(resolve=>{announce=resolve;});
  const original=StorageManager.prototype.startWorkers;
  t.mock.method(StorageManager.prototype,"startWorkers",async function(){
    const result=await original.call(this);
    if(this.options.analysisWorker){announce();await barrier;}
    return result;
  });
  try{
    const first=f.manager.start();await childStarted;
    let ready=false;
    const second=f.manager.start().then(result=>{ready=true;return result;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(ready,false);
    release();await Promise.all([first,second]);
    assert.equal(f.manager.analysisManager.state,"ready");
  }finally{release();await f.close();}
});

test("writer failure terminates analysis and preserves the original failure diagnostic",async()=>{
  const f=fixture({businessEnabled:true});
  try{
    await f.manager.start();await f.manager.worker.terminate();
    assert.equal(f.manager.state,"failed");
    assert.equal(f.manager.analysisManager.state,"failed");
    await assert.rejects(f.manager.request("domain.call",{service:"advanced",method:"getSnapshot"}),reason=>{
      assert.equal(reason.code,"STORAGE_NOT_READY");
      assert.equal(reason.causeCode,"STORAGE_WORKER_EXITED");
      assert.equal(reason.diagnostic.worker,"writer");return true;
    });
    await f.manager.analysisManager.termination;
  }finally{await f.close();}
});

test("shutdown during analysis startup waits for it and closes both workers",async t=>{
  const f=fixture({businessEnabled:true});
  let release,announce;
  const barrier=new Promise(resolve=>{release=resolve;});
  const childStarted=new Promise(resolve=>{announce=resolve;});
  const original=StorageManager.prototype.startWorkers;
  t.mock.method(StorageManager.prototype,"startWorkers",async function(){
    const result=await original.call(this);
    if(this.options.analysisWorker){announce();await barrier;}
    return result;
  });
  try{
    const starting=f.manager.start();await childStarted;
    const closing=f.manager.close();
    release();await starting;await closing;
    assert.equal(f.manager.state,"closed");assert.equal(f.manager.analysisManager.state,"closed");
  }finally{release();await f.close();}
});

test("analysis failure is observable by the owner and leaves accepted writer work available for draining",async()=>{
  const f=fixture({businessEnabled:true});
  try{
    await f.manager.start();const failures=[];
    f.manager.on("failed",reason=>failures.push(reason));
    await f.manager.analysisManager.worker.terminate();
    assert.equal(failures.length,1);assert.equal(failures[0].diagnostic.worker,"analysis");
    assert.equal(f.manager.state,"ready");
    assert.equal((await f.manager.request("pipeline.record",run())).persisted,true);
    await f.manager.close();assert.equal(f.manager.state,"closed");
  }finally{await f.close();}
});

test('analytical reader recovery preserves interactive reads and the single writer',async()=>{
 const f=fixture({businessEnabled:true});try{
  await f.manager.start();await f.manager.request('domain.configure',{rootDir:f.directory,instruments:[],news:{},rss:{rssFeeds:[]}});
  const queryThread=f.manager.queryManager.worker.threadId;
  await f.manager.analysisManager.worker.terminate();
  const feed=await f.manager.request('domain.call',{service:'news',method:'getFeed',args:[{limit:5}]});assert.equal(feed.items.length,0);
  assert.equal((await f.manager.request('runtime.save',{kind:'reader-isolation',payload:{saved:true}})).persisted,true);
  await f.manager.recoverAnalysis();assert.equal(f.manager.queryManager.worker.threadId,queryThread);
  assert.equal(f.manager.queryManager.getStatus().queryOnly,true);assert.equal(f.manager.analysisManager.getStatus().queryOnly,true);
  await f.manager.queryManager.worker.terminate();
  assert.equal((await f.manager.analysisManager.request('storage.status')).readOnlyConnection,true);
  await f.manager.recoverReader('queries');assert.deepEqual((await f.manager.request('domain.call',{service:'candles',method:'query',args:[{instrumentId:'none'}]})),[]);
 }finally{await f.close();}
});

test("server shutdown releases both SQL workers after stage persistence fails",async t=>{
  const f=fixture({businessEnabled:true});
  const runtime=createAppServer({port:0,host:"127.0.0.1",storageManager:f.manager,disableBackgroundRefresh:true,
    news:{providers:[],rssFeeds:[]},market:{enabled:false,historyPersist:false,historyDir:f.directory,initialTickers:[],tickers:[]}});
  let stopped=false;
  try{
    await runtime.start();const monitor=runtime.app.locals.pipelineMonitor;await monitor.flush();
    const request=f.manager.request.bind(f.manager);
    t.mock.method(f.manager,"request",(operation,input,options)=>{
      if(operation === "runtime.save" && input.kind === "pipeline-stage" && input.payload.id === "news.normalize")
        return Promise.reject(Object.assign(new Error("SQLITE_FULL"),{code:"SQLITE_FULL"}));
      return request(operation,input,options);
    });
    monitor.update("news.normalize",{status:"completed"});await monitor.flush();
    assert.equal(monitor.snapshot()["news.normalize.persistence"].status,"blocked");
    await assert.rejects(runtime.stop(),{code:"SQLITE_FULL"});stopped=true;
    assert.equal(f.manager.state,"closed");assert.equal(f.manager.analysisManager.state,"closed");
    assert.equal(runtime.server.listening,false);assert.equal(runtime.app.locals.runtimeMetrics.ready,false);
  }finally{if(!stopped)await runtime.stop().catch(()=>{});await f.close();}
});

test('writer failure keeps its primary cause, reports unconfirmed persistence and closes idempotently',async()=>{
  const f=fixture({businessEnabled:true}),runtime=createAppServer({port:0,host:'127.0.0.1',storageManager:f.manager,disableBackgroundRefresh:true,
    agent:{mode:'off'},news:{providers:[],rssFeeds:[]},market:{enabled:false,historyPersist:false,historyDir:f.directory,initialTickers:[],tickers:[]}});
  try{
    await runtime.start();await runtime.app.locals.pipelineMonitor.flush();
    runtime.app.locals.intradayCandleService.instrumentStates.set('fixture',{pendingJobId:'fixture-interrupted-catchup'});
    f.manager.fail(Object.assign(Error('fixture timeout'),{code:'STORAGE_OUTCOME_UNKNOWN',causeCode:'STORAGE_EXECUTION_TIMEOUT'}));
    const closing=runtime.stop();assert.equal(runtime.stop(),closing);await closing;
    assert.equal(runtime.app.locals.shutdownReport.primaryCause.code,'STORAGE_OUTCOME_UNKNOWN');
    assert.equal(runtime.app.locals.shutdownReport.primaryCause.causeCode,'STORAGE_EXECUTION_TIMEOUT');
    assert.deepEqual(runtime.app.locals.shutdownReport.cleanupErrors,[]);
    assert.ok(runtime.app.locals.shutdownReport.unconfirmedPersistence.some(row=>row.phase==='persistence.history-cancellation'));
    assert.equal(runtime.server.listening,false);assert.equal(f.manager.analysisManager.state,'failed');
    assert.equal(runtime.app.locals.runtimeMetrics.ready,false);
  }finally{await runtime.stop().catch(()=>{});await f.close();}
});

test("a dispatched command that expires before starting is skipped without killing an accepted write",async()=>{
  const f=fixture({maxInFlight:2,timeoutMs:5000,busyTimeoutMs:3000});let lock;
  try {
    await f.manager.start();lock=new Database(f.databasePath);lock.exec("BEGIN IMMEDIATE");
    const started=new Promise(resolve=>{
      const onMessage=message=>{if(message.type==="command-started"){f.manager.worker.off("message",onMessage);resolve();}};
      f.manager.worker.on("message",onMessage);
    });
    const firstRow=run(),expiredRow=run();
    const first=f.manager.request("pipeline.record",firstRow);
    const firstResult=assert.doesNotReject(first);
    await started;
    const expired=assert.rejects(f.manager.request("pipeline.record",expiredRow,{queueTimeoutMs:20}),{code:"STORAGE_QUEUE_TIMEOUT"});
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(f.manager.state,"ready");
    lock.exec("ROLLBACK");
    await Promise.all([firstResult,expired]);
    assert.equal((await first).persisted,true);
    assert.equal(f.manager.state,"ready");
    assert.equal(f.manager.getStatus().queue.bytes,0);
    assert.deepEqual(lock.prepare("SELECT run_id FROM pipeline_runs").all(),[{run_id:firstRow.runId}]);
    assert.equal((await f.manager.request("storage.status")).businessStorage,"legacy-json");
  } finally {if(lock?.inTransaction)lock.exec("ROLLBACK");lock?.close();await f.close();}
});

test("timeout of dispatched write reports unknown outcome and fails the worker",async()=>{
  const f=fixture({timeoutMs:100,busyTimeoutMs:3000});let lock;
  try {await f.manager.start();lock=new Database(f.databasePath);lock.exec("BEGIN IMMEDIATE");await assert.rejects(f.manager.request("pipeline.record",run()),{code:"STORAGE_OUTCOME_UNKNOWN"});assert.equal(f.manager.state,"failed");const command=f.manager.getStatus().lastExpiredCommand;assert.equal(command.operation,"pipeline.record");assert.equal(command.timeoutMs,100);assert.ok(["executing","dispatched"].includes(command.phase));lock.exec("ROLLBACK");}
  finally {lock?.close();await f.close();}
});

test("applied migration edits and corrupt databases are rejected without overwriting",async()=>{
  const f=fixture();
  try {
    const migrations=join(f.directory,"migrations");cpSync(new URL("../storage/migrations/",import.meta.url),migrations,{recursive:true});
    f.manager=new StorageManager({enabled:true,databasePath:f.databasePath,migrationsDir:migrations});await f.manager.start();await f.manager.close();
    appendFileSync(join(migrations,"001_core.sql"),"\n-- edited after applying\n");f.manager=new StorageManager({enabled:true,databasePath:f.databasePath,migrationsDir:migrations});await assert.rejects(f.manager.start(),{code:"STORAGE_MIGRATION_MISMATCH"});await f.manager.close();
    const corrupt=join(f.directory,"corrupt.sqlite");writeFileSync(corrupt,"preserve-this-invalid-database");f.manager=new StorageManager({enabled:true,databasePath:corrupt});await assert.rejects(f.manager.start(),{code:"SQLITE_NOTADB"});assert.equal(readFileSync(corrupt,"utf8"),"preserve-this-invalid-database");
  } finally {await f.close();}
});

test("server lifecycle exposes cached storage status and retains on-demand history routes",async()=>{
  const f=fixture();
  const runtime=createAppServer({port:0,storageManager:f.manager,disableBackgroundRefresh:true,news:{providers:[],rssFeeds:[]},market:{enabled:false,historyPersist:false,initialTickers:[],tickers:[]}});
  try {
    await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
    const before=f.manager.getStatus().completed;
    const health=await (await fetch(base+"/api/health")).json();assert.equal(health.data.storage.state,"ready");assert.equal(health.data.storage.storagePhase,"infrastructure");assert.equal(health.data.server.pid,process.pid);assert.ok(health.data.storage.worker.heartbeatAt);assert.equal(health.data.storage.worker.database.counts.articles,0);
    const admin=await (await fetch(base+"/api/admin/pipeline-status")).json();assert.equal(admin.data.storage.businessStorage,"legacy-json");assert.equal(f.manager.getStatus().completed,before);
    const page=await (await fetch(base+"/admin")).text();assert.ok(!page.includes("history-title"));
    const history=await fetch(base+"/api/admin/history");assert.equal(history.status,200);
  } finally {await runtime.stop();await f.close();}
});

test("storage configuration resolves relative database paths under backend",()=>{
  assert.equal(storageConfig({databasePath:"data/sqlite/test.sqlite"},{}).databasePath.endsWith("/backend/data/sqlite/test.sqlite"),true);
  const business=storageConfig({}, {STORAGE_BUSINESS_ENABLED:"1"});
  assert.equal(business.maxCommandBytes,8388608);
  assert.equal(business.queueMaxBytes,33554432);
});

test("SQL server starts with the full RSS catalog under the old 256 KiB message limit",async()=>{
  const f=fixture({businessEnabled:true,maxCommandBytes:262144,queueMaxBytes:8388608});
  const runtime=createAppServer({port:0,storageManager:f.manager,disableBackgroundRefresh:true,news:{providers:[]},market:{enabled:false,provider:"",historyPersist:false,historyDir:f.directory,initialTickers:[],tickers:[]}});
  const request=f.manager.request.bind(f.manager);
  let configured;
  f.manager.request=(operation,input,options)=>{
    if(operation==="domain.configure")configured=input;
    return request(operation,input,options);
  };
  try{
    assert.ok(Buffer.byteLength(JSON.stringify(runtime.config.news.sourceCatalog))>262144);
    await runtime.start();
    assert.ok(runtime.config.news.rssFeeds.length>=66);
    assert.equal(Object.hasOwn(configured.news,"sourceCatalog"),false);
    assert.deepEqual(configured.news.rssFeeds,runtime.config.news.rssFeeds);
    assert.deepEqual(configured.rss.rssFeeds,runtime.config.news.rssFeeds);
    assert.equal(configured.news.displayLimit,runtime.config.news.displayLimit);
    assert.ok(Buffer.byteLength(JSON.stringify({operation:"domain.configure",input:configured,requestId:randomUUID()}))<262144);
    const health=await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/health`);
    assert.equal(health.status,200);
    assert.equal((await health.json()).data.storage.state,"ready");
    assert.equal(f.manager.getStatus().rejected,0);
  }finally{await runtime.stop();await f.close();}
});
