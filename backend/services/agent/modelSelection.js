import { catalogModel } from "./modelCatalog.js";
import { readyModel } from "./config.js";
import { agentError } from "./contracts.js";

// OpenCode is authoritative for availability; the OGID attestation remains
// authoritative for context/tools. Never forward provider settings or headers.
export class AgentModelSelection {
  constructor({config,opencode,call,now=Date.now,activate,brokerInventory,onVerified}){Object.assign(this,{config,opencode,call,now,activate,brokerInventory,onVerified});this.controller=new AbortController();}
  stop(){this.controller.abort();return this.activationTask?.catch(()=>{});}
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
    if(this.brokerInventory && state==='ready'){
      try{for(const m of await this.brokerInventory()){const local=this.config.manifest.models.find(x=>x.alias===m.id);if(local){local.resident=m.resident;local.loadState=m.loadState;if(m.verified&&m.context===local.context)Object.assign(local,{state:'ready',tools:true,structuredOutput:true,serverContextVerified:true,probe:m.probe,lastProbe:m.lastProbe});else if(m.lastProbe)local.lastProbe=m.lastProbe;}}}catch{state='unavailable';errorCode='AGENT_BROKER_CATALOG_UNAVAILABLE';}
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
      return {selectable:state==="ready"&&present&&matching&&(verified||Boolean(this.activate&&catalogModel(local))),resident:local?.resident===true,loadState:local?.loadState||"unknown",id:`llamacpp/${alias}`,alias,name:typeof server?.name==="string"?server.name.slice(0,160):alias,context:local?.context || server?.limit?.context || null,available:present,verified,ready,state:ready?"ready":reason,reason,...(validation?{validation}:{})};
    });
    return {source:"opencode",state,errorCode,backgroundModel:this.config.backgroundModel,models,activation:this.activation||null};
  }
  async select(model){
    if(this.config.mode==="off")throw agentError("AGENT_DISABLED",503);
    const catalog=await this.list({refresh:true});
    if(catalog.state!=="ready")throw agentError("AGENT_OPENCODE_CATALOG_UNAVAILABLE",503);
    const selected=catalog.models.find(m=>m.id===model);
    if(!selected?.ready && !selected?.selectable)throw agentError(selected?.reason || "AGENT_MODEL_NOT_IN_OPENCODE",409);
    if(this.activate){
      if(this.activationTask){if(this.activation.model!==model)throw agentError('AGENT_MODEL_SWITCH_IN_PROGRESS',409);return {...this.activation,pending:true};}
      this.activation={model,state:'queued',startedAt:new Date(this.now()).toISOString()};
      const task=(async()=>{
        const verified=await this.activate(model,this.controller.signal);
        if(!readyModel(verified))throw agentError('AGENT_MODEL_UNVERIFIED',409);
        Object.assign(this.config.manifest.models.find(m=>`llamacpp/${m.alias}`===model),verified);
        await this.onVerified?.(this.config.manifest);
        let result;try{result=await this.call('control',{backgroundModel:model});}catch(error){const durable=await this.call('control').catch(()=>null);if(durable?.backgroundModel!==model)throw error;result=durable;}this.config.backgroundModel=model;
        this.activation={model,state:'ready',backgroundModel:model,requeued:result.requeued||0,finishedAt:new Date(this.now()).toISOString()};this.cached=null;
      })().catch(error=>{this.activation={model,state:error.code==='STORAGE_OUTCOME_UNKNOWN'?'uncertain':'failed',errorCode:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'AGENT_MODEL_ACTIVATION_FAILED',finishedAt:new Date(this.now()).toISOString()};this.cached=null;}).finally(()=>{this.activationTask=null;});
      this.activationTask=task;
      return {...this.activation,pending:true};
    }
    const result=await this.call("control",{backgroundModel:model});
    this.config.backgroundModel=model;
    this.cached={...catalog,backgroundModel:model};
    return {backgroundModel:model,appliesTo:"pending-and-new-background-jobs",activeRuns:"unchanged",requeued:result.requeued || 0};
  }
}
