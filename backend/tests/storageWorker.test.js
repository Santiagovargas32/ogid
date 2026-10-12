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
    const status=await f.manager.request("storage.status");assert.equal(status.migrations.length,7);assert.equal(status.businessStorage,"legacy-json");
    const row=run(),requestId=randomUUID();
    const first=await f.manager.request("pipeline.record",row,{requestId});
    assert.deepEqual(await f.manager.request("pipeline.record",{counts:row.counts,status:row.status,completedAt:row.completedAt,startedAt:row.startedAt,pipelineId:row.pipelineId,runId:row.runId},{requestId}),first);
    await assert.rejects(f.manager.request("pipeline.record",{...row,counts:{processed:2}},{requestId}),{code:"STORAGE_IDEMPOTENCY_CONFLICT"});
    await assert.rejects(f.manager.request("pipeline.record",{...run(),pipelineId:"missing"}),{code:"SQLITE_CONSTRAINT_FOREIGNKEY"});
    const integrity=await f.manager.request("storage.verify");assert.deepEqual(integrity.foreignKeys,[]);assert.equal(integrity.integrity[0].integrity_check,"ok");
    await f.manager.close();
    const db=new Database(f.databasePath,{readonly:true});assert.equal(db.prepare("select count(*) as n from pipeline_runs").get().n,1);assert.equal(db.prepare("select count(*) as n from storage_commands").get().n,1);db.close();
    f.manager=new StorageManager({enabled:true,databasePath:f.databasePath});await f.manager.start();assert.equal((await f.manager.request("storage.status")).migrations.length,7);
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
