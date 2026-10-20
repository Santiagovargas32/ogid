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
import { BusinessRuntime } from "./businessRuntime.js";
import { AgentRepository, AGENT_READER_METHODS } from "./agentRepository.js";
import { importLegacy } from "./importLegacy.js";
import { randomUUID } from "node:crypto";
import { operationContext, checkOperation } from "../services/shared/operationContext.js";
import { isAcquisitionWorkflow } from "./config.js";
let database, migrations, version, runtime;
let diagnostics,lastDiagnosticsCompletedAt=0,lastCompletedCommand,lastFailedCommand;
const activeCommands=new Map();
const workflows=new Map();
function telemetry(){
  if(!workerData.businessEnabled && !diagnostics){diagnostics=readDatabaseDiagnostics(database);lastDiagnosticsCompletedAt=Date.now();}
  const memory=process.memoryUsage();
  parentPort.postMessage({type:"telemetry",worker:{threadId,heartbeatAt:new Date().toISOString(),memory:{heapUsed:memory.heapUsed,heapTotal:memory.heapTotal,external:memory.external},activeCommands:[...activeCommands.values()],lastCompletedCommand,lastFailedCommand,database:diagnostics,rss:runtime?.rssDiagnostics || null,news:{corpus:runtime?.newsCorpus?.lastDiagnostics ? {...runtime.newsCorpus.lastDiagnostics,payloadCache:runtime.newsCorpus.payloadCache.status()} : null,collection:runtime?.newsPipeline?.diagnostics || null,projection:runtime?.newsPipeline?.projectionDiagnostics || null,supplemental:runtime?.newsPipeline?.supplementalDiagnostics || null}}});
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
  return { readOnlyConnection:database.readonly,queryOnly:database.pragma("query_only",{simple:true}) === 1,sqliteVersion: version, migrations, databaseBytes: size(workerData.databasePath), walBytes: size(`${workerData.databasePath}-wal`), businessStorage: readMeta(database,"businessStorage",workerData.businessEnabled ? "sqlite" : "legacy-json"), storagePhase: readMeta(database,"businessStorage",workerData.businessEnabled ? "sqlite" : "legacy-json") === "sqlite" ? "repositories" : "infrastructure" };
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
function execute(operation, input, requestId) {
  if(operation === "agent.read"){
    if(!workerData.analysisWorker || !AGENT_READER_METHODS.has(input.method))fail("STORAGE_INVALID_COMMAND");
    runtime.agent ||= new AgentRepository(runtime);
    return runtime.agent.call(input.method,input.args);
  }
  if(operation === "agent.snapshot") {
    if(!workerData.analysisWorker)fail("STORAGE_INVALID_COMMAND");
    return prepareAgentSnapshot(input);
  }
  if(operation === "agent.call") {
    if(workerData.analysisWorker)fail("STORAGE_READ_ONLY");
    runtime.agent ||= new AgentRepository(runtime);
    return runtime.agent.call(input.method,input.args);
  }
  if(operation.startsWith("snapshot.")) {
    if(workerData.analysisWorker)fail("STORAGE_READ_ONLY");
    const method=operation.slice(9);
    if(method==="prepare")return runtime.advancedSnapshots.prepare(input);
    if(method==="claim")return runtime.advancedSnapshots.claim(input.jobId);
    if(method==="fail")return runtime.advancedSnapshots.fail(input);
    if(method==="pending")return runtime.advancedSnapshots.pending();
    fail("STORAGE_UNKNOWN_OPERATION");
  }
  if(operation === "analysis.persist")return runtime.persistDerived(input);
  if(operation === "scenarios.prepare") {
    if(!workerData.analysisWorker)fail("STORAGE_INVALID_COMMAND");
    return runtime.services.scenarios.prepare(input);
  }
  if(operation === "domain.registry") return runtime.registry(input.instruments);
  if(operation === "domain.configure") {
    const result=runtime.configure(input);
    if(workerData.analysisWorker)database.pragma("query_only=ON");
    return result;
  }
  if(operation === "domain.call") {
    if(input.service === "admin" && input.method === "history") return runtime.adminHistory();
    return runtime.call({...input,requestId});
  }
  if(operation === "storage.import") return importLegacy(database,runtime,input);
  if(operation === "runtime.save") return runtime.save(input.kind,input.payload);
  if(operation === "runtime.load") return runtime.load(input.kind);
  if(operation === "rss.fetch") return runtime.fetchRss(input);
  if(operation === "news.collect") return runtime.newsPipeline.collect(input);
  if(operation === "news.supplemental") return runtime.newsPipeline.collectSupplemental();
  if (operation === "storage.status") return { ...status(), checkpoints:database.prepare("SELECT pipeline_id AS pipelineId,updated_at AS updatedAt,revision FROM pipeline_checkpoints ORDER BY pipeline_id").all(), pipelines: database.prepare("SELECT pipeline_id AS pipelineId,storage_backend AS storageBackend FROM pipeline_definitions ORDER BY pipeline_id").all() };
  if (operation === "storage.verify") return { integrity: database.pragma("integrity_check"), foreignKeys: database.pragma("foreign_key_check") };
  if (operation === "storage.checkpoint") return database.pragma("wal_checkpoint(PASSIVE)");
  if (operation === "pipeline.record") return pipelineRecord(input);
  fail("STORAGE_UNKNOWN_OPERATION");
}
async function prepareAgentSnapshot(auth){
  runtime.agent ||= new AgentRepository(runtime);
  const prepared=runtime.agent.prepareSnapshot(auth);
  if(prepared.existing)return prepared.existing;
  const write=input=>rpc("analysis.persist",{type:"agent-snapshot",input:{...auth,...input}});
  const {rows,...descriptor}=prepared;
  await write({phase:"begin",prepared:descriptor,counts:Object.fromEntries(Object.entries(rows).map(([table,values])=>[table,values.length]))});
  let page=0;
  for(const [table,values]of Object.entries(rows)){
    let batch=[],bytes=0;
    const flush=async()=>{if(!batch.length)return;await write({phase:"page",snapshotId:prepared.snapshotId,table,page:page++,rows:batch});batch=[];bytes=0;};
    for(const row of values){
      const size=Buffer.byteLength(JSON.stringify(row));
      if(size>4*1024*1024)fail("STORAGE_COMMAND_TOO_LARGE");
      if(batch.length && (batch.length>=100 || bytes+size>128000))await flush();
      batch.push(row);bytes+=size;
    }
    await flush();
  }
  return write({phase:"seal",snapshotId:prepared.snapshotId,page});
}
try {
  mkdirSync(path.dirname(workerData.databasePath), { recursive: true, mode: 0o700 });
  database = new Database(workerData.databasePath, { readonly:workerData.analysisWorker, fileMustExist:workerData.analysisWorker, timeout: workerData.busyTimeoutMs });
  if(!workerData.analysisWorker)chmodSync(workerData.databasePath, 0o600);
  version = database.prepare("SELECT sqlite_version() AS v").get().v;
  const [major, minor, patch] = version.split(".").map(Number);
  if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) fail("STORAGE_SQLITE_VERSION");
  if (database.pragma(workerData.analysisWorker ? "journal_mode" : "journal_mode=WAL", { simple: true }) !== "wal") fail("STORAGE_WAL_UNAVAILABLE");
  database.pragma("synchronous=FULL"); database.pragma("foreign_keys=ON");
  if(workerData.analysisWorker){database.pragma("query_only=ON");migrations=database.prepare("SELECT version,name,applied_at AS appliedAt FROM schema_migrations ORDER BY version").all();}
  else {assertWriterAvailable(database);migrations = migrate(database, workerData.migrationsDir);acquireWriter(database,workerData.writerToken);}
  cacheStatements(database,256,{onSlow:(sql,durationMs)=>log.warn("storage_slow_sql",{threadId,readOnly:workerData.analysisWorker,durationMs:Math.round(durationMs),sql:sql.replace(/'(?:''|[^'])*'/g,"?").slice(0,240)})});
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
      try { runtime?.close(); if(!workerData.analysisWorker)releaseWriter(database,workerData.writerToken); database.close(); parentPort.postMessage({ id: message.id, result: { closed: true } }); parentPort.close(); }
      catch { parentPort.postMessage({ id: message.id, error: { code: "STORAGE_CLOSE_FAILED" } }); }
      return;
    }
    try {
      // An expired message may have waited behind synchronous SQLite work.
      // Reject it before announcing execution or performing any write.
      if(Number.isFinite(envelope.queueDeadline) && Date.now()>=envelope.queueDeadline)fail("STORAGE_QUEUE_TIMEOUT");
      const start = performance.now();
      // Attribution is valid only on the isolated analysis worker (one command at a time).
      const cpuStart = workerData.analysisWorker && typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : null;
      const command={operation:message.operation,service:message.input?.service || null,method:message.input?.method || null,kind:message.input?.kind || null,startedAt:new Date().toISOString()};
      activeCommands.set(message.id,command);parentPort.postMessage({type:"command-started",id:message.id,startedAt:Date.now()});
      let result;runtime.lastCommitMs=null;
      if (["pipeline.record","runtime.save"].includes(message.operation)) {
        const requestId = message.requestId;
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId || "")) fail("STORAGE_INVALID_REQUEST_ID");
        const hash = stableHash([message.operation,message.input]);
        result = database.transaction(() => {
          const previous = database.prepare("SELECT * FROM storage_commands WHERE request_id=?").get(requestId);
          if (previous) { if (previous.input_hash !== hash) fail("STORAGE_IDEMPOTENCY_CONFLICT"); return JSON.parse(previous.result_json); }
          const value = execute(message.operation,message.input,message.requestId);
          database.prepare("INSERT INTO storage_commands VALUES(?,?,?,?,?)").run(requestId,message.operation,hash,JSON.stringify(value),new Date().toISOString());
          return value;
        }).immediate();
      } else if(isAcquisitionWorkflow(message.operation,message.input)){
        const controller=new AbortController();workflows.set(message.id,controller);let completed=0;
        result=await operationContext.run({signal:controller.signal,committed:count=>{
          completed+=count;parentPort.postMessage({type:"command-progress",id:message.id,completed,at:Date.now()});
        }},async()=>{const value=await execute(message.operation,message.input,message.requestId);checkOperation();return value;});
      } else { result = await execute(message.operation,message.input,message.requestId); }
      const cpu = cpuStart ? process.threadCpuUsage(cpuStart) : null;
      const cpuMs = cpu ? (cpu.user + cpu.system) / 1000 : null;
      parentPort.postMessage({ id: message.id, result, durationMs: performance.now() - start, cpuMs, outputBytes:Buffer.byteLength(JSON.stringify(result ?? null)),commitMs:runtime.lastCommitMs ?? null, status: status() });
      lastCompletedCommand={...command,completedAt:new Date().toISOString(),durationMs:performance.now()-start,cpuMs};
    } catch (error) {
      lastFailedCommand={...activeCommands.get(message.id),failedAt:new Date().toISOString(),code:error.code || "STORAGE_COMMAND_FAILED"};
      log.error("storage_command_failed",{operation:message.operation,service:message.input?.service,method:message.input?.method,code:error.code || "STORAGE_COMMAND_FAILED",stack:error.stack});
      const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code || "") ? error.code : "STORAGE_COMMAND_FAILED";
      parentPort.postMessage({ id: message.id, error: { code, statusCode: error.statusCode || 503, message: error.statusCode < 500 ? error.message : code, causeCode: error.causeCode, diagnostic: error.diagnostic,details:error.statusCode<500?error.details:null } });
    }finally{activeCommands.delete(message.id);workflows.delete(message.id);}
  });
} catch (error) {
  try { if(database&&!workerData.analysisWorker)releaseWriter(database,workerData.writerToken); database?.close(); } catch { /* startup failure already propagated */ }
  parentPort.postMessage({ type: "failed", error: { code: /^(STORAGE_|SQLITE_|EACCES|ENOENT|ENOSPC)[A-Z0-9_]*$/.test(error.code || "") ? error.code : "STORAGE_START_FAILED" } });
  parentPort.close();
}
