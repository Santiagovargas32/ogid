import {stableHash} from '../utils/stableHash.js';
const kind='market-persistence';
export class CandleWriteJobs {
  constructor(runtime){this.runtime=runtime;this.db=runtime.db;}
  admit({candles,options={}}){
    if(!Array.isArray(candles)||candles.length>100||Buffer.byteLength(JSON.stringify({candles,options}))>262144)throw Object.assign(Error('Invalid durable candle page'),{code:'MARKET_PERSISTENCE_PAGE_TOO_LARGE'});
    const jobId=`market-${stableHash([candles,options])}`,at=new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO acquisition_jobs VALUES(?,?,?,'pending',?,?,?)").run(jobId,jobId,kind,at,at,JSON.stringify({candles,options,cursor:0,inserted:0,updated:0,duplicates:0}));
    return {jobId,requested:candles.length,durable:true};
  }
  pending({after=''}={}){return this.db.prepare("SELECT job_id AS jobId FROM acquisition_jobs WHERE kind=? AND status='pending' AND job_id>? ORDER BY job_id LIMIT 64").all(kind,after);}
  status({jobId}){
    const row=this.db.prepare('SELECT status,job_json FROM acquisition_jobs WHERE job_id=? AND kind=?').get(jobId,kind);
    if(!row)throw Object.assign(Error('Unknown candle job'),{code:'MARKET_PERSISTENCE_UNKNOWN'});
    const j=JSON.parse(row.job_json);
    return {jobId,status:row.status,pending:row.status!=='complete',committed:row.status==='complete',requested:j.candles.length,completedItems:j.cursor,inserted:j.inserted,updated:j.updated,duplicates:j.duplicates};
  }
  page({jobId}){
    return this.db.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM acquisition_jobs WHERE job_id=? AND kind=?').get(jobId,kind);
      if(!row)throw Object.assign(Error('Unknown candle job'),{code:'MARKET_PERSISTENCE_UNKNOWN'});
      if(row.status==='complete')return this.status({jobId});
      const j=JSON.parse(row.job_json),page=j.candles.slice(j.cursor,j.cursor+10);
      const options={...j.options,...(j.options.now?{now:new Date(j.options.now)}:{}),projectionJobId:jobId};
      const result=this.runtime.services.candles.upsert(page,options);
      j.cursor+=page.length;for(const k of ['inserted','updated','duplicates'])j[k]+=(result[k]||0);
      this.db.prepare('UPDATE acquisition_jobs SET status=?,updated_at=?,job_json=? WHERE job_id=?').run(j.cursor>=j.candles.length?'complete':'pending',new Date().toISOString(),JSON.stringify(j),jobId);
      return this.status({jobId});
    }).immediate();
  }
}
export class CandleWriteCoordinator {
  constructor(manager){this.manager=manager;this.tasks=new Map();this.timers=new Map();this.attempts=new Map();this.chain=Promise.resolve();this.accepting=true;this.lastError=null;
    this.resumeResources=()=>{if(this.accepting&&this.resourceDeferred&&this.manager.pressure.status().state==='normal'){this.resourceDeferred=false;void this.recover().catch(error=>{this.lastError={code:error.code};});}};
    this.manager.pressure?.on('change',this.resumeResources);
  }
  status(){return {active:this.tasks.size,retries:this.timers.size,deferred:Boolean(this.resourceDeferred),lastError:this.lastError,source:'acquisition_jobs',kind};}
  async admit(candles,options){
    const jobIds=[];let page=[],bytes=0;
    const send=async()=>{if(!page.length)return;const r=await this.manager.localRequest('market.persist.admit',{candles:page,options});jobIds.push(r.jobId);this.dispatch(r.jobId);page=[];bytes=0;};
    for(const candle of candles){const size=Buffer.byteLength(JSON.stringify(candle));if(page.length&&(page.length>=100||bytes+size>131072))await send();page.push(candle);bytes+=size;}
    await send();return {commitId:stableHash(jobIds),jobIds,durable:true,pending:true,requested:candles.length};
  }
  dispatch(jobId){
    if(this.tasks.has(jobId))return this.tasks.get(jobId);
    if(!this.accepting)return Promise.reject(Object.assign(Error('Closing'),{code:'STORAGE_NOT_READY'}));
    clearTimeout(this.timers.get(jobId));this.timers.delete(jobId);
    const task=this.chain.catch(()=>{}).then(async()=>{
      // Reconcile a lost ACK/uncertain commit from the durable cursor first.
      // A complete job needs no write; a pending job resumes its next page.
      let result=await this.manager.localRequest('market.persist.status',{jobId});
      while(result.pending&&this.accepting){result=await this.manager.localRequest('market.persist.page',{jobId});await new Promise(r=>setImmediate(r));}
      this.attempts.delete(jobId);if(this.lastError?.jobId===jobId)this.lastError=null;return result;
    }).catch(error=>{
      this.lastError={code:error.code||'MARKET_PERSISTENCE_FAILED',jobId,at:new Date().toISOString()};
      if(error.code==='STORAGE_RESOURCE_PRESSURE'){this.resourceDeferred=true;throw error;}
      if(this.accepting&&this.manager.state==='ready'){const attempt=(this.attempts.get(jobId)||0)+1;this.attempts.set(jobId,attempt);const timer=setTimeout(()=>{this.timers.delete(jobId);this.dispatch(jobId).catch(()=>{});},Math.min(60000,1000*2**Math.min(attempt,6)));timer.unref();this.timers.set(jobId,timer);}throw error;
    }).finally(()=>this.tasks.delete(jobId));
    this.chain=task;this.tasks.set(jobId,task);task.catch(()=>{});return task;
  }
  async wait(receipt){
    const rows=await Promise.all(receipt.jobIds.map(id=>this.dispatch(id)));
    if(rows.some(r=>!r.committed))throw Object.assign(Error('ACK not confirmed'),{code:'MARKET_COMMIT_ACK_UNKNOWN'});
    return rows.reduce((r,v)=>{for(const k of ['inserted','updated','duplicates'])r[k]+=v[k]||0;return r;},{committed:true,pending:false,inserted:0,updated:0,duplicates:0,jobIds:receipt.jobIds});
  }
  async inspect(receipt){
    const rows=await Promise.all(receipt.jobIds.map(jobId=>this.manager.localRequest('market.persist.status',{jobId})));
    return {durable:true,pending:rows.some(row=>row.pending),committed:rows.every(row=>row.committed),jobs:rows};
  }
  async recover(){
    if(this.recovery)return;
    const first=await this.manager.localRequest('market.persist.pending',{});
    this.recovery=(async()=>{
      let page=first;
      while(this.accepting&&page.length){
        await Promise.allSettled(page.map(({jobId})=>this.dispatch(jobId)));
        if(this.accepting)page=await this.manager.localRequest('market.persist.pending',{after:page.at(-1).jobId});
      }
    })().catch(error=>{this.lastError={code:error.code||'MARKET_RECOVERY_FAILED',at:new Date().toISOString()};}).finally(()=>{this.recovery=null;});
  }
  async flush(){
    await this.recovery;
    if(this.manager.pressure&&this.manager.pressure.status().state!=='normal'){await Promise.allSettled(this.tasks.values());this.resourceDeferred=true;return this.status();}
    let page=await this.manager.localRequest('market.persist.pending',{});
    while(page.length){
      const results=await Promise.allSettled(page.map(({jobId})=>this.dispatch(jobId)));
      const failed=results.find(r=>r.status==='rejected');
      if(failed)throw failed.reason;
      page=await this.manager.localRequest('market.persist.pending',{after:page.at(-1).jobId});
    }
    await Promise.all(this.tasks.values());
  }
  async close(){this.accepting=false;this.manager.pressure?.off('change',this.resumeResources);for(const t of this.timers.values())clearTimeout(t);this.timers.clear();await Promise.allSettled(this.tasks.values());}
}
