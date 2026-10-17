import { RUNTIME_POLICY } from "../../config/runtimePolicy.js";

// The backend owns acquisition. Read-only HTTP/MCP queries never start this work.
export class SecSourceAgent {
  constructor({service,instruments=()=>[],userAgent="",monitor=null,now=Date.now,policy={}}={}) {
    Object.assign(this,{service,instruments,userAgent,monitor,now});
    this.policy={...RUNTIME_POLICY.research.sec,...policy};
    this.state={status:"idle",lastRunAt:null,lastSuccessAt:null,processed:0,coveredInstrumentIds:[],uncoveredInstrumentIds:[]};
    this.running=false;this.task=null;
  }
  getStatus(){return {...structuredClone(this.state),running:this.running,tickMs:this.policy.tickMs};}
  start(){
    if(this.running)return this.task || Promise.resolve(this.getStatus());
    this.running=true;this.stopping=false;
    const task=this.tick();
    this.timer=setInterval(()=>{void this.tick();},this.policy.tickMs);this.timer.unref?.();
    return task;
  }
  tick(){
    if(this.stopping)return Promise.resolve(this.getStatus());
    if(this.task)return this.task;
    this.task=this.run().catch(error=>{
      this.update({status:"failed",errorCode:error.code || "SEC_AGENT_FAILED",reason:"SEC acquisition failed; stored data remains available"});
      return this.getStatus();
    }).finally(()=>{this.task=null;});
    return this.task;
  }
  update(patch){
    if(Object.entries(patch).every(([key,value])=>JSON.stringify(this.state[key]) === JSON.stringify(value)))return;
    Object.assign(this.state,patch);
    // An idle cycle completed without acquisition; pipeline storage has no idle status.
    this.monitor?.update("research.sec",{...patch,status:this.state.status === "idle"?"completed":this.state.status,enabled:true,queue:0});
  }
  async run(){
    const selected=this.instruments().filter(i=>i.assetType === "equity");
    if(!selected.length){this.update({status:"idle",errorCode:null,reason:"No equities selected",coveredInstrumentIds:[],uncoveredInstrumentIds:[]});return this.getStatus();}
    if(!/^[^\r\n]+\s+[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.userAgent.trim())){
      this.update({status:"blocked",errorCode:"SEC_USER_AGENT_REQUIRED",reason:"Configure RESEARCH_SEC_USER_AGENT with an identifying contact"});
      return this.getStatus();
    }
    const catalog=await this.service.status();
    if(this.stopping)return this.getStatus();
    const sources=catalog.sources.filter(s=>s.enabled && s.adapter.startsWith("sec-") && selected.some(i=>i.companyId === s.companyId || s.symbols?.includes(i.canonicalSymbol)));
    const covered=new Set(selected.filter(i=>sources.some(s=>i.companyId === s.companyId || s.symbols?.includes(i.canonicalSymbol))).map(i=>i.instrumentId));
    const coverage={coveredInstrumentIds:[...covered],uncoveredInstrumentIds:selected.filter(i=>!covered.has(i.instrumentId)).map(i=>i.instrumentId)};
    const cooldown=sources.find(s=>["HTTP_403","HTTP_429"].includes(s.runtime.failureCode) && Date.parse(s.runtime.nextEligibleAt)>this.now());
    if(cooldown){this.update({...coverage,status:"blocked",errorCode:"SEC_ACCESS_COOLDOWN",reason:"SEC access cooldown",nextEligibleAt:cooldown.runtime.nextEligibleAt});return this.getStatus();}
    const due=sources.filter(s=>!s.runtime.nextEligibleAt || Date.parse(s.runtime.nextEligibleAt)<=this.now())
      .sort((a,b)=>(Date.parse(a.runtime.lastAttemptAt)||0)-(Date.parse(b.runtime.lastAttemptAt)||0) || a.sourceId.localeCompare(b.sourceId))
      .slice(0,this.policy.maxRequestsPerCycle);
    if(!due.length){this.update({...coverage,status:"idle",errorCode:null,reason:sources.length?"No SEC source is due":"No selected equity has a verified SEC mapping"});return this.getStatus();}
    this.update({...coverage,status:"running",lastRunAt:new Date(this.now()).toISOString(),errorCode:null,reason:null,nextEligibleAt:null});
    const result=await this.service.run({sourceIds:due.map(s=>s.sourceId),maxRequests:due.length});
    const healthy=result.results.filter(row=>row.status === "healthy"),degraded=result.results.some(row=>!["healthy","cooldown"].includes(row.status));
    this.update({status:degraded?"degraded":"completed",processed:healthy.reduce((sum,row)=>sum+(row.accepted || 0),0),
      lastSuccessAt:healthy.length?new Date(this.now()).toISOString():this.state.lastSuccessAt,
      errorCode:degraded?"SEC_SOURCE_UNAVAILABLE":null,reason:degraded?"Some SEC sources are unavailable; stored data is retained":null});
    return this.getStatus();
  }
  async stop(){
    this.running=false;this.stopping=true;clearInterval(this.timer);
    if(this.task){try{await this.service.stop?.();}finally{await this.task;}}
  }
}
