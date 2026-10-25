// Decode transport envelopes only; never infer success from a tool's name.
export function toolReceipt(value,depth=0){
  if(depth>6||value==null)return null;
  if(typeof value==='string'){
    if(value.length>2097152)return null;
    try{return toolReceipt(JSON.parse(value),depth+1);}catch{
      // OpenCode validates the advertised schema before dispatching MCP. Its
      // error includes argument values: inspect only the validation preamble.
      const preamble=value.split('Arguments provided:')[0].slice(0,4096);
      if(/^Invalid arguments for tool ["']/i.test(preamble)){
        const issues=[...preamble.matchAll(/^- ([A-Za-z0-9_.]{1,128}): Expected (string|number|integer|boolean)/gm)].slice(0,16).map(m=>({path:m[1].split('.'),code:'invalid_type',expected:m[2]}));
        return {applicationOk:false,applicationCode:'INVALID_ARGUMENTS',validation:{stage:'opencode-tool-schema',issues}};
      }
      return null;
    }
  }
  if(typeof value!=='object')return null;
  const identity=value.identity&&/^[a-f0-9]{64}$/.test(value.identity.hash||'')?{returnedContractHash:value.identity.hash,componentIdentity:{version:value.identity.version,hash:value.identity.hash,adapterVersion:value.identity.adapterVersion,pid:value.identity.pid,startedAt:value.identity.startedAt,profile:value.identity.profile}}:{};
  if(value.ok===false||value.isError===true&&value.error)return {...identity,applicationOk:false,applicationCode:/^[A-Z_]{2,80}$/.test(value.error?.code||'')?value.error.code:'MCP_TOOL_FAILED',validation:value.error?.details?{stage:String(value.error.details.stage||'unknown').slice(0,64),issues:(Array.isArray(value.error.details.issues)?value.error.details.issues:[]).slice(0,16).map(i=>({path:(Array.isArray(i.path)?i.path:[]).slice(0,16).map(p=>String(p).slice(0,64)),code:String(i.code||'unknown').slice(0,64),expected:typeof i.expected==='string'?i.expected.slice(0,64):null}))}:null};
  if(value.ok===true&&value.origin==='OGID'&&!value.readReceipt&&identity.returnedContractHash)return {...identity,applicationOk:true,contentRead:false};
  if(value.ok===true&&value.origin==='OGID'&&value.readReceipt){
    const receipt=value.readReceipt,hash=receipt.contractHash;
    if(!/^[a-f0-9]{64}$/.test(hash||'')||identity.returnedContractHash&&identity.returnedContractHash!==hash)return {...identity,applicationOk:false,applicationCode:'MCP_CONTRACT_MISMATCH',contentRead:false};
    return {...identity,applicationOk:true,returnedContractHash:hash,contentRead:receipt.contentRead===true,returnedSnapshotId:receipt.snapshotId,evidenceIds:receipt.evidenceIds||[]};
  }
  for(const child of Array.isArray(value)?value.slice(0,32):[value.structuredContent,value.content,value.text,value.output]){const found=toolReceipt(child,depth+1);if(found){if(value.isError===true&&found.applicationOk)return {applicationOk:false,applicationCode:'MCP_TOOL_FAILED'};return found;}}
  return value.isError===true?{applicationOk:false,applicationCode:'MCP_TOOL_FAILED'}:null;
}
