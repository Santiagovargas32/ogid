// Mantiene el presupuesto hasta el último byte; cancelar también cancela un reader lento.
export async function readBoundedBody(response, {signal, maxBytes=2_000_000}={}) {
  if(Number(response.headers.get('content-length') || 0)>maxBytes){await response.body?.cancel();throw Error('response-too-large');}
  if(!response.body)return new Uint8Array();
  const reader=response.body.getReader();let bytes=0;const chunks=[];
  const abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  try {
    signal?.throwIfAborted();
    while(true){const {done,value}=await reader.read();signal?.throwIfAborted();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();throw Error('response-too-large');}chunks.push(value);}
    return Buffer.concat(chunks,bytes);
  } finally {signal?.removeEventListener('abort',abort);reader.releaseLock();}
}
