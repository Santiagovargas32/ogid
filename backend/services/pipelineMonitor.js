import { performance } from 'node:perf_hooks';
const RECOVERABLE=new Set(['SQLITE_BUSY','STORAGE_BACKPRESSURE','STORAGE_QUEUE_TIMEOUT','STORAGE_READ_TIMEOUT','STORAGE_ANALYSIS_UNAVAILABLE','YAHOO_TIMEOUT','REQUEST_TIMEOUT']);
export class PipelineMonitor {
  constructor({ publish=()=>{},persist=null }={}) {this.stages=new Map();this.tasks=new Map();this.publish=publish;this.persist=persist;this.pending=new Set();}
  update(id,patch){
    const previous=this.stages.get(id)||{enabled:true,status:'queued',lastRunAt:null,lastSuccessAt:null,durationMs:null,queue:0,processed:0,discarded:0,errorCode:null,reason:null,revision:null};
    const stage={...previous,...patch};this.stages.set(id,stage);this.publish(id,stage);
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
  snapshot({staleMs=600000}={}){return Object.fromEntries([...this.stages].map(([id,s])=>[id,{...s,...(s.status==='completed'&&Date.now()-Date.parse(s.lastSuccessAt)>staleMs?{status:'stale'}:{})}]));}
  async flush(){await Promise.allSettled([...this.pending]);}
}
