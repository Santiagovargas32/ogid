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
  peek(options={}) {
    const scope=advancedScope(options);
    const latest=this.db.prepare('SELECT analysis_id AS revision,as_of AS asOf FROM analysis_latest WHERE scope_key=?').get(scope);
    const job=this.db.prepare("SELECT job_id AS jobId,status,error_code AS errorCode,created_at AS queuedAt,input_json FROM analysis_jobs WHERE scope_key=? AND status IN ('queued','running') ORDER BY created_at LIMIT 1").get(scope);
    return {revision:latest?.revision||null,asOf:latest?.asOf||null,lifecycle:{status:job?(latest?'refreshing':'preparing'):latest?'ready':'preparing',scope,phase:job?.status||null,requestedRevision:job?JSON.parse(job.input_json).revisions:null,availableRevision:latest?.revision||null,queuedAt:job?.queuedAt||null,waitAgeMs:job?.status==='queued'?Math.max(0,this.now()-Date.parse(job.queuedAt)):null,snapshotAvailable:Boolean(latest),jobId:job?.jobId||null,jobStatus:job?.status||null,retryAfterMs:job?2000:null,reason:!latest&&!job?'not-calculated':null}};
  }
  status(jobId) {
    const j=this.db.prepare('SELECT * FROM analysis_jobs WHERE job_id=?').get(jobId);
    if(!j)throw new AppError('Trabajo desconocido.',404,'ANALYSIS_JOB_UNKNOWN');
    const latest=this.db.prepare('SELECT analysis_id,as_of FROM analysis_latest WHERE scope_key=?').get(j.scope_key);
    const id=j.status==='complete'?j.analysis_id:latest?.analysis_id;
    const row=id?this.db.prepare('SELECT payload_json FROM analysis_runs WHERE analysis_id=?').get(id):null;
    const value=row?JSON.parse(row.payload_json):{generatedAt:null};delete value.inputManifest;
    return {...value,lifecycle:{status:j.status==='complete'?'ready':j.status==='failed'?'failed':id?'refreshing':'preparing',scope:j.scope_key,jobId:j.job_id,jobStatus:j.status,phase:j.status,requestedRevision:JSON.parse(j.input_json).revisions,availableRevision:id||null,asOf:j.status==='complete'?j.as_of:latest?.as_of||null,queuedAt:j.created_at,publishedAt:j.status==='complete'?j.updated_at:null,waitAgeMs:j.status==='queued'?Math.max(0,this.now()-Date.parse(j.created_at)):null,snapshotAvailable:Boolean(row),owner:j.owner,fence:j.fence,leaseUntil:j.lease_until,errorCode:j.error_code,retryAfterMs:['queued','running'].includes(j.status)?2000:null}};
  }
  renew({jobId,owner,fence}) {
    const changed=this.db.prepare("UPDATE analysis_jobs SET lease_until=? WHERE job_id=? AND owner=? AND fence=? AND status='running' AND lease_until>?").run(this.now()+90000,jobId,owner,fence,this.now());
    if(!changed.changes)throw new AppError('Lease perdido.',409,'ANALYSIS_LEASE_LOST');return {renewed:true};
  }
  assertOwner(job,{owner,fence}){if(job.owner!==owner||job.fence!==fence||job.lease_until<=this.now())throw new AppError('Lease perdido.',409,'ANALYSIS_LEASE_LOST');}
  recover() {
    this.db.prepare("UPDATE analysis_jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,error_code='STORAGE_RESTART_INTERRUPTED',updated_at=? WHERE status='running'").run(new Date(this.now()).toISOString());
  }
  recoverExpired(){
    return this.db.prepare("UPDATE analysis_jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,error_code='ANALYSIS_LEASE_EXPIRED',updated_at=? WHERE job_id IN (SELECT job_id FROM analysis_jobs WHERE status='running' AND (lease_until IS NULL OR lease_until<=?) LIMIT 64)").run(new Date(this.now()).toISOString(),this.now()).changes;
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
          scope,phase:job?.status||null,requestedRevision:job?JSON.parse(job.input_json).revisions:revisions,availableRevision:latest?.analysis_id||null,queuedAt:job?.created_at||null,waitAgeMs:job?.status==='queued'?Math.max(0,now-Date.parse(job.created_at)):null,
          snapshotAvailable:Boolean(snapshot),stale:Boolean(stale),jobId:job?.job_id || null,jobStatus:job?.status || null,
          errorCode:job?.error_code || null,attempts:job?.attempts || 0,asOf:latest?.as_of || null,retryAfterMs:refreshing?2000:null,
          methodologyVersion:ADVANCED_INTELLIGENCE_METHODOLOGY.version},
        dispatchJobId:job?.status==='queued'?job.job_id:null };
    }).immediate();
  }
  claim({jobId,owner}) {
    return this.db.transaction(()=>{
      const changed=this.db.prepare("UPDATE analysis_jobs SET status='running',attempts=attempts+1,updated_at=?,error_code=NULL,owner=?,fence=fence+1,lease_until=? WHERE job_id=? AND status='queued' AND attempts<3").run(new Date(this.now()).toISOString(),owner,this.now()+90000,jobId);
      if(!changed.changes)return null;
      const job=this.db.prepare('SELECT * FROM analysis_jobs WHERE job_id=?').get(jobId);
      return {jobId,owner:job.owner,fence:job.fence,asOf:job.as_of,...JSON.parse(job.input_json)};
    }).immediate();
  }
  fail({jobId,code,owner,fence}) {
    const job=this.db.prepare("SELECT * FROM analysis_jobs WHERE job_id=?").get(jobId);
    if(!job||job.status==='complete')return {persisted:true};
    this.assertOwner(job,{owner,fence});
    this.db.prepare("UPDATE analysis_jobs SET status='failed',error_code=?,updated_at=? WHERE job_id=? AND status!='complete'").run(/^[A-Z0-9_]{1,64}$/.test(code)?code:'ANALYSIS_FAILED',new Date(this.now()).toISOString(),jobId);
    return {persisted:true};
  }
  publish({jobId,result,owner,fence}) {
    const started=performance.now();
    const committed=this.db.transaction(()=>{
      const job=this.db.prepare('SELECT * FROM analysis_jobs WHERE job_id=?').get(jobId);
      if(!job)throw new AppError('Trabajo desconocido.',409,'ANALYSIS_JOB_UNKNOWN');
      if(job.owner!==owner||job.fence!==fence)throw new AppError('Lease perdido.',409,'ANALYSIS_LEASE_LOST');
      if(job.status==='complete') {
        const saved=this.db.prepare('SELECT payload_json FROM analysis_runs WHERE analysis_id=?').get(job.analysis_id);
        if(stableHash(JSON.parse(saved.payload_json))!==stableHash(result))throw new AppError('Resultado distinto para el mismo trabajo.',409,'STORAGE_IDEMPOTENCY_CONFLICT');
        return {persisted:true,analysisId:job.analysis_id,replayed:true};
      }
      this.assertOwner(job,{owner,fence});
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
  constructor(manager) {this.manager=manager;this.owner=randomUUID();this.tasks=new Map();this.accepting=true;}
  async get(input) {
    if(!this.accepting)throw new AppError('Cierre en curso.',503,'STORAGE_NOT_READY');
    const value=await this.manager.localRequest('snapshot.prepare',{options:input.args?.[0] || {},context:input.context});
    const {dispatchJobId,...response}=value;
    if(dispatchJobId)this.dispatch(dispatchJobId);
    return response;
  }
  dispatch(jobId) {
    if(!this.accepting||this.tasks.has(jobId))return;
    let job,timer;
    const task=(async()=>{
      job=await this.manager.localRequest('snapshot.claim',{jobId,owner:this.owner});
      if(!job)return;
      timer=setInterval(()=>this.manager.localRequest('snapshot.renew',{jobId,owner:job.owner,fence:job.fence}).catch(()=>{}),20000);timer.unref();
      await this.manager.analysisManager.localRequest('domain.call',{service:'advanced',method:'getSnapshot',args:[{...job.options,force:true,asOf:job.asOf}],context:job.context,analysisJob:job});
    })().catch(async reason=>{
      if(job)try{await this.manager.localRequest('snapshot.fail',{jobId,owner:job.owner,fence:job.fence,code:reason.code || 'ANALYSIS_FAILED'});}catch{/* recovered durably */}
    }).finally(()=>{clearInterval(timer);this.tasks.delete(jobId);});
    this.tasks.set(jobId,task);
  }
  async recover() {
    if(!this.accepting)return;
    await this.manager.localRequest('snapshot.recover');
    for(const {jobId} of await this.manager.localRequest('snapshot.pending'))this.dispatch(jobId);
    if(this.accepting&&!this.recoveryTimer){this.recoveryTimer=setInterval(()=>{if(this.manager.state==='ready')this.recover().then(()=>{this.lastRecoveryError=null;}).catch(error=>{this.lastRecoveryError={code:error.code||'ANALYSIS_RECOVERY_FAILED',at:new Date().toISOString()};});},20000);this.recoveryTimer.unref();}
  }
  async close() {this.accepting=false;clearInterval(this.recoveryTimer);await Promise.allSettled(this.tasks.values());}
}
