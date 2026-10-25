const keys=new Set(['validation','stage','issues','path','expected','operationId','callId','sampledAt','active','lastSuccess','lastFailure','completed','failed','upstream','state','observedAt','httpStatus','model','requestId','route','queuedAt','startedAt','inputMessageHash','phase','elapsedMs','durationMs','lastProgressAt','queue','running','resident','version','adapterVersion','ready','checkedAt','mcp','name','profile','generation','generations','jobId','fence','snapshotId','key','task','contractHash','hash','pid','consecutiveFailures','level','nextEligibleAt','probe','lastSuccessAt','recovery','causeCode','code','at','type','mcpIdentity','mcpContractMismatch','controlPlane','mcpRejections','lastMcpFailure','toolsCompleted','evidenceReads']);
export function runtimeTelemetry(value,depth=0){
  if(depth>6)return null;
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value==='string')return value.slice(0,256);
  if(Array.isArray(value))return value.slice(0,16).map(v=>runtimeTelemetry(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>keys.has(k)).map(([k,v])=>[k,runtimeTelemetry(v,depth+1)]));
  return null;
}
