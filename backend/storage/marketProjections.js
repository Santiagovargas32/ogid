import { stableHash } from '../utils/stableHash.js';
import { TECHNICAL_INDICATORS_METHOD_VERSION } from '../services/market/technicalIndicators.js';

const version=TECHNICAL_INDICATORS_METHOD_VERSION;
const fail=code=>{throw Object.assign(Error(code),{code,statusCode:503});};
const scopeOf=row=>({instrumentId:row.instrument_id,interval:row.interval,adjustmentMode:row.adjustment_mode,datasetId:row.dataset_id});
const describe=row=>row?{key:row.scope_key,...scopeOf(row),methodVersion:row.method_version,requiredRevision:row.required_revision,completedRevision:row.completed_revision,state:row.state,analysisId:row.analysis_id,sourceJobId:row.source_job_id,errorCode:row.last_error,updatedAt:row.updated_at}:null;
function sourceRevisions(db,scope){
  const intervals=[scope.interval,...(['1h','30min','15min'].includes(scope.interval)?['5min']:[])];
  return Object.fromEntries(intervals.map(interval=>{
    const key=`candles.revision:${scope.datasetId}:${scope.instrumentId}:${interval}:${scope.adjustmentMode}`;
    return [key,JSON.parse(db.prepare('SELECT value_json FROM runtime_meta WHERE key=?').get(key)?.value_json||'0')];
  }));
}

// Called inside the candle transaction, once per changed series. No task or
// callback in the HTTP process is required for the obligation to survive.
export function requireMarketProjection(db,scope,{sourceJobId=null,changed=true}={}){
  if(scope.datasetId!=='provider-yahoo')return;
  const key=stableHash([scope,version]),at=new Date().toISOString();
  const row=db.prepare('SELECT * FROM market_projection_state WHERE scope_key=?').get(key);
  if(row){
    const current=JSON.stringify(sourceRevisions(db,scope));
    if(changed||row.state==='complete'&&row.source_revisions_json!==current)
      db.prepare("UPDATE market_projection_state SET required_revision=required_revision+1,state='pending',last_error=NULL,source_job_id=coalesce(?,source_job_id),updated_at=? WHERE scope_key=?").run(sourceJobId,at,key);
    else if(sourceJobId&&sourceJobId!==row.source_job_id)db.prepare('UPDATE market_projection_state SET source_job_id=? WHERE scope_key=?').run(sourceJobId,key);
  }else db.prepare("INSERT INTO market_projection_state(scope_key,instrument_id,interval,adjustment_mode,dataset_id,method_version,required_revision,state,source_job_id,updated_at) VALUES(?,?,?,?,?,?,1,'pending',?,?)").run(key,scope.instrumentId,scope.interval,scope.adjustmentMode,scope.datasetId,version,sourceJobId,at);
  return key;
}

export class MarketProjectionRepository {
  constructor(runtime){this.runtime=runtime;this.db=runtime.db;}
  pending(){return this.db.prepare("SELECT * FROM market_projection_state WHERE state='pending' ORDER BY updated_at,scope_key LIMIT 16").all().map(describe);}
  status({key}={}){
    if(key)return describe(this.db.prepare('SELECT * FROM market_projection_state WHERE scope_key=?').get(key));
    return {...this.db.prepare("SELECT count(*) total,coalesce(sum(state='pending'),0) pending,coalesce(sum(last_error IS NOT NULL),0) failed FROM market_projection_state").get(),oldest:this.pending()[0]||null,firstFailure:describe(this.db.prepare('SELECT * FROM market_projection_state WHERE last_error IS NOT NULL ORDER BY updated_at,scope_key LIMIT 1').get())};
  }
  reconcile({jobIds}={}){
    if(!Array.isArray(jobIds)||!jobIds.length||jobIds.length>64||jobIds.some(id=>!/^market-[a-f0-9]{64}$/.test(id)))fail('MARKET_PROJECTION_INVALID_JOBS');
    return this.db.transaction(()=>jobIds.map(jobId=>{
      const row=this.db.prepare("SELECT job_json FROM acquisition_jobs WHERE job_id=? AND kind='market-persistence' AND status='complete'").get(jobId);
      if(!row)fail('MARKET_PROJECTION_CANDLES_UNCONFIRMED');
      const job=JSON.parse(row.job_json);if(job.cursor!==job.candles.length)fail('MARKET_PROJECTION_CANDLES_UNCONFIRMED');
      const scopes=new Map();
      for(const candle of job.candles){const scope={instrumentId:candle.instrumentId,interval:candle.interval,adjustmentMode:candle.provenance?.adjustmentMode||(candle.adjusted?'splits':'none'),datasetId:'provider-yahoo'};scopes.set(JSON.stringify(scope),scope);}
      const keys=[...scopes.values()].map(scope=>requireMarketProjection(this.db,scope,{sourceJobId:jobId,changed:false}));
      return {jobId,projections:keys.map(key=>this.status({key}))};
    })).immediate();
  }
  async calculate({key}={}){
    const prepared=this.db.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM market_projection_state WHERE scope_key=?').get(key);
      if(!row)fail('MARKET_PROJECTION_UNKNOWN');
      if(row.state==='complete')return {confirmed:true,analysisId:row.analysis_id};
      const scope=scopeOf(row),input={instrumentId:scope.instrumentId,interval:scope.interval,adjustmentMode:scope.adjustmentMode,limit:500};
      const revisions=sourceRevisions(this.db,scope);
      const result={...this.runtime.services.indicators.calculate(input),inputRevisions:revisions};
      return {key,revision:row.required_revision,revisions,record:{kind:'indicators.calculate',input:[input],result}};
    }).deferred();
    if(prepared.confirmed)return prepared;
    if(this.runtime.analysisOnly)return this.runtime.rpc('analysis.persist',{type:'market-projection',input:prepared});
    return this.publish(prepared);
  }
  publish({key,revision,revisions,record}={}){
    return this.db.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM market_projection_state WHERE scope_key=?').get(key);
      if(!row)fail('MARKET_PROJECTION_UNKNOWN');
      const expectedInput={instrumentId:row.instrument_id,interval:row.interval,adjustmentMode:row.adjustment_mode,limit:500};
      if(!Number.isSafeInteger(revision)||revision<1||revision>row.required_revision||record?.kind!=='indicators.calculate'||record.result?.instrumentId!==row.instrument_id||record.result?.interval!==row.interval||record.result?.adjustmentMode!==row.adjustment_mode||record.result?.methodVersion!==row.method_version||stableHash(record.input)!==stableHash([expectedInput])||!revisions||stableHash(record.result.inputRevisions)!==stableHash(revisions))fail('MARKET_PROJECTION_INVALID_RESULT');
      const current=sourceRevisions(this.db,scopeOf(row));
      const analysisId=this.runtime.recordAnalysis(record.kind,record.input,record.result);
      const confirmed=revision===row.required_revision&&stableHash(current)===stableHash(revisions);
      if(confirmed)this.db.prepare("UPDATE market_projection_state SET completed_revision=?,state='complete',analysis_id=?,source_revisions_json=?,last_error=NULL,updated_at=? WHERE scope_key=? AND required_revision=?").run(revision,analysisId,JSON.stringify(current),new Date().toISOString(),key,revision);
      return {persisted:true,confirmed,analysisId,revision};
    }).immediate();
  }
  fail({key,revision,code}={}){
    if(!/^[A-Z][A-Z0-9_]{1,63}$/.test(code||''))fail('MARKET_PROJECTION_INVALID_ERROR');
    this.db.prepare("UPDATE market_projection_state SET last_error=?,updated_at=? WHERE scope_key=? AND required_revision=? AND state='pending'").run(code,new Date().toISOString(),key,revision);
    return this.status({key});
  }
}

export class MarketProjectionCoordinator {
  constructor(manager){this.manager=manager;this.running=false;this.summary={pending:0,failed:0};this.wake=()=>{if(this.running&&this.manager.pressure.status().state==='normal')this.schedule(0);};}
  status(){return {...this.summary,active:Boolean(this.task),lastError:this.lastError||null,lastCompletedAt:this.lastCompletedAt||null};}
  async start(){if(this.running)return;this.running=true;this.manager.pressure.on('change',this.wake);this.schedule(0);}
  schedule(delay=1000){clearTimeout(this.timer);if(this.running){this.timer=setTimeout(()=>{this.timer=null;void this.tick();},delay);this.timer.unref();}}
  tick(){
    if(this.task)return this.task;
    if(this.draining)return Promise.resolve();
    if(this.manager.state!=='ready'||this.manager.pressure.status().state!=='normal'){this.schedule();return Promise.resolve();}
    this.task=this.page().catch(error=>{this.lastError=error.code||'MARKET_PROJECTION_FAILED';}).finally(()=>{this.task=null;this.schedule(this.lastError||!this.summary.pending?60000:1000);});return this.task;
  }
  async page(){
    this.summary=await this.manager.request('market.project.status');
    if(!this.summary.pending&&!this.summary.failed)this.lastError=null;
    const rows=await this.manager.request('market.project.pending');
    for(const row of rows){
      if(this.manager.pressure.status().state!=='normal')break;
      try{await this.manager.request('market.project.calculate',{key:row.key});this.lastError=null;this.lastCompletedAt=new Date().toISOString();}
      catch(error){
        if(error.code==='STORAGE_RESOURCE_PRESSURE')break;
        this.lastError=error.code||'MARKET_PROJECTION_FAILED';
        if(this.manager.state==='ready')await this.manager.localRequest('market.project.fail',{key:row.key,revision:row.requiredRevision,code:this.lastError});
        throw error;
      }
    }
    this.summary=await this.manager.request('market.project.status');
  }
  async stop(){this.running=false;clearTimeout(this.timer);this.manager.pressure.off('change',this.wake);await this.task;}
  async flush(){
    this.draining=true;
    try{
      await this.task;
      do{
        this.summary=await this.manager.request('market.project.status');
        if(!this.summary.pending||this.manager.pressure.status().state!=='normal')break;
        await this.page();
      }while(this.summary.pending);
      if(this.summary.failed)throw Object.assign(Error('Market projections remain unconfirmed'),{code:'MARKET_PERSISTENCE_UNCONFIRMED',failureCount:this.summary.failed,persistenceFailures:[{phase:'indicators',...this.summary.firstFailure}]});
      if(!this.summary.pending)this.lastError=null;
      return this.status();
    }finally{this.draining=false;}
  }
}
