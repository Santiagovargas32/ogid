import {readBoundedBody} from "../shared/boundedResponse.js";
import {setTimeout as wait} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {agentError} from './contracts.js';
import {localUrl,readyModel} from './config.js';
export const MODEL_POLICY=Object.freeze({inventoryMs:10000,loadMs:360000,probeMs:180000,cancelMs:15000});
export const catalogModel=m=>Boolean(m && /^[A-Za-z0-9._:-]{1,160}$/.test(m.alias||'') && Number.isSafeInteger(m.context)&&m.context>0 && (readyModel(m)||m.state==='available'));
const option=(row,name)=>{const a=row.status?.args;const i=Array.isArray(a)?a.indexOf(name):-1;return i>=0?Number(a[i+1]):null;};
export function catalogEntry(row,prior){
 if(!/^[A-Za-z0-9._:-]{1,160}$/.test(row.id||''))return null;
 const context=option(row,'--ctx-size')||row.meta?.n_ctx||prior?.context,slots=option(row,'--parallel')||prior?.slots||1;
 const compatible=readyModel(prior)&&prior.context===context&&prior.slots===slots;
 return {alias:row.id,context,slots,state:compatible?'ready':'available',tools:compatible,structuredOutput:compatible,serverContextVerified:compatible,...(compatible?{probe:prior.probe}:{}),resident:row.status?.value==='loaded',loadState:row.status?.value||'unknown',contextSource:'router-configured',...(prior?.lastProbe?{lastProbe:prior.lastProbe}:{})};
}
export class LlamaModels {
 constructor({upstream,apiKey,fetchImpl=fetch,manifest,policy={}}){this.base=localUrl(upstream).origin;this.headers={Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'};this.fetch=fetchImpl;this.manifest=manifest;this.policy={...MODEL_POLICY,...policy};}
 async request(path,{body,signal,deadline=this.policy.inventoryMs}={}){
  const r=await this.fetch(new URL(path,this.base),{method:body?'POST':'GET',headers:this.headers,redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(deadline)]),...(body?{body:JSON.stringify(body)}:{})});
  if(!r.ok){await r.body?.cancel();throw agentError(`AGENT_MODEL_HTTP_${r.status}`,503);}return JSON.parse((await readBoundedBody(r,{maxBytes:2097152,signal})).toString('utf8'));
 }
 async inventory(signal){const x=await this.request('/models',{signal});if(!Array.isArray(x.data))throw agentError('AGENT_MODEL_CATALOG_INVALID',502);return x.data;}
 async discover(signal){const rows=await this.inventory(signal);const models=rows.map(r=>{const prior=this.manifest.models.find(m=>m.alias===r.id),entry=catalogEntry(r,prior);return entry?(prior?Object.assign(prior,entry):entry):null;}).filter(catalogModel);this.manifest.models.splice(0,this.manifest.models.length,...models);return this.manifest;}
 async idle(alias,signal){const slots=await this.request(`/slots?model=${encodeURIComponent(alias)}&autoload=false`,{signal});if(!Array.isArray(slots)||!slots.length||slots.some(s=>s.is_processing!==false))throw agentError('AGENT_MODEL_BUSY',409);}
 async load(alias,signal){
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(this.policy.loadMs)]);
  let rows=await this.inventory(signal),row=rows.find(m=>m.id===alias);if(!row)throw agentError('AGENT_MODEL_NOT_IN_ROUTER',404);
  if(row.status?.value!=='loaded'&&row.status?.value!=='loading'){
   for(const other of rows.filter(m=>m.status?.value!=='unloaded'&&m.id!==alias)){if(other.status?.value!=='loaded')throw agentError('AGENT_MODEL_TRANSITION',409);await this.idle(other.id,signal);}
   // One mutation only. A lost response is reconciled by inventory, not retried.
   try{await this.request('/models/load',{body:{model:alias},signal,deadline:this.policy.loadMs});}
   catch(error){rows=await this.inventory(signal);if(!['loaded','loading'].includes(rows.find(m=>m.id===alias)?.status?.value))throw error;}
  }
  const until=Date.now()+this.policy.loadMs;
  for(;;){rows=await this.inventory(signal);row=rows.find(m=>m.id===alias);if(row?.status?.value==='loaded')break;if(row?.status?.value!=='loading'||Date.now()>=until)throw agentError('AGENT_MODEL_LOAD_FAILED',503);await wait(500,undefined,{signal});}
  const props=await this.request(`/props?model=${encodeURIComponent(alias)}&autoload=false`,{signal});
  const model=this.manifest.models.find(m=>m.alias===alias),context=props.default_generation_settings?.n_ctx;
  if(!model||context!==model.context||props.total_slots!==model.slots)throw agentError('BROKER_CONTEXT_CHANGED',409);
  const p=props.default_generation_settings?.params;if(p?.n_predict!==-1||p?.max_tokens!==-1)throw agentError('BROKER_OUTPUT_POLICY_CHANGED',409);
  for(const m of this.manifest.models){m.resident=m.alias===alias;m.loadState=m.resident?'loaded':'unloaded';}
  return model;
 }
 async validate(alias,signal){
  let model=this.manifest.models.find(m=>m.alias===alias);
  try{model=await this.load(alias,signal);}catch(error){if(model)model.lastProbe={status:'failed',at:new Date().toISOString(),errorCode:error.code||'AGENT_MODEL_LOAD_FAILED'};throw error;}
  if(readyModel(model))return model;
  const probeSignal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(this.policy.probeMs)]),nonce=randomUUID(),tool={type:'function',function:{name:'ogid_probe',description:'Return the supplied nonce',parameters:{type:'object',properties:{nonce:{type:'string'}},required:['nonce'],additionalProperties:false}}};
  try{
   const messages=[{role:'user',content:`Call ogid_probe with nonce ${nonce}.`}];
   const first=await this.request('/v1/chat/completions',{signal:probeSignal,deadline:this.policy.probeMs,body:{model:alias,messages,tools:[tool],tool_choice:'required',stream:false,reasoning_effort:'low'}});
   const answer=first.choices?.[0]?.message,call=answer?.tool_calls?.[0];
   if(call?.function?.name!=='ogid_probe'||JSON.parse(call.function.arguments).nonce!==nonce)throw agentError('AGENT_MODEL_TOOLS_FAILED',409);
   const body={model:alias,messages:[...messages,answer,{role:'tool',tool_call_id:call.id,content:JSON.stringify({nonce})},{role:'user',content:'Return JSON with ok=true and the exact nonce returned by the tool.'}],stream:true,reasoning_effort:'low',response_format:{type:'json_schema',json_schema:{name:'ogid_probe',strict:true,schema:{type:'object',properties:{ok:{type:'boolean'},nonce:{type:'string'}},required:['ok','nonce'],additionalProperties:false}}}};
   const r=await this.fetch(new URL('/v1/chat/completions',this.base),{method:'POST',headers:this.headers,body:JSON.stringify(body),redirect:'error',signal:probeSignal});if(!r.ok){await r.body?.cancel();throw agentError('AGENT_MODEL_STREAM_FAILED',409);}
   let pending='',output='',bytes=0;for await(const chunk of r.body){bytes+=chunk.length;if(bytes>2097152)throw agentError('AGENT_MODEL_PROBE_TOO_LARGE',409);pending+=Buffer.from(chunk).toString('utf8');let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).trim();pending=pending.slice(end+1);if(line.startsWith('data:')&&line.slice(5).trim()!=='[DONE]'){const event=JSON.parse(line.slice(5));output+=event.choices?.[0]?.delta?.content||'';}}}
   const value=JSON.parse(output);if(value.ok!==true||value.nonce!==nonce)throw agentError('AGENT_MODEL_STRUCTURED_OUTPUT_FAILED',409);
   // Exercise a live stream abort, then confirm slot release before a switch.
   const cancel=new AbortController(),c=await this.fetch(new URL('/v1/chat/completions',this.base),{method:'POST',headers:this.headers,body:JSON.stringify({model:alias,messages:[{role:'user',content:'Count positive integers in words until interrupted.'}],stream:true,reasoning_effort:'low'}),redirect:'error',signal:AbortSignal.any([probeSignal,cancel.signal])});
   if(!c.ok){await c.body?.cancel();throw agentError('AGENT_MODEL_CANCELLATION_FAILED',409);}const reader=c.body.getReader();try{const chunk=await reader.read();if(chunk.done)throw agentError('AGENT_MODEL_CANCELLATION_UNVERIFIED',409);cancel.abort();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const until=Date.now()+this.policy.cancelMs;for(;;){try{await this.idle(alias,probeSignal);break;}catch(error){if(error.code!=='AGENT_MODEL_BUSY'||Date.now()>=until)throw error;await wait(250,undefined,{signal:probeSignal});}}
   Object.assign(model,{state:'ready',tools:true,structuredOutput:true,serverContextVerified:true,probe:{verifiedAt:new Date().toISOString(),wireNoFixedCap:true,streaming:true,cancellation:true,tools:true,structuredOutput:true,kind:'router tool roundtrip, streamed JSON and live abort; not semantic attestation'},lastProbe:{status:'passed',at:new Date().toISOString()}});return model;
  }catch(error){model.lastProbe={status:'failed',at:new Date().toISOString(),errorCode:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'AGENT_MODEL_PROBE_FAILED'};throw error;}
 }
}
