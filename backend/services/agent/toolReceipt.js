// Decode transport envelopes only; never infer success from a tool's name.
export function toolReceipt(value,depth=0){
  if(depth>6||value==null)return null;
  if(typeof value==='string'){if(value.length>2097152)return null;try{return toolReceipt(JSON.parse(value),depth+1);}catch{return null;}}
  if(typeof value!=='object')return null;
  if(value.ok===false||value.isError===true&&value.error)return {applicationOk:false,applicationCode:/^[A-Z_]{2,80}$/.test(value.error?.code||'')?value.error.code:'MCP_TOOL_FAILED',validation:value.error?.details?{stage:String(value.error.details.stage||'unknown').slice(0,64),issues:(Array.isArray(value.error.details.issues)?value.error.details.issues:[]).slice(0,16).map(i=>({path:(Array.isArray(i.path)?i.path:[]).slice(0,16).map(p=>String(p).slice(0,64)),code:String(i.code||'unknown').slice(0,64),expected:typeof i.expected==='string'?i.expected.slice(0,64):null}))}:null};
  if(value.ok===true&&value.origin==='OGID'&&value.readReceipt)return {applicationOk:true,returnedContractHash:value.readReceipt.contractHash,contentRead:value.readReceipt.contentRead===true,returnedSnapshotId:value.readReceipt.snapshotId,evidenceIds:value.readReceipt.evidenceIds||[]};
  for(const child of Array.isArray(value)?value.slice(0,32):[value.structuredContent,value.content,value.text,value.output]){const found=toolReceipt(child,depth+1);if(found){if(value.isError===true&&found.applicationOk)return {applicationOk:false,applicationCode:'MCP_TOOL_FAILED'};return found;}}
  return value.isError===true?{applicationOk:false,applicationCode:'MCP_TOOL_FAILED'}:null;
}
