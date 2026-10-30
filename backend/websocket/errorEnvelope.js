function text(value){
  if(!['string','number','boolean'].includes(typeof value))return undefined;
  let result='',bytes=0;
  for(const char of String(value)){const length=Buffer.byteLength(char);if(bytes+length>512)break;result+=char;bytes+=length;}
  return result;
}
export function compactError(data={},meta={}){
  const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,text(value?.[key])]).filter(([,v])=>v!==undefined));
  return {data:{...pick(data,['message','details','code','domain','phase','requestId']),...(typeof data.recoverable==='boolean'?{recoverable:data.recoverable}:{})},meta:pick(meta,['domain','phase','requestId','revision','lastRefreshAt'])};
}
