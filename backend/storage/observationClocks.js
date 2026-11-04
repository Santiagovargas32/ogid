const topClocks=new Set(['fetchedAt','receivedAt','firstSeenAt','lastSeenAt','archiveLastSeenAt']);
const provenanceClocks=new Set(['fetchedAt','observedAt','checkedAt']);
const clockPath=path=>Array.isArray(path)&&(path.length===1&&topClocks.has(path[0])||path.length===2&&path[0]==='provenance'&&provenanceClocks.has(path[1])||path.length===3&&path[0]==='provenances'&&Number.isSafeInteger(path[1])&&path[1]>=0&&provenanceClocks.has(path[2]));
const clockValue=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));
const invalid=()=>Object.assign(Error('Invalid observation clocks'),{code:'STORAGE_OBSERVATION_CLOCKS_INCOMPLETE'});

// Preserve JSON key order and every original value. Publication and content
// dates remain in the stable body; only transport/observation clocks separate.
export function splitObservationClocks(payload){
 const body=JSON.parse(payload),clocks=[];
 const take=(object,keys,path=[])=>{if(!object||typeof object!=='object'||Array.isArray(object))return;for(const key of keys)if(Object.hasOwn(object,key)&&clockValue(object[key])){clocks.push({path:[...path,key],value:object[key]});object[key]=null;}};
 take(body,topClocks);
 if(body&&typeof body==='object'&&!Array.isArray(body)){
  take(body.provenance,provenanceClocks,['provenance']);
  if(Array.isArray(body.provenances))body.provenances.forEach((value,index)=>take(value,provenanceClocks,['provenances',index]));
 }
 return {payload:JSON.stringify(body),clocks};
}

export function restoreObservationClocks(body,clocks){
 if(!Array.isArray(clocks))throw invalid();
 for(const entry of clocks){
  if(!entry||!clockPath(entry.path)||!clockValue(entry.value))throw invalid();
  let target=body;for(const key of entry.path.slice(0,-1)){if(!target||typeof target!=='object'||!Object.hasOwn(target,key))throw invalid();target=target[key];}
  const key=entry.path.at(-1);if(!target||typeof target!=='object'||!Object.hasOwn(target,key)||target[key]!==null)throw invalid();target[key]=entry.value;
 }
 return body;
}
