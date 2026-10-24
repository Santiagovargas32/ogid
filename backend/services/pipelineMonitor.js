import {createLogger} from '../utils/logger.js';
const log=createLogger('backend/pipeline');
import { performance } from 'node:perf_hooks';
const RECOVERABLE=new Set(['SQLITE_BUSY','STORAGE_BACKPRESSURE','STORAGE_QUEUE_TIMEOUT','STORAGE_READ_TIMEOUT','STORAGE_ANALYSIS_UNAVAILABLE','YAHOO_TIMEOUT','REQUEST_TIMEOUT']);
export class PipelineMonitor {
  constructor({ publish=()=>{},persist=null }={}) {this.stages=new Map();this.tasks=new Map();this.publish=publish;this.persist=persist;this.pending=new Set();this.policies=new Map([['storage',{kind:'initialization'}]]);}
  register(id, {kind = 'periodic', staleMs = 600000} = {}) {
    if (!['initialization','periodic','event'].includes(kind) || !Number.isFinite(staleMs) || staleMs <= 0) throw new TypeError('Invalid pipeline freshness policy');
    this.policies.set(id,{kind,staleMs});
  }
  update(id,patch){
    const previous=this.stages.get(id)||{enabled:true,status:'queued',lastRunAt:null,lastSuccessAt:null,durationMs:null,queue:0,processed:0,discarded:0,errorCode:null,reason:null,revision:null};
    const stage={...previous,...patch,observedAt:new Date().toISOString()};
    if(patch.reason==='data-stale')stage.quality={status:'stale',reason:patch.reason,observedAt:stage.observedAt};
    else if(patch.status==='completed')stage.quality=null;
    if(previous.status!==stage.status)log.info('pipeline_transition',{pipeline:id,status:stage.status,previousStatus:previous.status,code:stage.errorCode,reason:stage.reason,quality:stage.quality||null});this.stages.set(id,stage);this.publish(id,stage);
    if(this.persist){
      const persistenceId=`${id}.persistence`;
      const publishPersistence=patch=>{const value={...stage,...patch};this.stages.set(persistenceId,value);this.publish(persistenceId,value);};
      const task=Promise.resolve().then(()=>this.persist(id,stage)).then(()=>{
        if(this.stages.has(persistenceId))publishPersistence({status:'completed',lastSuccessAt:new Date().toISOString(),errorCode:null,reason:null});
      }).catch(error=>{
        publishPersistence({status:'blocked',errorCode:error.code || 'PIPELINE_PERSIST_FAILED',reason:'stage persistence failed'});
      });
      this.pending.add(task);task.finally(()=>this.pending.delete(task)).catch(()=>{});
    }
    return stage;
  }
  run(id,work,{enabled=true,counts=()=>({}),revision=()=>null}={}){
    if(!enabled){this.update(id,{enabled:false,status:'disabled'});return Promise.resolve(null);}
    if(this.tasks.has(id))return this.tasks.get(id);
    this.update(id,{status:'queued',queue:1});
    const started=performance.now();
    const task=Promise.resolve().then(async()=>{
      this.update(id,{status:'running',queue:0,lastRunAt:new Date().toISOString(),errorCode:null,reason:null});
      try{const value=await work();const outcome=counts(value);
        this.update(id,{status:outcome.degraded?'degraded':'completed',lastSuccessAt:outcome.degraded?this.stages.get(id).lastSuccessAt:new Date().toISOString(),durationMs:performance.now()-started,processed:outcome.processed || 0,discarded:outcome.discarded || 0,reason:outcome.reason || null,revision:revision(value)});return value;
      }catch(error){this.update(id,{status:RECOVERABLE.has(error.code)?'degraded':/STORAGE_|SQLITE_|RESEARCH_CAPACITY/.test(error.code || '')?'blocked':'failed',durationMs:performance.now()-started,errorCode:error.code || 'PIPELINE_FAILED',reason:RECOVERABLE.has(error.code)?'recoverable; next scheduled run':'requires recovery'});throw error;}
    }).finally(()=>this.tasks.delete(id));this.tasks.set(id,task);return task;
  }
  schedule(id,{nextRunAt,intervalMs}){
    const previous=this.policies.get(id)||{kind:'periodic',staleMs:600000};this.policies.set(id,{...previous,nextRunAt,intervalMs});
  }
  snapshot({staleMs=600000}={}) {
    return Object.fromEntries([...this.stages].map(([id,s])=>{
      const policy=this.policies.get(id) || this.policies.get(id.replace(/\.persistence$/,'')) || {kind:'periodic',staleMs};
      const expired=policy.kind==='periodic' && s.status==='completed' && (policy.nextRunAt?Date.now()>Date.parse(policy.nextRunAt)+Math.min(60000,policy.intervalMs||60000):Date.now()-Date.parse(s.lastSuccessAt)>(policy.staleMs || staleMs));
      return [id,{...s,freshness:policy,...(expired?{status:'stale'}:{})}];
    }));
  }
  async flush(){await Promise.allSettled([...this.pending]);}
}
