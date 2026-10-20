import { readyModel } from "./config.js";
import { agentError } from "./contracts.js";

// OpenCode is authoritative for availability; the OGID attestation remains
// authoritative for context/tools. Never forward provider settings or headers.
export class AgentModelSelection {
  constructor({config,opencode,call,now=Date.now}){Object.assign(this,{config,opencode,call,now});}
  async list({refresh=false}={}){
    if(!refresh && this.cached && this.now()-this.cachedAt<10000)return this.cached;
    if(this.loading)return this.loading;
    this.loading=this.read().then(value=>{this.cached=value;this.cachedAt=this.now();return value;}).finally(()=>{this.loading=null;});
    return this.loading;
  }
  async read(){
    let remote=[],state="ready",errorCode=null;
    try{
      if(this.config.mode==="off")throw agentError("AGENT_DISABLED",503);
      const result=await this.opencode.models(AbortSignal.timeout(5000));
      if(!Array.isArray(result.data))throw agentError("AGENT_MODEL_CATALOG_INVALID",502);
      remote=result.data.filter(m=>m.providerID==="llamacpp");
    }catch{
      state=this.config.mode==="off"?"disabled":"unavailable";errorCode=this.config.mode==="off"?"AGENT_DISABLED":"AGENT_OPENCODE_CATALOG_UNAVAILABLE";
    }
    const catalog=new Map(this.config.manifest.models.map(m=>[m.alias,m]));
    const available=new Map(remote.map(m=>[String(m.modelID || m.id || "").replace(/^llamacpp\//,""),m]));
    const aliases=new Set([...available.keys(),...catalog.keys()]);
    const models=[...aliases].filter(alias=>/^[A-Za-z0-9._:-]{1,160}$/.test(alias)).map(alias=>{
      const local=catalog.get(alias),server=available.get(alias),verified=readyModel(local),present=Boolean(server && server.enabled!==false);
      const matching=Boolean(server?.limit?.context===local?.context && server?.capabilities?.tools===true);
      const ready=state==="ready" && present && verified && matching;
      const failed=local?.lastProbe?.status==='failed';
      const validation=failed?{status:'failed',at:typeof local.lastProbe.at==='string' && Number.isFinite(Date.parse(local.lastProbe.at))?local.lastProbe.at:null,errorCode:/^[A-Z0-9_]{1,96}$/.test(local.lastProbe.errorCode || '')?local.lastProbe.errorCode:null}:null;
      const reason=ready?null:state!=="ready"?errorCode:!verified?failed?"AGENT_MODEL_PROBE_FAILED":"AGENT_MODEL_UNVERIFIED":!present?"AGENT_MODEL_NOT_IN_OPENCODE":"AGENT_MODEL_CAPABILITIES_CHANGED";
      return {id:`llamacpp/${alias}`,alias,name:typeof server?.name==="string"?server.name.slice(0,160):alias,context:local?.context || server?.limit?.context || null,available:present,verified,ready,state:ready?"ready":reason,reason,...(validation?{validation}:{})};
    });
    return {source:"opencode",state,errorCode,backgroundModel:this.config.backgroundModel,models};
  }
  async select(model){
    if(this.config.mode==="off")throw agentError("AGENT_DISABLED",503);
    const catalog=await this.list({refresh:true});
    if(catalog.state!=="ready")throw agentError("AGENT_OPENCODE_CATALOG_UNAVAILABLE",503);
    const selected=catalog.models.find(m=>m.id===model);
    if(!selected?.ready)throw agentError(selected?.reason || "AGENT_MODEL_NOT_IN_OPENCODE",409);
    const result=await this.call("control",{backgroundModel:model});
    this.config.backgroundModel=model;
    this.cached={...catalog,backgroundModel:model};
    return {backgroundModel:model,appliesTo:"pending-and-new-background-jobs",activeRuns:"unchanged",requeued:result.requeued || 0};
  }
}
