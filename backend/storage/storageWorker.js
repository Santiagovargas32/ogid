import {CandleWriteJobs} from './candleWriteJobs.js';
import {CommitActivity} from "./commitActivity.js";
import {storageOperationContract} from '../contracts/storageOperations.js';
import { FrozenRows } from "./frozenRows.js";
import { RUNTIME_POLICY } from "../config/runtimePolicy.js";
import { assertWriterAvailable, acquireWriter, releaseWriter } from "./writerOwnership.js";
import { parentPort, workerData, threadId } from "node:worker_threads";
import { readDatabaseDiagnostics } from "./diagnostics.js";
import { mkdirSync, statSync, chmodSync } from "node:fs";
import path from "node:path";
import { stableHash } from "../utils/stableHash.js";
import Database from "better-sqlite3";
import { createLogger } from "../utils/logger.js";
const log=createLogger("backend/storage/worker");
import { migrate } from "./migrate.js";
import { readMeta } from "./sqlRepositories.js";
import { cacheStatements } from "./statementCache.js";
import {SqlActivity,trackTransactions} from './sqlActivity.js';
import { BusinessRuntime } from "./businessRuntime.js";
import { AgentRepository, AGENT_READER_METHODS } from "./agentRepository.js";
import { importLegacy } from "./importLegacy.js";
import { randomUUID } from "node:crypto";
import { operationContext, checkOperation } from "../services/shared/operationContext.js";
import { isAcquisitionWorkflow } from "./config.js";
import {assertStorageVolume} from './volumeGuard.js';
import {storageExecutionContext,walWriteGuard} from './walPressure.js';
import {nativeThreadId} from './nativeWait.js';
const nativeId=nativeThreadId();
let database, migrations, version, runtime;
let diagnostics,lastDiagnosticsCompletedAt=0,lastCompletedCommand,lastFailedCommand;
const activeCommands=new Map();
let commandEpoch=0;
const workflows=new Map();
function telemetry(){
  if(!workerData.businessEnabled && !diagnostics){diagnostics=readDatabaseDiagnostics(database);lastDiagnosticsCompletedAt=Date.now();}
  const memory=process.memoryUsage();
  parentPort.postMessage({type:"telemetry",worker:{threadId,walBytes:size(`${workerData.databasePath}-wal`),heartbeatAt:new Date().toISOString(),memory:{heapUsed:memory.heapUsed,heapTotal:memory.heapTotal,external:memory.external},activeCommands:[...activeCommands.values()],lastCompletedCommand,lastFailedCommand,database:diagnostics,rss:runtime?.rssDiagnostics || null,eventIndex:runtime?.registryDiagnostics || null,news:{corpus:runtime?.newsCorpus?.lastDiagnostics ? {...runtime.newsCorpus.lastDiagnostics,payloadCache:runtime.newsCorpus.payloadCache.status()} : null,collection:runtime?.newsPipeline?.diagnostics || null,projection:runtime?.newsPipeline?.projectionDiagnostics || null,supplemental:runtime?.newsPipeline?.supplementalDiagnostics || null}}});
  // Historical counts are read work, never part of the business writer's
  // heartbeat. Sample only an idle reader, and schedule from completion: a cold
  // sample taking longer than the interval must not trigger continuous rescans.
  const canSample=workerData.analysisWorker ? runtime?.services && !activeCommands.size : !workerData.businessEnabled;
  if(canSample && (!diagnostics || Date.now()-lastDiagnosticsCompletedAt>=RUNTIME_POLICY.storage.diagnosticsIntervalMs)){
    diagnostics=readDatabaseDiagnostics(database);lastDiagnosticsCompletedAt=Date.now();
  }
}
const rpcPending=new Map();
function rpc(operation,input){return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{rpcPending.delete(id);reject(Object.assign(new Error("Provider deadline"),{code:"STORAGE_PROVIDER_TIMEOUT"}));},RUNTIME_POLICY.storage.providerTimeoutMs);rpcPending.set(id,{resolve,reject,timer});parentPort.postMessage({type:"rpc",id,operation,input});});}
const fail = code => { throw Object.assign(new Error(code), { code }); };
function size(file) { try { return statSync(file).size; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } }
function status() {
  return { nativeThreadId:nativeId,readOnlyConnection:database.readonly,queryOnly:database.pragma("query_only",{simple:true}) === 1,sqliteVersion: version, synchronous:database.pragma("synchronous",{simple:true}),autoCheckpoint:database.pragma("wal_autocheckpoint",{simple:true}),migrations, databaseBytes: size(workerData.databasePath), walBytes: size(`${workerData.databasePath}-wal`), businessStorage: readMeta(database,"businessStorage",workerData.businessEnabled ? "sqlite" : "legacy-json"), storagePhase: readMeta(database,"businessStorage",workerData.businessEnabled ? "sqlite" : "legacy-json") === "sqlite" ? "repositories" : "infrastructure" };
}
function pipelineRecord(input) {
  if (!input || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.runId || "") || !/^[a-z-]{1,64}$/.test(input.pipelineId || "")) fail("STORAGE_INVALID_COMMAND");
  if (!["running","healthy","degraded","failed","stopped"].includes(input.status)) fail("STORAGE_INVALID_COMMAND");
  for (const value of [input.startedAt, input.completedAt].filter(v => v !== undefined && v !== null)) if (!Number.isFinite(Date.parse(value))) fail("STORAGE_INVALID_COMMAND");
  if (!input.startedAt || !input.counts || Array.isArray(input.counts) || typeof input.counts !== "object" || Object.entries(input.counts).length > 20 || Object.entries(input.counts).some(([key,value]) => !/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key) || !Number.isSafeInteger(value) || value < 0)) fail("STORAGE_INVALID_COMMAND");
  if (input.errorCode != null && !/^[A-Z0-9_]{1,64}$/.test(input.errorCode)) fail("STORAGE_INVALID_COMMAND");
  database.prepare(`INSERT INTO pipeline_runs VALUES(?,?,?,?,?,?,?)`).run(input.runId,input.pipelineId,input.startedAt,input.completedAt || null,input.status,JSON.stringify(input.counts),input.errorCode || null);
  return { runId: input.runId, persisted: true };
}
function execute(operation, input, requestId, commandId) {
  if(operation === "agent.read"){
    if(!workerData.analysisWorker || !AGENT_READER_METHODS.has(input.method))fail("STORAGE_INVALID_COMMAND");
    runtime.agent ||= new AgentRepository(runtime);
    return runtime.agent.call(input.method,input.args);
  }
  if(operation === "agent.snapshot") {
    if(!workerData.analysisWorker)fail("STORAGE_INVALID_COMMAND");
    return prepareAgentSnapshot(input,commandId);
  }
  if(operation === "agent.call") {
    if(workerData.analysisWorker)fail("STORAGE_READ_ONLY");
    runtime.agent ||= new AgentRepository(runtime);
    return runtime.agent.call(input.method,input.args);
  }
  if(operation.startsWith("market.persist.")){
    if(workerData.analysisWorker && !["market.persist.status","market.persist.pending"].includes(operation))fail("STORAGE_READ_ONLY");
    runtime.candleWriteJobs ||= new CandleWriteJobs(runtime);return runtime.candleWriteJobs[operation.split(".").at(-1)](input);
  }
  if(operation.startsWith("snapshot.")) {
    if(workerData.analysisWorker)fail("STORAGE_READ_ONLY");
    const method=operation.slice(9);
    if(method==="prepare")return runtime.advancedSnapshots.prepare(input);
    if(method==="claim")return runtime.advancedSnapshots.claim(input);
    if(method==="renew")return runtime.advancedSnapshots.renew(input);
    if(method==="recover")return runtime.advancedSnapshots.recoverExpired();
    if(method==="fail")return runtime.advancedSnapshots.fail(input);
    if(method==="pending")return runtime.advancedSnapshots.pending();
    fail("STORAGE_UNKNOWN_OPERATION");
  }
  if(operation === "analysis.persist")return runtime.persistDerived(input);
  if(operation === "scenarios.prepare") {
    if(!workerData.analysisWorker)fail("STORAGE_INVALID_COMMAND");
    return runtime.services.scenarios.prepare(input);
  }
  if(operation === "domain.indexPage") return runtime.indexPage(input);
  if(operation === "domain.registry") return runtime.registry(input.instruments);
  if(operation === "domain.configure") {
    const result=runtime.configure(input);
    if(workerData.analysisWorker)database.pragma("query_only=ON");
    return result;
  }
  if(operation === "domain.call") {
    if(workerData.analysisWorker&&workerData.readerRole==='queries'&&!storageOperationContract(operation,input).pureRead)fail("STORAGE_READ_ONLY");
    if(input.service === "admin" && input.method === "history") return runtime.adminHistory(input.args?.[0]);
    if(input.service === "admin" && input.method === "historyRevision") return runtime.adminHistoryRevision(input.args?.[0]);
    return runtime.call({...input,requestId});
  }
  if(operation === "storage.import") return importLegacy(database,runtime,input);
  if(operation === "runtime.save") return runtime.save(input.kind,input.payload);
  if(operation === "runtime.load") return runtime.load(input.kind,input.options);
  if(operation === "rss.fetch") return runtime.fetchRss(input);
  if(operation === "news.collect") return runtime.newsPipeline.collect(input);
  if(operation === "news.supplemental") return runtime.newsPipeline.collectSupplemental();
  if (operation === "storage.status") return { ...status(), checkpoints:database.prepare("SELECT pipeline_id AS pipelineId,updated_at AS updatedAt,revision FROM pipeline_checkpoints ORDER BY pipeline_id").all(), pipelines: database.prepare("SELECT pipeline_id AS pipelineId,storage_backend AS storageBackend FROM pipeline_definitions ORDER BY pipeline_id").all() };
  if (operation === "storage.verify") return { integrity: database.pragma("integrity_check"), foreignKeys: database.pragma("foreign_key_check") };
  if (operation === "storage.checkpoint") fail('STORAGE_CHECKPOINT_ISOLATED');
  if (operation === "pipeline.record") return pipelineRecord(input);
  fail("STORAGE_UNKNOWN_OPERATION");
}
async function prepareAgentSnapshot(auth,commandId){
  runtime.agent ||= new AgentRepository(runtime);
  const frozen=Object.fromEntries(['evidence','clusters','members'].map(table=>[table,new FrozenRows()]));
  const maxBytes=frozen.evidence.maxBytes;let capturedBytes=0;
  try {
    const captureStarted=performance.now();
    const prepared=runtime.agent.prepareSnapshot(auth,{rowSink:(table,row)=>{
      const spool=frozen[table],before=spool.bytes;
      spool.maxBytes=spool.bytes+maxBytes-capturedBytes;
      spool.add(row);capturedBytes+=spool.bytes-before;
    }});
    parentPort.postMessage({type:'command-phase',id:commandId,phase:'capture-completed',captureMs:performance.now()-captureStarted});
    if(prepared.existing)return prepared.existing;
    const write=input=>rpc("analysis.persist",{type:"agent-snapshot",input:{...auth,...input}});
    while((await write({phase:'cleanup'})).hasMore)await new Promise(resolve=>setImmediate(resolve));
    const {rows,...descriptor}=prepared;
    await write({phase:"begin",prepared:descriptor,counts:Object.fromEntries(Object.entries(rows).map(([table,values])=>[table,values.length]))});
    let page=0;
    // Capture may alternate clusters and members. Publish each table together
    // so that alternation cannot turn every row into a separate FULL commit.
    for(const [table,spool]of Object.entries(frozen)){
      let batch=[],bytes=0;
      const flush=async()=>{if(!batch.length)return;await write({phase:"page",snapshotId:prepared.snapshotId,table,page:page++,rows:batch});batch=[];bytes=0;};
      for(const row of spool.rows()){
        const size=Buffer.byteLength(JSON.stringify(row));
        if(size>4*1024*1024)fail("STORAGE_COMMAND_TOO_LARGE");
        if(batch.length && (batch.length>=100 || bytes+size>128000))await flush();
        batch.push(row);bytes+=size;
      }
      await flush();
    }
    return await write({phase:"seal",snapshotId:prepared.snapshotId,page});
  }finally{for(const spool of Object.values(frozen))spool.close();}
}

try {
  if(!workerData.analysisWorker)assertStorageVolume(workerData.databasePath);
  mkdirSync(path.dirname(workerData.databasePath), { recursive: true, mode: 0o700 });
  database = new Database(workerData.databasePath, { readonly:workerData.analysisWorker, fileMustExist:workerData.analysisWorker, timeout: workerData.busyTimeoutMs });
  if(!workerData.analysisWorker)chmodSync(workerData.databasePath, 0o600);
  version = database.prepare("SELECT sqlite_version() AS v").get().v;
  const [major, minor, patch] = version.split(".").map(Number);
  if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) fail("STORAGE_SQLITE_VERSION");
  if (database.pragma(workerData.analysisWorker ? "journal_mode" : "journal_mode=WAL", { simple: true }) !== "wal") fail("STORAGE_WAL_UNAVAILABLE");
  database.pragma("synchronous=FULL"); database.pragma("foreign_keys=ON");
  if(!workerData.analysisWorker)database.pragma('wal_autocheckpoint=0');
  if(workerData.analysisWorker){database.pragma("query_only=ON");migrations=database.prepare("SELECT version,name,applied_at AS appliedAt FROM schema_migrations ORDER BY version").all();}
  else {assertWriterAvailable(database);migrations = migrate(database, workerData.migrationsDir);acquireWriter(database,workerData.writerToken);}
  const activity=workerData.analysisWorker?null:new SqlActivity(workerData.sqlActivityBuffer);
  if(activity && workerData.commitBuffer)activity.commits=new CommitActivity(workerData.commitBuffer);
  const beforeWrite=workerData.analysisWorker?null:walWriteGuard(database,workerData.walPressureBuffer);
  cacheStatements(database,256,{activity,beforeWrite,onSlow:(sql,durationMs)=>log.warn("storage_slow_sql",{threadId,readOnly:workerData.analysisWorker,durationMs:Math.round(durationMs),sql:sql.replace(/'(?:''|[^'])*'/g,"?").slice(0,240)})});
  if(activity)trackTransactions(database,activity,{beforeBegin:beforeWrite,onSlowCommit:durationMs=>log.warn('storage_slow_commit',{threadId,durationMs:Math.round(durationMs),synchronous:'FULL',autoCheckpoint:0})});
  runtime=new BusinessRuntime(database,rpc,(id,stage)=>parentPort.postMessage({type:"stage",id,stage}));
  parentPort.postMessage({ type: "ready", status: status() });
  telemetry();const heartbeat=setInterval(()=>{try{telemetry();}catch(error){log.warn("storage_diagnostics_failed",{code:error.code});}},5000);heartbeat.unref();
  parentPort.on("message", async envelope => {
    if(envelope.type==="cancel-workflow"){
      workflows.get(envelope.id)?.abort(Object.assign(new Error("Acquisition stopped at a safe boundary"),{code:"STORAGE_WORKFLOW_STALLED"}));return;
    }
    if(envelope.type === "rpc-result") {
      const pending=rpcPending.get(envelope.id); if(!pending)return;
      rpcPending.delete(envelope.id);clearTimeout(pending.timer);
      if(envelope.error)pending.reject(Object.assign(new Error(envelope.error.code),envelope.error));else pending.resolve(envelope.result);return;
    }
    const message = JSON.parse(envelope.encoded);
    message.id = envelope.id;
    if (message.operation === "storage.close") {
      clearInterval(heartbeat);
      try { storageExecutionContext.run({control:true},()=>{runtime?.close(); if(!workerData.analysisWorker)releaseWriter(database,workerData.writerToken); database.close();}); parentPort.postMessage({ id: message.id, result: { closed: true } }); parentPort.close(); }
      catch { parentPort.postMessage({ id: message.id, error: { code: "STORAGE_CLOSE_FAILED" } }); }
      return;
    }
    try {
      // An expired message may have waited behind synchronous SQLite work.
      // Reject it before announcing execution or performing any write.
      if(Number.isFinite(envelope.queueDeadline) && Date.now()>=envelope.queueDeadline)fail("STORAGE_QUEUE_TIMEOUT");
      const start = performance.now();
      // Attribute thread CPU only when no other command overlaps this interval.
      const epoch=++commandEpoch;
      const cpuStart = workerData.analysisWorker && !activeCommands.size && typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : null;
      const agentInput=message.operation==='agent.call'?message.input.args:message.input;
      const command={operation:message.operation,service:message.input?.service || null,method:message.input?.method || null,kind:message.input?.kind || null,
        jobId:typeof agentInput?.jobId==='string'?agentInput.jobId.slice(0,128):null,fence:Number.isSafeInteger(agentInput?.fence)?agentInput.fence:null,startedAt:new Date().toISOString()};
      activeCommands.set(message.id,command);parentPort.postMessage({type:"command-started",id:message.id,startedAt:Date.now()});
      let result;runtime.lastCommitMs=null;runtime.lastValidationMs=null;
      await storageExecutionContext.run({control:storageOperationContract(message.operation,message.input).workClass==='control'},async()=>{
      if (["pipeline.record","runtime.save"].includes(message.operation)) {
        const requestId = message.requestId;
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId || "")) fail("STORAGE_INVALID_REQUEST_ID");
        const hash = stableHash([message.operation,message.input]);
        result = database.transaction(() => {
          const previous = database.prepare("SELECT * FROM storage_commands WHERE request_id=?").get(requestId);
          if (previous) { if (previous.input_hash !== hash) fail("STORAGE_IDEMPOTENCY_CONFLICT"); return JSON.parse(previous.result_json); }
          const value = execute(message.operation,message.input,message.requestId,message.id);
          database.prepare("INSERT INTO storage_commands VALUES(?,?,?,?,?)").run(requestId,message.operation,hash,JSON.stringify(value),new Date().toISOString());
          return value;
        }).immediate();
      } else if(isAcquisitionWorkflow(message.operation,message.input)){
        const controller=new AbortController();workflows.set(message.id,controller);let completed=0;
        result=await operationContext.run({signal:controller.signal,committed:count=>{
          completed+=count;parentPort.postMessage({type:"command-progress",id:message.id,completed,at:Date.now()});
        }},async()=>{const value=await execute(message.operation,message.input,message.requestId,message.id);checkOperation();return value;});
      } else { result = await execute(message.operation,message.input,message.requestId,message.id); }
      });
      const cpu = cpuStart && epoch===commandEpoch ? process.threadCpuUsage(cpuStart) : null;
      const cpuMs = cpu ? (cpu.user + cpu.system) / 1000 : null;
      parentPort.postMessage({ id: message.id, result, durationMs: performance.now() - start, cpuMs, outputBytes:Buffer.byteLength(JSON.stringify(result ?? null)),commitMs:runtime.lastCommitMs ?? null,validationMs:runtime.lastValidationMs ?? null, status: status() });
      lastCompletedCommand={...command,completedAt:new Date().toISOString(),durationMs:performance.now()-start,cpuMs};
    } catch (error) {
      lastFailedCommand={...activeCommands.get(message.id),failedAt:new Date().toISOString(),code:error.code || "STORAGE_COMMAND_FAILED"};
      log.error("storage_command_failed",{operation:message.operation,service:message.input?.service,method:message.input?.method,jobId:activeCommands.get(message.id)?.jobId,fence:activeCommands.get(message.id)?.fence,code:error.code || "STORAGE_COMMAND_FAILED",stack:error.stack});
      const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code || "") ? error.code : "STORAGE_COMMAND_FAILED";
      parentPort.postMessage({ id: message.id, error: { code, statusCode: error.statusCode || 503, message: error.statusCode < 500 ? error.message : code, causeCode: error.causeCode, diagnostic: error.diagnostic,details:error.statusCode<500?error.details:null } });
    }finally{activeCommands.delete(message.id);workflows.delete(message.id);}
  });
} catch (error) {
  try { if(database&&!workerData.analysisWorker)releaseWriter(database,workerData.writerToken); database?.close(); } catch { /* startup failure already propagated */ }
  parentPort.postMessage({ type: "failed", error: { code: /^(STORAGE_|SQLITE_|EACCES|ENOENT|ENOSPC)[A-Z0-9_]*$/.test(error.code || "") ? error.code : "STORAGE_START_FAILED" } });
  parentPort.close();
}
