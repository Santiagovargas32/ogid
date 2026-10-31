import {randomUUID} from 'node:crypto';
import {stableHash} from '../utils/stableHash.js';
import {getInstrumentById} from '../services/market/instrumentRegistry.js';
import {agentError} from '../services/agent/contracts.js';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9._:-]{1,160}$/.test(v);
const tasks={brief:'global_intelligence_brief',outlook:'market_outlook_global',assessment:'geopolitical_alert_assessment',situation_analysis:'situation_analysis'};
export function validateContext(value={}) {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['view','countries','instrumentIds','situationId','alertId','from','to'].includes(k)))throw agentError('AGENT_INVALID_CONTEXT');
 const result={view:value.view||'dashboard',countries:value.countries||[],instrumentIds:value.instrumentIds||[]};
 if(!id(result.view)||!Array.isArray(result.countries)||result.countries.length>50||result.countries.some(c=>!/^([A-Z]{2})$/.test(c))||!Array.isArray(result.instrumentIds)||result.instrumentIds.length>50||result.instrumentIds.some(i=>!id(i)||getInstrumentById(i)?.verificationStatus!=='verified'))throw agentError('AGENT_INVALID_CONTEXT');
 for(const key of ['situationId','alertId'])if(value[key]!==undefined){if(!id(value[key]))throw agentError('AGENT_INVALID_CONTEXT');result[key]=value[key];}
 for(const key of ['from','to'])if(value[key]!==undefined){if(typeof value[key]!=='string'||!Number.isFinite(Date.parse(value[key])))throw agentError('AGENT_INVALID_CONTEXT');result[key]=new Date(value[key]).toISOString();}
 if(result.from&&result.to&&result.from>result.to)throw agentError('AGENT_INVALID_CONTEXT');
 return result;
}
export function captureContext(repo,value) {
 const context=validateContext(value),at=new Date(repo.now()).toISOString();
 if(context.situationId){const row=repo.db.prepare('SELECT revision FROM situation_entities WHERE entity_id=?').get(context.situationId);if(!row)throw agentError('SITUATION_NOT_FOUND',404);context.situationRevision=row.revision;context.domainSequence=repo.situations.upper();}
 if(context.alertId){const row=repo.db.prepare('SELECT revision FROM geopolitical_alerts WHERE alert_id=?').get(context.alertId);if(!row)throw agentError('AGENT_ALERT_NOT_FOUND',404);context.alertRevision=row.revision;}
 if(context.from&&(context.from>at||Date.parse(at)-Date.parse(context.from)>31*86400000))throw agentError('AGENT_INVALID_CONTEXT');
 if(context.to&&context.to>at)throw agentError('AGENT_INVALID_CONTEXT');
 return {...context,capturedAt:at};
}
export function requestAgent(repo,{sessionId,deviceId,key,family,scope,context={}}) {
 const session=repo.owned(sessionId,deviceId),descriptor=validateContext(context);
 if(!id(key)||!Object.hasOwn(tasks,family)||scope!==undefined&&!id(scope))throw agentError('AGENT_INVALID_ARGUMENTS');
 if(family==='brief'&&scope&&scope!=='global')throw agentError('AGENT_INVALID_SCOPE');
 let task=tasks[family];
 if(family==='outlook'&&scope&&scope!=='global'){if(getInstrumentById(scope)?.verificationStatus!=='verified')throw agentError('AGENT_INVALID_SCOPE');task='instrument_outlook';descriptor.instrumentIds=[scope];}
 if(family==='situation_analysis'){descriptor.situationId=scope||descriptor.situationId;if(!descriptor.situationId)throw agentError('AGENT_INVALID_SCOPE');}
 if(family==='assessment'){descriptor.alertId=scope||descriptor.alertId;if(!descriptor.alertId)throw agentError('AGENT_INVALID_SCOPE');}
 const selectedScope=family==='situation_analysis'?descriptor.situationId:task==='instrument_outlook'?scope:'global';
 const requestHash=stableHash({family,scope:selectedScope,context:descriptor});
 return repo.db.transaction(()=>{
  const previous=repo.db.prepare('SELECT * FROM agent_messages WHERE session_id=? AND idempotency_key=?').get(sessionId,key);
  if(previous){if(JSON.parse(previous.payload_json).requestHash!==requestHash)throw agentError('AGENT_IDEMPOTENCY_CONFLICT',409);const job=repo.db.prepare('SELECT job_id jobId FROM agent_jobs WHERE message_id=?').get(previous.message_id);return {...job,messageId:previous.message_id,replayed:true};}
  const frozen=captureContext(repo,descriptor),messageId=randomUUID();
  repo.db.prepare('INSERT INTO agent_messages VALUES(?,?,?,?,?,?)').run(messageId,sessionId,'user',frozen.capturedAt,JSON.stringify({text:`Solicitud: ${family}`,requestHash,family,context:frozen}),key);
  const result=repo.enqueue({task,scope:selectedScope,model:session.model,key:`request:${messageId}`,sessionId,messageId,priority:10,input:{origin:'user',family,context:frozen,selectedInstrumentIds:frozen.instrumentIds,...(task==='situation_analysis'?{situationId:selectedScope}:{} )}});
  return {...result,messageId,context:frozen};
 }).immediate();
}
