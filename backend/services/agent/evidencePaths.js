const forbidden = new Set(['__proto__','prototype','constructor']);
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

export function numericPaths(data, {maxPaths=64,maxDepth=8,maxNodes=1024,maxBytes=8192}={}) {
  const paths=[];
  const pending=[{value:data,path:'',depth:0}];
  let nodes=0,bytes=0,truncated=false;
  while(pending.length) {
    if (++nodes>maxNodes) {truncated=true;break;}
    const {value,path,depth}=pending.pop();
    if(typeof value==='number' && Number.isFinite(value)) {
      const entry={path,type:'number',value};
      const size=Buffer.byteLength(JSON.stringify(entry));
      if(paths.length>=maxPaths || bytes+size>maxBytes){truncated=true;break;}
      paths.push(entry);bytes+=size;
    } else if(value && typeof value==='object') {
      if(depth>=maxDepth){truncated=true;continue;}
      const keys=Object.keys(value).filter(key=>!forbidden.has(key) && /^[A-Za-z0-9_-]+$/.test(key));
      const remaining=Math.max(0,maxNodes-nodes-pending.length);
      for(const key of keys.slice(0,remaining).reverse()) pending.push({value:value[key],path:path?`${path}.${key}`:key,depth:depth+1});
      if(keys.length>remaining)truncated=true;
    }
  }
  return {paths,truncated,maxPaths,maxDepth};
}

export function numericFactProblem(fact, data) {
  const keys=fact.path.split('.');
  if(keys.some(key=>forbidden.has(key))) return {code:'AGENT_INVALID_TECHNICAL_FACT',evidenceId:fact.evidenceId,path:fact.path};
  let value=data;
  for(const key of keys) value=value && typeof value==='object' && Object.hasOwn(value,key) ? value[key] : undefined;
  if(typeof value==='number' && Number.isFinite(value) && value===fact.value)return null;
  const suggestion=value && typeof value==='object' && Object.hasOwn(value,'value') && typeof value.value==='number' && Number.isFinite(value.value)
    ? `${fact.path}.value` : undefined;
  return {code:'AGENT_UNVERIFIED_NUMBER',evidenceId:fact.evidenceId,path:fact.path,providedValue:fact.value,
    expectedValue:typeof value==='number'&&Number.isFinite(value)?value:null,
    reason:typeof value==='number'?'exact-value-required':'numeric-path-not-found',foundType:typeOf(value),
    ...(suggestion?{suggestedPath:suggestion}:{})};
}
