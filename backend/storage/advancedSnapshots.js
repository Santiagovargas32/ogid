import { randomUUID } from "node:crypto";
import { stableHash } from "../utils/stableHash.js";
import { ADVANCED_INTELLIGENCE_METHODOLOGY } from "../services/intel/advancedIntelligenceService.js";
import { readMeta } from "./sqlRepositories.js";
import { AppError } from "../utils/error.js";

export function advancedOptions(input = {}) {
  const windowHours = Math.max(1, Math.min(168, Number(input.windowHours) || 24));
  return { countries: [...new Set((input.countries || []).map(v => String(v).trim().toUpperCase()))].sort(),
    windowHours, activeWindowHours: Math.max(1, Math.min(48, Number(input.activeWindowHours) || Math.min(48, windowHours))),
    baselineDays: Number(input.baselineDays) === 30 ? 30 : 7, maxEvents: Math.max(50, Math.min(1000, Number(input.maxEvents) || 450)) };
}
export const advancedScope = options => stableHash([ADVANCED_INTELLIGENCE_METHODOLOGY.version, advancedOptions(options)]);

// Writer-owned durable state. A result is visible only through analysis_latest,
// updated in the same transaction as the immutable run and job completion.
export class AdvancedSnapshots {
  constructor(runtime, { now = Date.now, ttlMs = 30000 } = {}) { Object.assign(this, {runtime, db:runtime.db, now, ttlMs}); }
  recover() {
    this.db.prepare("UPDATE analysis_jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,error_code='STORAGE_RESTART_INTERRUPTED',updated_at=? WHERE status='running'").run(new Date(this.now()).toISOString());
  }
  pending() { return this.db.prepare("SELECT job_id AS jobId FROM analysis_jobs WHERE status='queued' AND attempts<3 ORDER BY created_at LIMIT 64").all(); }
  prepare({options = {}, context = {}} = {}) {
    const filters=advancedOptions(options),scope=advancedScope(filters),now=this.now(),at=new Date(now).toISOString();
    return this.db.transaction(()=>{
      const latest=this.db.prepare("SELECT l.*,a.payload_json FROM analysis_latest l JOIN analysis_runs a USING(analysis_id) WHERE scope_key=?").get(scope);
      const snapshot=latest ? JSON.parse(latest.payload_json) : null;
      if(snapshot)delete snapshot.inputManifest;
      const active=this.db.prepare("SELECT * FROM analysis_jobs WHERE scope_key=? AND status IN ('queued','running')").get(scope);
      // Context contains only data used by the algorithm, never provider bodies.
      const raw=context.snapshot || {},pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
      const snapshotContext={countries:raw.countries || {},meta:pick(raw.meta,['lastRefreshAt','dataQuality']),
        market:{updatedAt:raw.market?.updatedAt || null,quotes:Object.fromEntries(Object.entries(raw.market?.quotes || {}).map(([k,v])=>[k,pick(v,['price','changePct','asOf','source','synthetic','dataMode'])]))},
        predictions:pick(raw.predictions,['updatedAt','tickers']),awareness:raw.awareness || context.awareness || {mode:'off'}};
      if(snapshotContext.awareness)snapshotContext.awareness={...snapshotContext.awareness,generatedAt:undefined};
      const captured={newsFromStorage:true,snapshot:snapshotContext,awareness:{mode:snapshotContext.awareness?.mode || 'off'}};
      const revisions={news:readMeta(this.db,'news.meta',{}).revision || 0,articleWatermark:this.db.prepare('SELECT coalesce(max(rowid),0) AS n FROM article_revisions').get().n,signals:readMeta(this.db,'signals.revision',0),context:stableHash(captured)};
      const calculationKey=stableHash([scope,revisions,Math.floor(now/this.ttlMs)]);
      const failed=this.db.prepare("SELECT * FROM analysis_jobs WHERE scope_key=? AND status='failed' ORDER BY created_at DESC LIMIT 1").get(scope);
      const sameFailure=failed && (!latest || failed.as_of>latest.as_of) && stableHash(JSON.parse(failed.input_json).revisions)===stableHash(revisions);
      const stale=!snapshot || now-Date.parse(latest.as_of)>=this.ttlMs || stableHash(snapshot.inputRevisions)!==stableHash(revisions);
      let job=active || (sameFailure && !options.force ? failed : null) || this.db.prepare("SELECT * FROM analysis_jobs WHERE calculation_key=?").get(calculationKey);
      if(!job && (stale || options.force)) {
        if(this.db.prepare("SELECT count(*) AS n FROM analysis_jobs WHERE status IN ('queued','running')").get().n>=64)throw new AppError('Cola de análisis completa.',503,'ANALYSIS_BACKPRESSURE');
        const id=randomUUID();
        this.db.prepare("INSERT INTO analysis_jobs(job_id,scope_key,calculation_key,method_version,status,as_of,created_at,updated_at,input_json) VALUES(?,?,?,?,'queued',?,?,?,?)").run(id,scope,calculationKey,ADVANCED_INTELLIGENCE_METHODOLOGY.version,at,at,at,JSON.stringify({options:filters,context:captured,revisions}));
        job=this.db.prepare("SELECT * FROM analysis_jobs WHERE job_id=?").get(id);
      }
      const refreshing=job && ['queued','running'].includes(job.status);
      return { ...(snapshot || {schemaVersion:'advanced-intelligence-snapshot-v1',generatedAt:null,filters}),
        lifecycle:{status:refreshing ? (snapshot?'refreshing':'preparing') : job?.status==='failed'?'failed':'ready',
          snapshotAvailable:Boolean(snapshot),stale:Boolean(stale),jobId:job?.job_id || null,jobStatus:job?.status || null,
          errorCode:job?.error_code || null,attempts:job?.attempts || 0,asOf:latest?.as_of || null,retryAfterMs:refreshing?2000:null,
          methodologyVersion:ADVANCED_INTELLIGENCE_METHODOLOGY.version},
        dispatchJobId:job?.status==='queued'?job.job_id:null };
    }).immediate();
  }
  claim(jobId) {
    return this.db.transaction(()=>{
      const changed=this.db.prepare("UPDATE analysis_jobs SET status='running',attempts=attempts+1,updated_at=?,error_code=NULL WHERE job_id=? AND status='queued' AND attempts<3").run(new Date(this.now()).toISOString(),jobId);
      if(!changed.changes)return null;
      const job=this.db.prepare('SELECT * FROM analysis_jobs WHERE job_id=?').get(jobId);
      return {jobId,asOf:job.as_of,...JSON.parse(job.input_json)};
    }).immediate();
  }
  fail({jobId,code}) {
    this.db.prepare("UPDATE analysis_jobs SET status='failed',error_code=?,updated_at=? WHERE job_id=? AND status!='complete'").run(/^[A-Z0-9_]{1,64}$/.test(code)?code:'ANALYSIS_FAILED',new Date(this.now()).toISOString(),jobId);
    return {persisted:true};
  }
  publish({jobId,result}) {
    const started=performance.now();
    const committed=this.db.transaction(()=>{
      const job=this.db.prepare('SELECT * FROM analysis_jobs WHERE job_id=?').get(jobId);
      if(!job)throw new AppError('Trabajo desconocido.',409,'ANALYSIS_JOB_UNKNOWN');
      if(job.status==='complete') {
        const saved=this.db.prepare('SELECT payload_json FROM analysis_runs WHERE analysis_id=?').get(job.analysis_id);
        if(stableHash(JSON.parse(saved.payload_json))!==stableHash(result))throw new AppError('Resultado distinto para el mismo trabajo.',409,'STORAGE_IDEMPOTENCY_CONFLICT');
        return {persisted:true,analysisId:job.analysis_id,replayed:true};
      }
      if(job.status!=='running')throw new AppError('Trabajo no publicable.',409,'ANALYSIS_JOB_STATE');
      if(result.methodology?.version!==job.method_version || result.inputsAsOf!==job.as_of)throw new AppError('Resultado incompatible.',409,'ANALYSIS_RESULT_MISMATCH');
      const id=this.runtime.recordAnalysis('advanced.getSnapshot',JSON.parse(job.input_json).options,result);
      this.db.prepare("INSERT INTO analysis_latest VALUES(?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET analysis_id=excluded.analysis_id,as_of=excluded.as_of,calculation_key=excluded.calculation_key WHERE excluded.as_of>analysis_latest.as_of").run(job.scope_key,id,job.as_of,job.calculation_key);
      this.db.prepare("UPDATE analysis_jobs SET status='complete',analysis_id=?,updated_at=?,error_code=NULL WHERE job_id=?").run(id,new Date(this.now()).toISOString(),jobId);
      return {persisted:true,analysisId:id};
    }).immediate();
    this.runtime.lastCommitMs=performance.now()-started;return committed;
  }
}

// HTTP cancellation never owns these tasks. Only small job descriptors and
// completed results cross workers; article inputs stay in the reader worker.
export class AdvancedCoordinator {
  constructor(manager) {this.manager=manager;this.tasks=new Map();this.accepting=true;}
  async get(input) {
    if(!this.accepting)throw new AppError('Cierre en curso.',503,'STORAGE_NOT_READY');
    const value=await this.manager.localRequest('snapshot.prepare',{options:input.args?.[0] || {},context:input.context});
    const {dispatchJobId,...response}=value;
    if(dispatchJobId)this.dispatch(dispatchJobId);
    return response;
  }
  dispatch(jobId) {
    if(this.tasks.has(jobId))return;
    const task=(async()=>{
      const job=await this.manager.localRequest('snapshot.claim',{jobId});
      if(!job)return;
      await this.manager.analysisManager.localRequest('domain.call',{service:'advanced',method:'getSnapshot',args:[{...job.options,force:true,asOf:job.asOf}],context:job.context,analysisJob:job});
    })().catch(async reason=>{
      // A commit may have succeeded before a lost reply; fail() never demotes it.
      try{await this.manager.localRequest('snapshot.fail',{jobId,code:reason.code || 'ANALYSIS_FAILED'});}catch{ /* durable running job is reconciled at restart */ }
    }).finally(()=>this.tasks.delete(jobId));
    this.tasks.set(jobId,task);
  }
  async recover() {for(const {jobId} of await this.manager.localRequest('snapshot.pending'))this.dispatch(jobId);}
  async close() {this.accepting=false;await Promise.allSettled(this.tasks.values());}
}
