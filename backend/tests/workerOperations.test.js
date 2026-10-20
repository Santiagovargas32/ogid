import test from "node:test";
import assert from "node:assert/strict";
import { StorageManager } from "../storage/StorageManager.js";
import { renderWorkerOperations } from "../../frontend/js/workerOperations.js";

test("supplemental watchdog renews only after committed progress and cancels a stalled workflow without failing the writer",async()=>{
 const manager=new StorageManager({enabled:true,timeoutMs:10000});const messages=[];
 manager.state='ready';manager.worker={postMessage:m=>messages.push(m)};
 const pending=manager.request('news.supplemental',{}, {timeoutMs:200});
 const entry=[...manager.active.values()][0];manager.handleMessage({type:'command-started',id:entry.id,startedAt:Date.now()});
 const before=entry.timer;
 manager.handleMessage({type:'command-progress',id:entry.id,completed:10});assert.notEqual(entry.timer,before);
 const renewed=entry.timer;manager.handleMessage({type:'command-progress',id:entry.id,completed:10});assert.equal(entry.timer,renewed);
 manager.handleMessage({type:'telemetry',worker:{heartbeatAt:new Date().toISOString()}});assert.equal(entry.timer,renewed);
 assert.equal(manager.getStatus().activeCommands[0].completedItems,10);
 clearTimeout(entry.timer);manager.expire(entry);assert.equal(manager.state,'ready');assert.equal(manager.active.size,1);assert.equal(messages.at(-1).type,'cancel-workflow');
 const rejected=assert.rejects(pending,{code:'STORAGE_WORKFLOW_STALLED'});
 manager.handleMessage({id:entry.id,error:{code:'STORAGE_WORKFLOW_STALLED'}});await rejected;
 const write=manager.request('runtime.save',{kind:'survives',payload:{saved:true}}),id=[...manager.active.keys()][0];
 manager.handleMessage({id,result:{persisted:true},status:{}});await write;assert.equal(manager.state,'ready');
});

test("unacknowledged workflow cancellation still fences an unresponsive SQLite writer",async()=>{
 const manager=new StorageManager({enabled:true,analysisWorker:true,timeoutMs:10000});
 manager.state='ready';manager.worker={postMessage(){},async terminate(){}};
 const pending=manager.request('news.supplemental');const rejected=assert.rejects(pending,{code:'STORAGE_OUTCOME_UNKNOWN'}),entry=[...manager.active.values()][0];
 manager.handleMessage({type:'command-started',id:entry.id,startedAt:Date.now()});clearTimeout(entry.timer);manager.expire(entry);
 assert.equal(entry.cancelling,true);clearTimeout(entry.timer);manager.expire(entry);await rejected;await manager.close();assert.equal(manager.state,'failed');
});

test("worker observation distinguishes waiting, executing, failed and rejected work, retaining only metadata",async()=>{
  const manager=new StorageManager({enabled:true,maxInFlight:1,maxCommandBytes:1024,queueMaxBytes:8192,queueMaxItems:2});
  manager.state="ready";manager.worker={postMessage(){}};
  const first=manager.request("storage.status",{apiKey:"private-fixture-secret"});
  const second=manager.request("storage.status");
  const id=[...manager.active.keys()][0];
  let status=manager.getStatus();
  assert.equal(status.activeCommands[0].phase,"dispatched");
  assert.equal(status.queuedCommands.length,1);
  await assert.rejects(manager.request("storage.status"),{code:"STORAGE_BACKPRESSURE"});
  assert.equal(manager.getStatus().lastRejectedCommand.code,"STORAGE_BACKPRESSURE");
  manager.handleMessage({type:"command-started",id,startedAt:Date.now()-5});
  assert.equal(manager.getStatus().activeCommands[0].phase,"executing");
  manager.handleMessage({id,result:{ok:true},durationMs:5,cpuMs:null,status:{}});
  await first;
  const secondId=[...manager.active.keys()][0];
  const failed=assert.rejects(second,{code:"STORAGE_INVALID_COMMAND"});
  manager.handleMessage({id:secondId,error:{code:"STORAGE_INVALID_COMMAND"}});await failed;
  for(let i=0;i<55;i++)await assert.rejects(manager.request("storage.status",{content:"x".repeat(2048),apiKey:"private-fixture-secret"}),{code:"STORAGE_COMMAND_TOO_LARGE"});
  status=manager.getStatus();
  assert.equal(status.recentCommands.length,50);
  assert.equal(status.lastRejectedCommand.code,"STORAGE_COMMAND_TOO_LARGE");
  assert.ok(status.lastRejectedCommand.bytes>1024);
  assert.equal(status.queue.bytes,0);
  assert.ok(!JSON.stringify(status).includes("private-fixture-secret"));
  assert.ok(!JSON.stringify(status).includes("content"));
  assert.equal(status.state,"ready");
  await assert.rejects(manager.request("domain.call",{service:"x".repeat(5000)}),{code:"STORAGE_COMMAND_TOO_LARGE"});
  assert.equal(manager.getStatus().lastRejectedCommand.service.length,128);
  manager.pump=()=>{};
  const waiting=manager.request("storage.status");
  const expired=assert.rejects(waiting,{code:"STORAGE_QUEUE_TIMEOUT"});
  manager.expire(manager.queue[0]);await expired;
  assert.equal(manager.getStatus().recentCommands.at(-1).code,"STORAGE_QUEUE_TIMEOUT");
  assert.equal(manager.getStatus().queue.bytes,0);
});

test("admin worker panel shows both workers, command budgets and rejection reasons without injecting markup",()=>{
  const writer={state:"ready",queue:{pending:1,inFlight:1,bytes:1024,maxBytes:8192,maxCommandBytes:4096,maxItems:128},activeCommands:[{operation:"domain.call",service:"news",method:"ingest",phase:"executing",bytes:512,queueMs:10,executionMs:25,elapsedMs:35}],queuedCommands:[{operation:"runtime.save",kind:"market",phase:"queued",bytes:512,queueMs:5,executionMs:null}],recentCommands:[],completed:12,failed:0,rejected:0};
  const analysis={...writer,queue:{...writer.queue,pending:0,inFlight:0},activeCommands:[],queuedCommands:[],recentCommands:[{operation:"domain.call",service:"market",method:"analyze",status:"rejected",code:"STORAGE_COMMAND_TOO_LARGE",bytes:9000,finishedAt:"2026-10-14T17:00:00Z"}],lastRejectedCommand:{operation:"domain.call",method:"<script>alert(1)</script>",code:"STORAGE_COMMAND_TOO_LARGE",bytes:9000},rejected:1};
  const html=renderWorkerOperations({...writer,analysis},{sampledAt:"2026-10-14T17:00:00Z"});
  for(const text of ["Escritor","Análisis","En cola","En ejecución","Rechazada","Límite por comando","4.0 KiB","STORAGE_COMMAND_TOO_LARGE","Últimos resultados"])assert.ok(html.includes(text),text);
  assert.ok(!html.includes("<script>"));assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(renderWorkerOperations({...writer,recentCommands:[{status:"failed",code:"STORAGE_OUTCOME_UNKNOWN"}]}).includes("Resultado incierto"));
  assert.ok(renderWorkerOperations(null).includes("No hay telemetría"));
  assert.ok(renderWorkerOperations({state:"disabled"}).includes("desactivado"));
  assert.ok(renderWorkerOperations({state:"ready"}).includes("Sin operaciones"));
});


test("a delayed start acknowledgement keeps the worker and its occupied slot alive",async()=>{
  const manager=new StorageManager({enabled:true,maxInFlight:1,timeoutMs:1000});
  let sent;
  manager.state="ready";manager.worker={postMessage(value){sent=value;}};
  const pending=manager.request("storage.status",{},{queueTimeoutMs:10});
  const entry=[...manager.active.values()][0];
  assert.equal(sent.queueDeadline,entry.queuedAt+10);
  clearTimeout(entry.timer);manager.expire(entry);
  assert.equal(manager.state,"ready");assert.equal(manager.active.size,1);
  assert.equal(manager.pendingBytes,entry.bytes);
  manager.handleMessage({type:"command-started",id:entry.id,startedAt:entry.queuedAt});
  manager.handleMessage({id:entry.id,result:{ok:true},durationMs:1,status:{}});
  assert.deepEqual(await pending,{ok:true});assert.equal(manager.pendingBytes,0);
});

test("a worker that never acknowledges a dispatched command still fails with the originating diagnostic",async()=>{
  const manager=new StorageManager({enabled:true,analysisWorker:true,timeoutMs:1000});
  manager.state="ready";manager.worker={postMessage(){},async terminate(){}};
  const pending=manager.request("storage.status",{},{queueTimeoutMs:10});
  const rejected=assert.rejects(pending,reason=>{
    assert.equal(reason.code,"STORAGE_READ_TIMEOUT");assert.equal(reason.causeCode,"STORAGE_DISPATCH_TIMEOUT");
    assert.equal(reason.diagnostic.operation,"storage.status");assert.equal(reason.diagnostic.phase,"dispatched");return true;
  });
  const entry=[...manager.active.values()][0];
  clearTimeout(entry.timer);manager.expire(entry);
  clearTimeout(entry.timer);manager.expire(entry);
  await rejected;await manager.close();assert.equal(manager.state,"failed");assert.equal(manager.pendingBytes,0);
});
