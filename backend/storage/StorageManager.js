import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { storageConfig } from "./config.js";
const error = code => Object.assign(new Error(code), { code, statusCode: 503 });
const OPERATIONS = new Set(["storage.status", "storage.verify", "storage.checkpoint", "pipeline.record", "domain.configure", "domain.registry", "domain.call", "storage.import", "runtime.save", "runtime.load", "rss.fetch", "news.collect", "news.supplemental"]);
const CPU_SERVICES = new Set(["technical","indicators","conditions","advanced","map","portfolio","scenarios","forecasts","coupling","signals"]);

export class StorageManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = storageConfig(options);
    this.state = this.options.enabled ? "new" : "disabled";
    this.queue = []; this.active = new Map(); this.pendingBytes = 0; this.metadata = {};
    this.metrics = { completed: 0, rejected: 0, failed: 0, lastDurationMs: null, lastErrorCode: null };
  }
  getStatus() {
    return { state: this.state, ...this.metadata, businessStorage: this.metadata.businessStorage || (this.options.businessEnabled ? "sqlite" : "legacy-json"), storagePhase: this.metadata.storagePhase || (this.options.businessEnabled ? "repositories" : "infrastructure"),
      databasePath:this.options.databasePath, worker:this.workerDiagnostics || null, lastExpiredCommand:this.lastExpiredCommand || null,
      activeCommands:[...this.active.values()].map(entry=>({...entry.diagnostic,phase:entry.startedAt?"executing":"dispatched",queuedAt:new Date(entry.queuedAt).toISOString(),elapsedMs:Date.now()-entry.queuedAt,executionMs:entry.startedAt?Date.now()-entry.startedAt:null,timeoutMs:entry.timeoutMs,queueTimeoutMs:entry.queueTimeoutMs})),
      queue: { pending: this.queue.length, inFlight: this.active.size, cpuInFlight:[...this.active.values()].filter(entry=>entry.cpu).length,maxCpuInFlight:this.options.maxCpuInFlight,bytes: this.pendingBytes, maxItems: this.options.queueMaxItems, maxBytes: this.options.queueMaxBytes, maxCommandBytes: this.options.maxCommandBytes }, ...this.metrics };
  }
  async start() {
    if (this.state === "disabled" || this.state === "ready") return this.getStatus();
    if (this.state === "starting") return this.startPromise;
    if (this.state !== "new") throw error("STORAGE_NOT_READY");
    this.state = "starting";
    this.startPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.startTimer = setTimeout(() => this.fail(error("STORAGE_START_TIMEOUT")), this.options.startupTimeoutMs);
    try {
      this.worker = new Worker(new URL("./storageWorker.js", import.meta.url), { workerData: this.options, execArgv: [] });
      this.worker.on("message", message => this.handleMessage(message));
      this.worker.on("error", () => this.fail(error("STORAGE_WORKER_FAILED")));
      this.worker.on("exit", code => {
        if (this.state === "closed" || this.state === "failed") return;
        if (this.state === "closing" && !this.active.size && !this.queue.length && code === 0) { this.state = "closed"; this.closeResolve?.(); }
        else this.fail(error("STORAGE_WORKER_EXITED"));
      });
    } catch { this.fail(error("STORAGE_START_FAILED")); }
    return this.startPromise;
  }
  request(operation, input = {}, { requestId = randomUUID(), timeoutMs = this.options.timeoutMs, queueTimeoutMs = this.options.queueTimeoutMs } = {}) {
    if (!OPERATIONS.has(operation)) return Promise.reject(error("STORAGE_UNKNOWN_OPERATION"));
    if (this.state !== "ready") return Promise.reject(error("STORAGE_NOT_READY"));
    let encoded;
    try { encoded = JSON.stringify({ operation, input, requestId }); } catch { return Promise.reject(error("STORAGE_INVALID_COMMAND")); }
    const bytes = Buffer.byteLength(encoded);
    if (bytes > this.options.maxCommandBytes) {
      this.metrics.rejected++;
      const reason = error("STORAGE_COMMAND_TOO_LARGE");
      reason.diagnostic = {operation,service:input.service || null,method:input.method || null,kind:input.kind || null,bytes,maxCommandBytes:this.options.maxCommandBytes};
      return Promise.reject(reason);
    }
    if (this.queue.length + this.active.size >= this.options.queueMaxItems || this.pendingBytes + bytes > this.options.queueMaxBytes) {
      this.metrics.rejected++; return Promise.reject(error("STORAGE_BACKPRESSURE"));
    }
    return new Promise((resolve, reject) => {
      const slow = ["rss.fetch", "news.collect", "news.supplemental"].includes(operation) || (operation === "domain.call" && (["rss","advanced","map"].includes(input.service) || ["run","import"].includes(input.method)));
      const cpu = operation === "domain.call" && (CPU_SERVICES.has(input.service) || (input.service === "news" && ["getProjection","getFeed","getLiveFeed"].includes(input.method)));
      const entry = { id: randomUUID(), encoded, bytes, resolve, reject, slow, cpu, queuedAt:Date.now(),timeoutMs,queueTimeoutMs,diagnostic:{operation,service:input.service || null,method:input.method || null,kind:input.kind || null} };
      entry.timer = setTimeout(() => this.expire(entry), queueTimeoutMs);
      this.pendingBytes += bytes; this.queue.push(entry); this.pump();
    });
  }
  pump() {
    if (!["ready", "closing"].includes(this.state)) return;
    while (this.queue.length && this.active.size < this.options.maxInFlight) {
      const slowCount=[...this.active.values()].filter(e=>e.slow).length;
      const cpuCount=[...this.active.values()].filter(e=>e.cpu).length;
      const index=this.queue.findIndex(e=>(!e.slow || slowCount < Math.min(2,this.options.maxInFlight)) && (!e.cpu || cpuCount<this.options.maxCpuInFlight));
      if(index < 0)break;
      const [entry] = this.queue.splice(index,1); this.active.set(entry.id, entry);
      entry.dispatchedAt=Date.now();
      try { this.worker.postMessage({ id: entry.id, encoded: entry.encoded }); }
      catch { this.fail(error("STORAGE_WORKER_FAILED")); return; }
    }
    if (this.state === "closing" && !this.active.size && !this.queue.length) this.sendClose();
  }
  handleMessage(message) {
    if (["failed", "closed"].includes(this.state)) return;
    if(message.type==="telemetry"){this.workerDiagnostics=message.worker;return;}
    if(message.type==="command-started"){
      const entry=this.active.get(message.id);
      if(entry){
        entry.startedAt=message.startedAt;clearTimeout(entry.timer);
        entry.timer=setTimeout(()=>this.expire(entry),Math.max(1,entry.timeoutMs-(Date.now()-message.startedAt)));
      }
      return;
    }
    if (message.type === "rpc") {
      Promise.resolve().then(() => this.rpcHandler?.(message.operation, message.input)).then(
        result => this.worker.postMessage({ type: "rpc-result", id: message.id, result }),
        reason => this.worker.postMessage({ type: "rpc-result", id: message.id, error: { code: reason.code || "PROVIDER_FAILED", statusCode: reason.statusCode || 503 } })
      ).catch(() => {}); return;
    }
    if (message.type === "ready") {
      clearTimeout(this.startTimer); this.metadata = message.status; this.state = "ready";
      this.readyResolve(this.getStatus()); return;
    }
    if (message.type === "failed") { this.fail(error(message.error.code)); return; }
    if (message.id === this.closeId) {
      if (message.error) this.fail(error(message.error.code));
      // Resolve close only after the worker exits and releases its handles.
      return;
    }
    const entry = this.active.get(message.id); if (!entry) return;
    this.active.delete(message.id); clearTimeout(entry.timer); this.pendingBytes -= entry.bytes;
    if (message.error) { this.metrics.failed++; this.metrics.lastErrorCode = message.error.code; entry.reject(Object.assign(error(message.error.code), { statusCode: message.error.statusCode || 503, message: message.error.message || message.error.code })); }
    else { this.metadata = message.status; this.metrics.completed++; this.metrics.lastDurationMs = message.durationMs; entry.resolve(message.result); }
    this.pump();
  }
  expire(entry) {
    this.lastExpiredCommand={...entry.diagnostic,queuedAt:new Date(entry.queuedAt).toISOString(),elapsedMs:Date.now()-entry.queuedAt,executionMs:entry.startedAt?Date.now()-entry.startedAt:null,timeoutMs:entry.startedAt?entry.timeoutMs:entry.queueTimeoutMs,phase:this.active.has(entry.id)?(entry.startedAt?"executing":"dispatched"):"queued"};
    if (this.active.has(entry.id)) { const reason=error("STORAGE_OUTCOME_UNKNOWN");reason.diagnostic=this.lastExpiredCommand;this.fail(reason); return; }
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1); this.pendingBytes -= entry.bytes; this.metrics.failed++;
    entry.reject(error("STORAGE_QUEUE_TIMEOUT"));
  }
  fail(reason) {
    if (["closed", "failed"].includes(this.state)) return;
    this.state = "failed"; clearTimeout(this.startTimer); clearTimeout(this.closeTimer);
    this.metrics.lastErrorCode = reason.code;
    this.readyReject?.(reason); this.closeReject?.(reason);
    this.metrics.failed += this.active.size + this.queue.length;
    for (const entry of this.active.values()) { clearTimeout(entry.timer); entry.reject(error("STORAGE_OUTCOME_UNKNOWN")); }
    this.active.clear();
    for (const entry of this.queue.splice(0)) { clearTimeout(entry.timer); entry.reject(error("STORAGE_WORKER_FAILED")); }
    this.pendingBytes = 0;
    this.termination = this.worker?.terminate();
    this.emit("failed", reason);
  }
  sendClose() {
    if (this.closeId) return;
    this.closeId = randomUUID();
    try { this.worker.postMessage({ id: this.closeId, encoded: JSON.stringify({ operation: "storage.close" }) }); }
    catch { this.fail(error("STORAGE_CLOSE_FAILED")); }
  }
  async close() {
    if (["disabled", "closed", "new"].includes(this.state)) { if (this.state === "new") this.state = "closed"; return; }
    if (this.state === "failed") { await this.termination; return; }
    if (this.state === "starting") { try { await this.startPromise; } catch { await this.termination; return; } }
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise((resolve, reject) => { this.closeResolve = resolve; this.closeReject = reject; });
    this.state = "closing";
    this.closeTimer = setTimeout(() => this.fail(error("STORAGE_CLOSE_TIMEOUT")), this.options.shutdownTimeoutMs);
    this.closePromise.finally(() => clearTimeout(this.closeTimer)).catch(() => {});
    this.pump();
    return this.closePromise;
  }
}
