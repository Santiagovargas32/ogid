// OpenCode 2.0.31 /api/event: volatile SSE, data is JSON encoded V2Event.
// Events wake reconciliation; they never constitute a durable completion receipt.
export async function readEvents(body,onEvent,signal) {
 const reader=body.getReader(),decoder=new TextDecoder();let pending='';
 const abort=()=>void reader.cancel();signal.addEventListener('abort',abort,{once:true});
 try{for(;;){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');
  if(pending.length>2097152)throw Error('OPENCODE_EVENT_TOO_LARGE');
  let end;while((end=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(!data)continue;let event;try{event=JSON.parse(data);if(typeof event==='string')event=JSON.parse(event);}catch{continue;}onEvent(event);}
 }}finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
