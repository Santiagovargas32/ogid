import {CandleWriteCoordinator} from './candleWriteJobs.js';
import { releaseTerminatedWriter } from "./writerOwnership.js";
import { AdvancedCoordinator } from "./advancedSnapshots.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { storageConfig, storageCommandTimeout, storageWorkClass, isAcquisitionWorkflow, isPureRead } from "./config.js";
import { setTimeout as wait } from "node:timers/promises";
import { AGENT_READER_METHODS } from "./agentRepository.js";
import { stableHash } from "../utils/stableHash.js";
import { ScopedWork } from './scopedWork.js';
import { storageOperationContract } from '../contracts/storageOperations.js';
import {RUNTIME_POLICY} from '../config/runtimePolicy.js';
import {createSqlActivityBuffer,readSqlActivity} from './sqlActivity.js';
import {createCommitBuffer} from './commitActivity.js';
import {WalCheckpoint} from './walCheckpoint.js';
import {readNativeWait} from './nativeWait.js';
const error = code => Object.assign(new Error(code), { code, statusCode: 503 });
const commandLabel = value => typeof value === "string" ? value.slice(0,128) : null;
const OPERATIONS = new Set(["agent.call", "agent.snapshot", "agent.read", "storage.status", "storage.verify", "storage.checkpoint", "pipeline.record", "domain.configure", "domain.registry", "domain.indexPage", "domain.call", "scenarios.prepare", "storage.import", "runtime.save", "runtime.load", "rss.fetch", "news.collect", "news.supplemental", "analysis.persist", "snapshot.prepare", "snapshot.claim", "snapshot.fail", "snapshot.pending", "snapshot.renew","snapshot.recover","market.persist.admit","market.persist.page","market.persist.pending","market.persist.status"]);
const ISOLATED_NEWS_METHODS = new Set(["getProjection","getFeed","getLiveFeed","search","getItem","getHistory","coverage","sourceAssessments","sourceAssessment","sourceCoverage","comparisons","comparison","comparisonClaim","comparisonChanges"]);
const CPU_SERVICES = new Set(["market","technical","indicators","conditions","advanced","map","portfolio","scenarios","forecasts","coupling","signals"]);

export class StorageManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {...storageConfig(options),writerToken:randomUUID()};
    this.sqlActivityBuffer=createSqlActivityBuffer();this.commitBuffer=createCommitBuffer();
    this.walPressureBuffer=new SharedArrayBuffer(4);
    this.state = this.options.enabled ? "new" : "disabled";
    this.queue = []; this.active = new Map(); this.pendingBytes = 0; this.metadata = {};
    this.recentCommands = [];this.activeErrors=new Map();
    this.reconciliations = new Map();
    this.reconciliationMetrics = { delayed: 0, resolved: 0 };
    this.metrics = { failuresByCategory:{write:0,query:0,calculation:0,transport:0,worker:0,validation:0}, completed: 0, rejected: 0, failed: 0, lastDurationMs: null, lastErrorCode: null };
  }
  getStatus() {
    const database=this.workerDiagnostics?.database || this.analysisManager?.workerDiagnostics?.database || this.databaseDiagnostics || null;
    if(database)this.databaseDiagnostics=database;
    return { state: this.state, ...this.metadata, businessStorage: this.metadata.businessStorage || (this.options.businessEnabled ? "sqlite" : "legacy-json"), storagePhase: this.metadata.storagePhase || (this.options.businessEnabled ? "repositories" : "infrastructure"),
      analysis:this.analysisManager?.getStatus() || null,
      queries:this.queryManager?.getStatus() || null,queryRecovery:{recovering:Boolean(this.queryRecovery),recoveries:this.queryRecoveries || 0},
      analysisRecovery:{recovering:Boolean(this.analysisRecovery),recoveries:this.analysisRecoveries || 0},
      reconciliation: { pending: this.reconciliations.size > 0, ...this.reconciliationMetrics,
        commands: [...this.reconciliations.values()].map(entry => this.describeCommand(entry, "reconciling")) },
      failure:this.failureContext || null,
      walCheckpoint:this.checkpoint?.status() || null,
      databasePath:this.options.databasePath, worker:this.workerDiagnostics ? {...this.workerDiagnostics,database,sqlActivity:this.failureContext?.sqlActivity||readSqlActivity(this.sqlActivityBuffer)} : null, lastExpiredCommand:this.lastExpiredCommand || null,
      eventIndex:{...(this.eventIndexState||this.workerDiagnostics?.eventIndex||{}),scheduling:this.eventIndexScheduling||null,...(this.eventIndexError?{state:"failed",errorCode:this.eventIndexError}:{})},
      activeCommands:[...this.active.values()].map(entry=>this.describeCommand(entry)),
      queuedCommands:this.queue.slice(0,50).map(entry=>this.describeCommand(entry,"queued")),
      queuedCommandsTruncated:this.queue.length>50,
      recentCommands:this.recentCommands.map(entry=>({...entry})),lastRejectedCommand:this.lastRejectedCommand ? {...this.lastRejectedCommand} : null,
      activeErrors:[...this.activeErrors.values()],jobs:{active:this.advancedCoordinator?.tasks.size || 0,recoveryError:this.advancedCoordinator?.lastRecoveryError||null},marketPersistence:this.marketWrites?.status()||null,
      calculations:{active:this.calculations?.scopes.size || 0,pending:[...(this.calculations?.scopes.values() || [])].filter(scope=>scope.pending).length,bytes:this.calculations?.bytes || 0,maxBytes:this.options.queueMaxBytes,...this.calculations?.metrics},
      queue: { pending: this.queue.length, inFlight: this.active.size, cpuInFlight:[...this.active.values()].filter(entry=>entry.cpu).length,maxCpuInFlight:this.options.maxCpuInFlight,bytes: this.pendingBytes, maxItems: this.options.queueMaxItems, maxBytes: this.options.queueMaxBytes, maxCommandBytes: this.options.maxCommandBytes }, ...this.metrics };
  }
  describeCommand(entry, phase = entry.startedAt ? "executing" : "dispatched") {
    return {...entry.diagnostic,id:entry.id,bytes:entry.bytes,phase,queuedAt:new Date(entry.queuedAt).toISOString(),
      startedAt:entry.startedAt ? new Date(entry.startedAt).toISOString() : null,elapsedMs:Date.now()-entry.queuedAt,
      queueMs:(entry.startedAt || Date.now())-entry.queuedAt,executionMs:entry.startedAt ? Date.now()-entry.startedAt : null,
      timeoutMs:entry.timeoutMs,queueTimeoutMs:entry.queueTimeoutMs,
      captureMs:entry.captureMs ?? null,
      ...(entry.reconciling ? { reconciliationDeadline: new Date(entry.startedAt + this.options.timeoutMs).toISOString() } : {}),
      ...(entry.workflow?{deadlinePolicy:"committed-progress",completedItems:entry.completedItems || 0,lastProgressAt:entry.lastProgressAt?new Date(entry.lastProgressAt).toISOString():null,cancelling:Boolean(entry.cancelling)}:{})};
  }
  recordCommand(entry,status,code=null,timing={}) {
    const record={...this.describeCommand(entry,entry.startedAt?"executing":entry.dispatchedAt?"dispatched":"queued"),status,code,
      finishedAt:new Date().toISOString(),...timing};
    this.recentCommands.push(record);
    if(this.recentCommands.length>50)this.recentCommands.shift();
    return record;
  }
  async start() {
    if (["closing", "closed", "failed"].includes(this.state)) throw error("STORAGE_NOT_READY");
    // All callers wait for both workers, including calls made after the writer
    // has announced readiness but while the analysis worker is still starting.
    if (!this.startTask) {
      this.initializing = true;
      this.startTask = this.startWorkers().finally(()=>{this.initializing=false;});
    }
    return this.startTask;
  }
  async startWorkers() {
    if (this.state === "disabled" || this.state === "ready") return this.getStatus();
    if (this.state === "starting") return this.startPromise;
    if (this.state !== "new") throw error("STORAGE_NOT_READY");
    this.state = "starting";
    this.startPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.startTimer = setTimeout(() => this.fail(error("STORAGE_START_TIMEOUT")), this.options.startupTimeoutMs);
    try {
      this.worker = new Worker(new URL("./storageWorker.js", import.meta.url), { workerData: {...this.options,sqlActivityBuffer:this.sqlActivityBuffer,commitBuffer:this.commitBuffer,walPressureBuffer:this.walPressureBuffer}, execArgv: [] });
      this.worker.on("message", message => this.handleMessage(message));
      this.worker.on("error", () => this.fail(error("STORAGE_WORKER_FAILED")));
      this.worker.on("exit", code => {
        if (this.state === "closed" || this.state === "failed") return;
        if (this.state === "closing" && !this.active.size && !this.queue.length && code === 0) { this.state = "closed"; this.closeResolve?.(); }
        else this.fail(error("STORAGE_WORKER_EXITED"));
      });
    } catch { this.fail(error("STORAGE_START_FAILED")); }
    await this.startPromise;
    if(!this.options.analysisWorker){
      this.checkpoint=new WalCheckpoint(this.options,{pressureBuffer:this.walPressureBuffer,commitBuffer:this.commitBuffer});
      try{await this.checkpoint.start();this.checkpoint.observe(this.metadata.walBytes);await this.checkpoint.request();}
      catch(reason){this.fail(reason);throw reason;}
    }
    if(this.options.businessEnabled&&!this.options.analysisWorker)this.marketWrites=new CandleWriteCoordinator(this);
    if(this.options.businessEnabled && this.options.isolateAnalysis && !this.options.analysisWorker) {
      this.analysisManager = this.createAnalysisManager();
      await this.analysisManager.start();
      this.queryManager = this.createAnalysisManager("queries");
      await this.queryManager.start();
      this.advancedCoordinator=new AdvancedCoordinator(this);
    }
    return this.getStatus();
  }
  createAnalysisManager(role="analysis") {
      // A snapshot releases SQLite before awaiting its writer RPC pages. Keep a
      // second slot for one calculation while those pages are being committed.
      const reader = new StorageManager({...this.options,analysisWorker:true,readerRole:role,maxInFlight:2});
      reader.rpcHandler=(operation,input)=>operation === "analysis.persist"
        ? this.localRequest(operation,input) : this.rpcHandler?.(operation,input);
      if(role==="analysis")reader.on("stage",(...args)=>this.emit("stage",...args));
      reader.on('productive',()=>{this.readerFailureStreak ||= {};this.readerFailureStreak[role]=0;});
      reader.on("failed", reason => {
        this.readerFailureStreak ||= {};this.readerFailureStreak[role]=(this.readerFailureStreak[role]||0)+1;
        if (!["failed", "closed"].includes(this.state)) {
          reason.diagnostic = {...reason.diagnostic, worker: role};
          this.emit("failed", reason);
        }
      });
      return reader;
  }
  recoverAnalysis() {return this.recoverReader("analysis");}
  recoverReader(role="analysis") {
    if(!["analysis","queries"].includes(role))return Promise.reject(error("STORAGE_INVALID_COMMAND"));
    const managerKey=role==="analysis"?"analysisManager":"queryManager",recoveryKey=role==="analysis"?"analysisRecovery":"queryRecovery",abortKey=role==="analysis"?"analysisRecoveryAbort":"queryRecoveryAbort",countKey=role==="analysis"?"analysisRecoveries":"queryRecoveries";
    if(this[recoveryKey])return this[recoveryKey];
    if(this.state!=="ready" || !this.analysisConfig || this.closingRequested)return Promise.reject(error("STORAGE_ANALYSIS_RECOVERY_UNAVAILABLE"));
    if(this[managerKey]?.state!=="failed")return Promise.resolve(this[managerKey]?.getStatus());
    this[abortKey]=new AbortController();
    this[recoveryKey]=(async()=>{
      let attempt=0;
      while(this.state==="ready" && !this.closingRequested){
        const previous=this[managerKey];
        await previous?.termination;
        if(this.state!=="ready" || this.closingRequested)break;
        const failures=Math.max(attempt,(this.readerFailureStreak?.[role]||0)-1);
        if(failures>0){await wait(Math.min(60000,1000*2**Math.min(failures-1,6)),undefined,{signal:this[abortKey].signal}).catch(()=>{});}
        if(this.state!=="ready" || this.closingRequested)break;
        const reader=this.createAnalysisManager(role);this[managerKey]=reader;
        try{
          await reader.start();
          if(this.closingRequested){await reader.close();break;}
          await reader.localRequest("domain.configure",{...this.analysisConfig,analysisOnly:true});
          if(this.closingRequested){await reader.close();break;}
          this[countKey]=(this[countKey] || 0)+1;
          this.emit(role==="analysis"?"analysis-recovered":"queries-recovered",{recoveries:this[countKey]});return reader.getStatus();
        }catch(reason){reader.fail(reason);await reader.termination;attempt++;}
      }
    })().finally(()=>{this[recoveryKey]=null;});
    return this[recoveryKey];
  }
  request(operation, input = {}, { requestId = randomUUID(), timeoutMs = storageCommandTimeout(this.options,operation,input), queueTimeoutMs = this.options.queueTimeoutMs, signal } = {}) {
    if(this.closingRequested)return Promise.reject(error("STORAGE_NOT_READY"));
    if(operation==='agent.call' && input.method==='claim' && this.reconciliations.size)return Promise.reject(error('STORAGE_CONTROL_RECONCILING'));
    if (this.state !== "ready") return this.localRequest(operation,input,{requestId,timeoutMs,queueTimeoutMs});
    // A claim needs the evidence reader next. Keep jobs queued during reader
    // recovery instead of exhausting them in repeated, unstarted attempts.
    if(operation==="agent.call" && input.method==="claim" && this.analysisManager && this.analysisManager.state!=="ready")
      return Promise.reject(Object.assign(error("STORAGE_ANALYSIS_UNAVAILABLE"),{causeCode:this.analysisManager.metrics.lastErrorCode,diagnostic:{worker:"analysis",state:this.analysisManager.state}}));
    if(operation==="agent.call" && input.method==="claim" && this.queryManager && this.queryManager.state!=="ready")
      return Promise.reject(Object.assign(error("STORAGE_QUERIES_UNAVAILABLE"),{diagnostic:{worker:"queries",state:this.queryManager.state}}));
    if(this.analysisManager && operation==="agent.call" && input.method==="snapshot")return this.analysisManager.request("agent.snapshot",input.args,{requestId,timeoutMs:storageCommandTimeout(this.options,"agent.snapshot"),queueTimeoutMs});
    if(this.queryManager && operation==="agent.call" && AGENT_READER_METHODS.has(input.method))return this.queryManager.coalescedRead("agent.read",input,{requestId,timeoutMs:storageCommandTimeout(this.options,"agent.read"),queueTimeoutMs});
    if(this.queryManager && storageOperationContract(operation,input).pureRead && storageOperationContract(operation,input).role==='queries')return this.queryManager.coalescedRead(operation,input,{requestId,timeoutMs,queueTimeoutMs,signal});
    if (this.advancedCoordinator && operation === "domain.call" && input.service === "advanced" && input.method === "getSnapshot") return this.advancedCoordinator.get(input);
    if(this.analysisManager && operation === "domain.call" && input.service === "scenarios" && input.method === "refresh") {
      // Prepare historical reads/calculations on the existing read-only worker.
      // Only the bounded scenario mutations occupy the SQLite writer.
      return this.analysisManager.request("scenarios.prepare",input.args?.[0] || {},{requestId,timeoutMs:Math.min(timeoutMs,storageCommandTimeout(this.options,"scenarios.prepare")),queueTimeoutMs})
        .then(preparedScenarios=>this.localRequest(operation,{...input,preparedScenarios},{requestId,timeoutMs,queueTimeoutMs}));
    }
    if (this.analysisManager && operation === "domain.call" && storageOperationContract(operation,input).role==='analysis') {
      let bytes;try{bytes=Buffer.byteLength(JSON.stringify({operation,input,requestId}));}catch{return Promise.reject(error('STORAGE_INVALID_COMMAND'));}
      if(bytes>this.options.maxCommandBytes)return Promise.reject(error('STORAGE_COMMAND_TOO_LARGE'));
      this.calculations ||= new ScopedWork({maxScopes:this.options.queueMaxItems,maxBytes:this.options.queueMaxBytes});
      const captured=structuredClone(input),scope=stableHash([operation,input.service,input.method,input.args,input.context?.selectedInstrumentIds]);
      return this.calculations.run(scope,stableHash(captured),()=>this.analysisManager.request(operation,captured,{requestId,timeoutMs,queueTimeoutMs}),{bytes}).then(result=>structuredClone(result));
    }
    if (this.analysisManager && ["domain.configure","domain.registry"].includes(operation)) {
      return this.localRequest(operation,input,{requestId,timeoutMs,queueTimeoutMs}).then(async result=>{
        if(operation==="domain.configure")this.analysisConfig={...input};
        else if(this.analysisConfig)this.analysisConfig={...this.analysisConfig,instruments:input.instruments};
        await this.analysisManager.request(operation,{...input,analysisOnly:true},{requestId,timeoutMs,queueTimeoutMs});
        await this.queryManager?.request(operation,{...input,analysisOnly:true},{requestId,timeoutMs,queueTimeoutMs});
        if(operation==="domain.configure")await this.advancedCoordinator?.recover();if(operation==="domain.configure")await this.marketWrites?.recover();this.resumeEventIndex();return result;
      });
    }
    if(!this.options.analysisWorker && ['domain.configure','domain.registry'].includes(operation))return this.localRequest(operation,input,{requestId,timeoutMs,queueTimeoutMs}).then(result=>{this.resumeEventIndex();return result;});
    return this.localRequest(operation,input,{requestId,timeoutMs,queueTimeoutMs});
  }
  deferEventIndex(){this.eventIndexDeferred=true;}
  resumeEventIndex({release=false}={}){
    if(!this.options.businessEnabled)return;
    if(release)this.eventIndexDeferred=false;
    this.eventIndexRequested=true;
    if(this.eventIndexDeferred||this.eventIndexTask||this.closingRequested)return;
    this.eventIndexError=null;this.eventIndexAbort=new AbortController();
    this.eventIndexTask=(async()=>{
      while(this.state==='ready'&&!this.closingRequested&&!this.eventIndexDeferred){
        if(this.active.size||this.queue.length){
          this.eventIndexScheduling={state:'waiting',reason:'business-active'};
          await wait(RUNTIME_POLICY.storage.maintenanceIdlePollMs,undefined,{signal:this.eventIndexAbort.signal});continue;
        }
        this.eventIndexRequested=false;
        this.eventIndexScheduling={state:'running'};
        let result;
        try{result=await this.localRequest('domain.indexPage',{});}
        catch(reason){
          if(reason.code!=='STORAGE_WAL_BACKPRESSURE')throw reason;
          this.eventIndexScheduling={state:'waiting',reason:'wal-checkpoint'};
          await wait(RUNTIME_POLICY.storage.maintenanceIntervalMs,undefined,{signal:this.eventIndexAbort.signal});continue;
        }
        this.eventIndexState=result;
        if(result.state==='ready'&&!result.cleanupPending&&!this.eventIndexRequested){this.eventIndexScheduling={state:'idle'};break;}
        const delay=Math.max(RUNTIME_POLICY.storage.maintenanceIntervalMs,Math.ceil((result.durationMs||0)*9));
        this.eventIndexScheduling={state:'waiting',reason:'io-budget',nextEligibleAt:new Date(Date.now()+delay).toISOString()};
        await wait(delay,undefined,{signal:this.eventIndexAbort.signal});
      }
    })().catch(reason=>{if(!this.closingRequested){this.eventIndexError=reason.code||'STORAGE_INDEX_BUILD_FAILED';this.emit('index-failed',{code:this.eventIndexError});}}).finally(()=>{this.eventIndexTask=null;if(this.eventIndexRequested&&!this.closingRequested&&this.state==='ready')this.resumeEventIndex();});
  }
  coalescedRead(operation,input,options={}){
    this.sharedReads ||= new Map();
    const key=stableHash([operation,input,options.timeoutMs,options.queueTimeoutMs]);
    if(options.signal?.aborted)return Promise.reject(options.signal.reason || error('STORAGE_READ_CANCELLED'));
    let shared=this.sharedReads.get(key);
    if(!shared){
      shared={consumers:0};
      shared.task=this.request(operation,input,{...options,signal:undefined}).finally(()=>this.sharedReads.delete(key));
      this.sharedReads.set(key,shared);
    }
    shared.consumers++;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(fn,value)=>{if(done)return;done=true;shared.consumers--;options.signal?.removeEventListener('abort',abort);fn(value);};
      const abort=()=>finish(reject,options.signal.reason || error('STORAGE_READ_CANCELLED'));
      options.signal?.addEventListener('abort',abort,{once:true});
      shared.task.then(value=>{if(!done)finish(resolve,structuredClone(value));},reason=>finish(reject,reason));
    });
  }
  localRequest(operation, input = {}, { requestId = randomUUID(), timeoutMs = storageCommandTimeout(this.options,operation,input), queueTimeoutMs = this.options.queueTimeoutMs } = {}) {
    const workClass=storageWorkClass(operation,input),control=workClass==='control';
    if(operation==='agent.call' && input.method==='heartbeat')queueTimeoutMs=Math.min(queueTimeoutMs,35000);
    if (!OPERATIONS.has(operation)) return Promise.reject(error("STORAGE_UNKNOWN_OPERATION"));
    if (this.state !== "ready") return Promise.reject(Object.assign(error("STORAGE_NOT_READY"), {
      causeCode: this.metrics.lastErrorCode,
      diagnostic: {state: this.state, worker: this.options.analysisWorker ? "analysis" : "writer", lastErrorCode: this.metrics.lastErrorCode}
    }));
    if(operation==='storage.checkpoint' && !this.options.analysisWorker)return this.checkpoint?.request() || Promise.reject(error('STORAGE_CHECKPOINT_UNAVAILABLE'));
    if(!this.options.analysisWorker && Atomics.load(new Int32Array(this.walPressureBuffer),0)===1 && !control && !isPureRead(operation,input))
      return Promise.reject(error('STORAGE_WAL_BACKPRESSURE'));
    let encoded;
    try { encoded = JSON.stringify({ operation, input, requestId }); } catch { return Promise.reject(error("STORAGE_INVALID_COMMAND")); }
    const bytes = Buffer.byteLength(encoded);
    const agentInput=operation==='agent.call'?input.args:input;
    const diagnostic={operation,requestId:/^[A-Za-z0-9._:-]{1,128}$/.test(requestId||'')?requestId:null,service:commandLabel(input.service),method:commandLabel(input.method),kind:commandLabel(input.kind),
      jobId:typeof agentInput?.jobId==='string'?agentInput.jobId.slice(0,128):null,fence:Number.isSafeInteger(agentInput?.fence)?agentInput.fence:null};
    // Link a delayed heartbeat to its durable heartbeat:<renewalId> receipt.
    // Keep owner, progress and arbitrary command arguments out of diagnostics.
    if(operation==='agent.call'&&input.method==='heartbeat'&&typeof agentInput?.renewalId==='string'&&/^[A-Za-z0-9._:-]{1,160}$/.test(agentInput.renewalId))diagnostic.renewalId=agentInput.renewalId;
    const rejectCommand=code=>{
      this.metrics.rejected++;
      const reason=error(code);
      reason.diagnostic={...diagnostic,bytes,maxCommandBytes:this.options.maxCommandBytes,maxQueueBytes:this.options.queueMaxBytes};
      this.lastRejectedCommand=this.recordCommand({id:randomUUID(),diagnostic,bytes,queuedAt:Date.now(),timeoutMs,queueTimeoutMs},"rejected",code,{maxCommandBytes:this.options.maxCommandBytes,maxQueueBytes:this.options.queueMaxBytes});
      return Promise.reject(reason);
    };
    if (bytes > this.options.maxCommandBytes) {
      return rejectCommand("STORAGE_COMMAND_TOO_LARGE");
    }
    const reserveItems=this.options.queueMaxItems>8?4:0,reserveBytes=Math.min(65536,Math.floor(this.options.queueMaxBytes/8));
    if (this.queue.length + this.active.size >= this.options.queueMaxItems-(control?0:reserveItems) || this.pendingBytes + bytes > this.options.queueMaxBytes-(control?0:reserveBytes)) {
      return rejectCommand("STORAGE_BACKPRESSURE");
    }
    return new Promise((resolve, reject) => {
      const slow = ["rss.fetch", "news.collect", "news.supplemental"].includes(operation) || (operation === "domain.call" && (["rss","advanced","map"].includes(input.service) || ["run","import"].includes(input.method)));
      const cpu = operation === "scenarios.prepare" || (operation === "domain.call" && (CPU_SERVICES.has(input.service) || (input.service === "news" && ISOLATED_NEWS_METHODS.has(input.method))));
      const entry = { id: randomUUID(), encoded, bytes, resolve, reject, slow, cpu,capture:operation==='agent.snapshot',workClass,control,pureRead:this.options.analysisWorker && isPureRead(operation,input),workflow:isAcquisitionWorkflow(operation,input),queuedAt:Date.now(),timeoutMs,queueTimeoutMs,diagnostic:{...diagnostic,workClass} };
      entry.timer = setTimeout(() => this.expire(entry), queueTimeoutMs);
      this.pendingBytes += bytes; this.queue.push(entry); this.pump();
    });
  }
  pump() {
    if (!["ready", "closing"].includes(this.state)) return;
    // Accepted commands retain their slots and outcomes. A delayed renewal is
    // not permission to dispatch another mutation into an uncertain writer.
    if (this.reconciliations.size) return;
    while (this.queue.length && this.active.size < this.options.maxInFlight) {
      const slowCount=[...this.active.values()].filter(e=>e.slow && !e.workflow).length;
      const acquisitionCount=[...this.active.values()].filter(e=>e.workflow).length;
      const cpuCount=[...this.active.values()].filter(e=>e.cpu).length;
      const captureActive=[...this.active.values()].some(e=>e.capture);
      const sqlActive=[...this.active.values()].some(e=>!e.workflow && !e.control && !e.cpu);
      // Network workflows release the writer while awaiting I/O. Admit only one
      // other writer unit so seven dispatched SQL commands cannot queue ahead
      // of a lease renewal inside the worker's mailbox.
      // Shared RSS + primary news may both await the same acquisition. They
      // must not consume the two legacy slow slots and starve other sources.
      // Four cooperative acquisitions still leave room for commits and control.
      const acquisitionLimit=Math.min(4,Math.max(1,this.options.maxInFlight-2));
      const eligible=e=>(e.diagnostic.workClass!=='maintenance'||!this.active.size&&!this.queue.some(other=>other!==e&&other.diagnostic.workClass!=='maintenance'))&&(!e.workflow || acquisitionCount<acquisitionLimit)&&
        (!this.options.analysisWorker || ((!e.capture || cpuCount===0) && (!e.cpu || !captureActive)))&&
        (!e.slow || e.workflow || slowCount<Math.min(2,this.options.maxInFlight))&&
        (e.control || this.options.maxInFlight<=2 || this.active.size<this.options.maxInFlight-1)&&
        (!e.cpu || cpuCount<this.options.maxCpuInFlight)&&(!e.capture || !captureActive)&&
        (this.options.analysisWorker || e.control || e.workflow || e.cpu || !sqlActive);
      const heartbeat=this.queue.findIndex(e=>eligible(e)&&e.control&&e.diagnostic.method==='heartbeat');
      const waitingBusiness=this.queue.findIndex(e=>eligible(e)&&!e.control);
      const urgent=heartbeat>=0?heartbeat:(this.controlBurst || 0)>=4&&waitingBusiness>=0?-1:this.queue.findIndex(e=>eligible(e)&&e.control);
      const aged=this.queue.findIndex(e=>eligible(e)&&Date.now()-e.queuedAt>=1000);
      const quick=this.queue.findIndex(e=>eligible(e)&&!e.slow);
      const index=urgent>=0?urgent:aged>=0?aged:quick>=0?quick:this.queue.findIndex(eligible);
      if(index < 0)break;
      const [entry] = this.queue.splice(index,1);this.controlBurst=entry.control?(this.controlBurst || 0)+1:0; this.active.set(entry.id, entry);
      entry.dispatchedAt=Date.now();
      try { this.worker.postMessage({ id: entry.id, encoded: entry.encoded, queueDeadline:entry.queuedAt+entry.queueTimeoutMs }); }
      catch { this.fail(error("STORAGE_WORKER_FAILED")); return; }
    }
    if (this.state === "closing" && !this.active.size && !this.queue.length) this.sendClose();
  }
  handleMessage(message) {
    if (["failed", "closed"].includes(this.state)) return;
    if(message.type==="stage"){this.emit("stage",message.id,message.stage);return;}
    if(message.type==="telemetry"){this.workerDiagnostics=message.worker;this.checkpoint?.observe(message.worker.walBytes);return;}
    if(message.type==='command-phase'){
      const entry=this.active.get(message.id);
      if(entry && message.phase==='capture-completed'){entry.capture=false;entry.captureMs=message.captureMs;this.pump();}
      return;
    }
    if(message.type==="command-progress"){
      const entry=this.active.get(message.id);
      // Only committed, monotonically advancing acquisition batches renew this
      // watchdog. Worker heartbeats and unrelated operations cannot renew it.
      if(entry?.workflow && entry.startedAt && !entry.cancelling && Number.isSafeInteger(message.completed) && message.completed>(entry.completedItems || 0)){
        entry.completedItems=message.completed;entry.lastProgressAt=Date.now();clearTimeout(entry.timer);
        entry.timer=setTimeout(()=>this.expire(entry),entry.timeoutMs);
      }
      return;
    }
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
        reason => this.worker.postMessage({ type: "rpc-result", id: message.id, error: { code: reason.code || "PROVIDER_FAILED", statusCode: reason.statusCode || 503, causeCode: reason.causeCode, diagnostic: reason.diagnostic } })
      ).catch(() => {}); return;
    }
    if (message.type === "ready") {
      clearTimeout(this.startTimer); this.metadata = message.status; this.state = "ready";this.wasReady=true;
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
    if (this.reconciliations.delete(entry.id)) {
      this.reconciliationMetrics.resolved++;
      this.emit("control-reconciled", { command: this.describeCommand(entry), code: message.error?.code || null });
    }
    this.recordCommand(entry,message.error?"failed":"completed",message.error?.code || null,{executionMs:message.durationMs ?? (entry.startedAt?Date.now()-entry.startedAt:null),cpuMs:message.cpuMs ?? null,outputBytes:message.outputBytes ?? null,commitMs:message.commitMs ?? null,validationMs:message.validationMs ?? null});
    const {jobId:ignoredJob,fence:ignoredFence,...operationDiagnostic}=entry.diagnostic;
    const operationKey=JSON.stringify(operationDiagnostic);
    if (message.error) {
      const code=message.error.code;
      const category=code.startsWith("AGENT_")?"validation":/^(SIGNAL_ITEM_TOO_LARGE|NEWS_ITEM_TOO_LARGE|OUTPUT_TOO_LARGE)$/.test(code)?'transport':this.options.analysisWorker?'calculation':/^(SQLITE_|STORAGE_IDEMPOTENCY)/.test(code)?'write':'query';
      this.metrics.failuresByCategory[category]++;this.metrics.lastErrorCategory=category;this.metrics.lastErrorAt=new Date().toISOString();
      this.activeErrors.set(operationKey,{...entry.diagnostic,code,category,at:this.metrics.lastErrorAt});
      if(this.activeErrors.size>50)this.activeErrors.delete(this.activeErrors.keys().next().value);
      this.metrics.failed++; this.metrics.lastErrorCode = message.error.code; entry.reject(Object.assign(error(message.error.code), { statusCode: message.error.statusCode || 503, message: message.error.message || message.error.code, causeCode: message.error.causeCode, diagnostic: message.error.diagnostic,details:message.error.details || null })); }
    else {this.metrics.lastSuccessAt=new Date().toISOString();this.metrics.lastOutputBytes=message.outputBytes ?? null;
      this.activeErrors.delete(operationKey);
      if(['domain.call','agent.snapshot','scenarios.prepare'].includes(entry.diagnostic.operation))this.emit('productive');
      this.metrics.lastQueueMs = (entry.startedAt || Date.now()) - entry.queuedAt; this.metrics.lastExecutionMs=message.durationMs;this.metrics.lastTotalMs=Date.now()-entry.queuedAt;this.metrics.lastCpuMs=message.cpuMs ?? null; this.metadata = message.status; this.metrics.completed++; this.metrics.lastDurationMs = message.durationMs; entry.resolve(message.result); }
    this.checkpoint?.observe(message.status?.walBytes);
    this.pump();
  }
  expire(entry) {
    this.lastExpiredCommand={...entry.diagnostic,queuedAt:new Date(entry.queuedAt).toISOString(),elapsedMs:Date.now()-entry.queuedAt,executionMs:entry.startedAt?Date.now()-entry.startedAt:null,timeoutMs:entry.startedAt?entry.timeoutMs:entry.queueTimeoutMs,phase:this.active.has(entry.id)?(entry.startedAt?"executing":"dispatched"):"queued"};
    if (this.active.has(entry.id)) {
      if (!this.options.analysisWorker && entry.startedAt && !entry.reconciling &&
          entry.diagnostic.operation === "agent.call" && entry.diagnostic.method === "heartbeat" &&
          Date.now() < entry.startedAt + this.options.timeoutMs) {
        entry.reconciling = true;
        this.reconciliations.set(entry.id, entry);
        this.reconciliationMetrics.delayed++;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.expire(entry), Math.max(1, entry.startedAt + this.options.timeoutMs - Date.now()));
        this.emit("control-delayed", { code: "STORAGE_CONTROL_RECONCILING", command: this.describeCommand(entry, "reconciling") });
        return;
      }
      if(entry.workflow && entry.startedAt && !entry.cancelling){
        entry.cancelling=true;clearTimeout(entry.timer);
        try{this.worker.postMessage({type:"cancel-workflow",id:entry.id});}
        catch{this.fail(error("STORAGE_WORKER_FAILED"));return;}
        // Keep the slot and await an acknowledged boundary. An unresponsive
        // SQLite transaction still fails closed after the normal write deadline.
        entry.timer=setTimeout(()=>this.expire(entry),this.options.timeoutMs);
        return;
      }
      // Dispatch is not execution: the worker may still be busy with an earlier
      // command. It checks queueDeadline before starting any side effects.
      // Keep the slot until its start/expiry acknowledgement; other writes may
      // still commit. A separate watchdog bounds a worker that never responds.
      if(!entry.startedAt && !entry.waitingForStart){
        entry.waitingForStart=true;
        entry.timer=setTimeout(()=>this.expire(entry),this.options.timeoutMs);
        return;
      }
      const reason=error(entry.pureRead?"STORAGE_READ_TIMEOUT":"STORAGE_OUTCOME_UNKNOWN");
      reason.causeCode=entry.startedAt?"STORAGE_EXECUTION_TIMEOUT":"STORAGE_DISPATCH_TIMEOUT";
      reason.diagnostic=this.lastExpiredCommand;this.fail(reason);return;
    }
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    clearTimeout(entry.timer);this.queue.splice(index, 1); this.pendingBytes -= entry.bytes; this.metrics.failed++;
    this.recordCommand(entry,"failed","STORAGE_QUEUE_TIMEOUT");
    entry.reject(error("STORAGE_QUEUE_TIMEOUT"));
  }
  fail(reason) {
    if (["closed", "failed"].includes(this.state)) return;
    this.failureContext={code:reason.code,causeCode:reason.causeCode || null,at:new Date().toISOString(),sqlActivity:readSqlActivity(this.sqlActivityBuffer),nativeWait:readNativeWait(this.metadata.nativeThreadId),walCheckpoint:this.checkpoint?.status() || null,
      unconfirmedCommands:[...this.active.values()].filter(entry=>!entry.pureRead).map(entry=>this.describeCommand(entry)),
      undispatchedCommands:this.queue.slice(0,50).map(entry=>this.describeCommand(entry,'queued')),
      undispatchedTruncated:this.queue.length>50};
    this.state = "failed"; clearTimeout(this.startTimer); clearTimeout(this.closeTimer);
    this.metrics.lastErrorCode = reason.code;this.metrics.lastErrorAt=new Date().toISOString();this.metrics.lastErrorCategory="worker";this.metrics.failuresByCategory.worker++;
    this.readyReject?.(reason); this.closeReject?.(reason);
    this.metrics.failed += this.active.size + this.queue.length;
    for (const entry of this.active.values()) { const code=entry.pureRead?'STORAGE_READ_TIMEOUT':'STORAGE_OUTCOME_UNKNOWN';clearTimeout(entry.timer); this.recordCommand(entry,"failed",code);entry.reject(Object.assign(error(code),{causeCode:reason.causeCode || reason.code,diagnostic:reason.diagnostic})); }
    this.active.clear();
    this.reconciliations.clear();
    for (const entry of this.queue.splice(0)) { clearTimeout(entry.timer); this.recordCommand(entry,"failed","STORAGE_WORKER_FAILED");entry.reject(Object.assign(error("STORAGE_WORKER_FAILED"),{causeCode:reason.causeCode || reason.code,diagnostic:reason.diagnostic})); }
    this.pendingBytes = 0;
    this.termination = Promise.all([this.worker?.terminate(),this.checkpoint?.close()]).then(()=>{
      if(!this.options.analysisWorker){try{releaseTerminatedWriter(this.options.databasePath,this.options.writerToken);}catch(error){this.metrics.ownershipCleanupError=error.code || 'STORAGE_LEASE_RELEASE_FAILED';}}
    });
    // An analysis waiting for its persistence RPC cannot finish after the
    // writer dies. Reject it now instead of waiting for the provider deadline.
    this.analysisManager?.fail(reason);this.queryManager?.fail(reason);
    this.emit("failed", reason);
  }
  sendClose() {
    if (this.closeId) return;
    this.closeId = randomUUID();
    try { this.worker.postMessage({ id: this.closeId, encoded: JSON.stringify({ operation: "storage.close" }) }); }
    catch { this.fail(error("STORAGE_CLOSE_FAILED")); }
  }
  async close() {
    this.closingRequested=true;this.eventIndexAbort?.abort();if(this.eventIndexTask)await this.eventIndexTask;this.analysisRecoveryAbort?.abort();this.queryRecoveryAbort?.abort();
    if(this.queryRecovery)await this.queryRecovery.catch(()=>{});
    if(this.analysisRecovery)await this.analysisRecovery.catch(()=>{});
    if(this.initializing){try{await this.startTask;}catch{/* Release whichever workers started. */}}
    if(!this.analysisManager){await this.checkpoint?.close();return this.closeLocal();}
    await this.marketWrites?.close();
    await this.advancedCoordinator?.close();
    // Accepted analyses may still need the primary writer to commit their result.
    try { await Promise.all([this.analysisManager?.close(),this.queryManager?.close()]); }
    finally { await this.checkpoint?.close();await this.closeLocal(); }
  }
  async closeLocal() {
    if (["disabled", "closed", "new"].includes(this.state)) { if (this.state === "new") this.state = "closed"; return; }
    if (this.state === "failed") {
      await this.termination;
      if(this.wasReady && this.metrics.ownershipCleanupError)throw error(this.metrics.ownershipCleanupError);
      return;
    }
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
