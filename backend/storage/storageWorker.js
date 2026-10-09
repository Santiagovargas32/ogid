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
import { importLegacy } from "./importLegacy.js";
import { randomUUID } from "node:crypto";
let database, migrations, version, runtime;
let diagnostics,lastCompletedCommand,lastFailedCommand;
const activeCommands=new Map();
function telemetry(){
  if(!diagnostics || Date.now()-Date.parse(diagnostics.sampledAt)>=30000)diagnostics=readDatabaseDiagnostics(database);
  const memory=process.memoryUsage();
  parentPort.postMessage({type:"telemetry",worker:{threadId,heartbeatAt:new Date().toISOString(),memory:{heapUsed:memory.heapUsed,heapTotal:memory.heapTotal,external:memory.external},activeCommands:[...activeCommands.values()],lastCompletedCommand,lastFailedCommand,database:diagnostics,rss:runtime?.rssDiagnostics || null,news:{corpus:runtime?.newsCorpus?.lastDiagnostics || null,collection:runtime?.newsPipeline?.diagnostics || null,projection:runtime?.newsPipeline?.projectionDiagnostics || null,supplemental:runtime?.newsPipeline?.supplementalDiagnostics || null}}});
}
const rpcPending=new Map();
function rpc(operation,input){return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{rpcPending.delete(id);reject(Object.assign(new Error("Provider deadline"),{code:"STORAGE_PROVIDER_TIMEOUT"}));},120000);rpcPending.set(id,{resolve,reject,timer});parentPort.postMessage({type:"rpc",id,operation,input});});}
const fail = code => { throw Object.assign(new Error(code), { code }); };
function size(file) { try { return statSync(file).size; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } }
function status() {
  return { sqliteVersion: version, migrations, databaseBytes: size(workerData.databasePath), walBytes: size(`${workerData.databasePath}-wal`), businessStorage: readMeta(database,"businessStorage",workerData.businessEnabled ? "sqlite" : "legacy-json"), storagePhase: readMeta(database,"businessStorage",workerData.businessEnabled ? "sqlite" : "legacy-json") === "sqlite" ? "repositories" : "infrastructure" };
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
function execute(operation, input) {
  if(operation === "domain.registry") return runtime.registry(input.instruments);
  if(operation === "domain.configure") return runtime.configure(input);
  if(operation === "domain.call") {
    if(input.service === "admin" && input.method === "history") return runtime.adminHistory();
    return runtime.call(input);
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
try {
  mkdirSync(path.dirname(workerData.databasePath), { recursive: true, mode: 0o700 });
  database = new Database(workerData.databasePath, { timeout: workerData.busyTimeoutMs });
  chmodSync(workerData.databasePath, 0o600);
  version = database.prepare("SELECT sqlite_version() AS v").get().v;
  const [major, minor, patch] = version.split(".").map(Number);
  if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) fail("STORAGE_SQLITE_VERSION");
  if (database.pragma("journal_mode=WAL", { simple: true }) !== "wal") fail("STORAGE_WAL_UNAVAILABLE");
  database.pragma("synchronous=FULL"); database.pragma("foreign_keys=ON");
  migrations = migrate(database, workerData.migrationsDir);
  cacheStatements(database);
  runtime=new BusinessRuntime(database,rpc);
  parentPort.postMessage({ type: "ready", status: status() });
  telemetry();const heartbeat=setInterval(()=>{try{telemetry();}catch(error){log.warn("storage_diagnostics_failed",{code:error.code});}},5000);heartbeat.unref();
  parentPort.on("message", async envelope => {
    if(envelope.type === "rpc-result") {
      const pending=rpcPending.get(envelope.id); if(!pending)return;
      rpcPending.delete(envelope.id);clearTimeout(pending.timer);
      if(envelope.error)pending.reject(Object.assign(new Error(envelope.error.code),envelope.error));else pending.resolve(envelope.result);return;
    }
    const message = JSON.parse(envelope.encoded);
    message.id = envelope.id;
    if (message.operation === "storage.close") {
      clearInterval(heartbeat);
      try { runtime?.close(); database.close(); parentPort.postMessage({ id: message.id, result: { closed: true } }); parentPort.close(); }
      catch { parentPort.postMessage({ id: message.id, error: { code: "STORAGE_CLOSE_FAILED" } }); }
      return;
    }
    try {
      const start = performance.now();
      const command={operation:message.operation,service:message.input?.service || null,method:message.input?.method || null,kind:message.input?.kind || null,startedAt:new Date().toISOString()};
      activeCommands.set(message.id,command);parentPort.postMessage({type:"command-started",id:message.id,startedAt:Date.now()});
      let result;
      if (message.operation === "pipeline.record") {
        const requestId = message.requestId;
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId || "")) fail("STORAGE_INVALID_REQUEST_ID");
        const hash = stableHash([message.operation,message.input]);
        result = database.transaction(() => {
          const previous = database.prepare("SELECT * FROM storage_commands WHERE request_id=?").get(requestId);
          if (previous) { if (previous.input_hash !== hash) fail("STORAGE_IDEMPOTENCY_CONFLICT"); return JSON.parse(previous.result_json); }
          const value = execute(message.operation,message.input);
          database.prepare("INSERT INTO storage_commands VALUES(?,?,?,?,?)").run(requestId,message.operation,hash,JSON.stringify(value),new Date().toISOString());
          return value;
        }).immediate();
      } else { result = await execute(message.operation,message.input); }
      parentPort.postMessage({ id: message.id, result, durationMs: performance.now() - start, status: status() });
      lastCompletedCommand={...command,completedAt:new Date().toISOString(),durationMs:performance.now()-start};
    } catch (error) {
      lastFailedCommand={...activeCommands.get(message.id),failedAt:new Date().toISOString(),code:error.code || "STORAGE_COMMAND_FAILED"};
      log.error("storage_command_failed",{operation:message.operation,service:message.input?.service,method:message.input?.method,code:error.code || "STORAGE_COMMAND_FAILED",stack:error.stack});
      const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code || "") ? error.code : "STORAGE_COMMAND_FAILED";
      parentPort.postMessage({ id: message.id, error: { code, statusCode: error.statusCode || 503, message: error.statusCode < 500 ? error.message : code } });
    }finally{activeCommands.delete(message.id);}
  });
} catch (error) {
  try { database?.close(); } catch { /* startup failure already propagated */ }
  parentPort.postMessage({ type: "failed", error: { code: /^(STORAGE_|SQLITE_|EACCES|ENOENT|ENOSPC)[A-Z0-9_]*$/.test(error.code || "") ? error.code : "STORAGE_START_FAILED" } });
  parentPort.close();
}
