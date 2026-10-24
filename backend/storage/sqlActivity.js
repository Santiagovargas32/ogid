// A single worker writes this bounded buffer. The parent can inspect a native
// SQLite stall even when that worker's event loop cannot emit telemetry.
// SQL bindings, rows, paths and provider content never enter this channel.
const METHODS=['idle','get','all','run','iterate'];
const PHASES=['none','begin','body','commit','rollback'];
const TEXT_OFFSET=64,SIZE=1088;
export const createSqlActivityBuffer=()=>new SharedArrayBuffer(SIZE);
export class SqlActivity {
  constructor(buffer){this.buffer=buffer;this.ints=new Int32Array(buffer,0,8);this.numbers=new Float64Array(buffer,32,4);this.text=new Uint8Array(buffer,TEXT_OFFSET);this.stack=[];}
  update(fn){Atomics.add(this.ints,0,1);try{fn();}finally{Atomics.add(this.ints,0,1);}}
  write(bytes,inTransaction){if(inTransaction&&this.stack.length)this.stack.at(-1).bytes=(this.stack.at(-1).bytes||0)+bytes;else if(!inTransaction)this.commits?.committed(bytes);}
  finish(success){const value=this.stack.at(-1);if(success&&value?.bytes){if(this.stack.length>1)this.stack.at(-2).bytes=(this.stack.at(-2).bytes||0)+value.bytes;else this.commits?.committed(value.bytes);}this.transaction('end');}
  statement(sql){
    const safe=String(sql).replace(/'(?:''|[^'])*'/g,'?').replace(/\b\d+(?:\.\d+)?\b/g,'?').slice(0,240),bytes=new TextEncoder().encode(safe);
    return {start:method=>this.update(()=>{this.ints[1]=METHODS.indexOf(method);this.ints[2]=bytes.length;this.text.set(bytes);this.numbers[0]=Date.now();this.numbers[1]=0;}),end:durationMs=>this.update(()=>{this.ints[1]=0;this.numbers[1]=durationMs;})};
  }
  transaction(phase){
    if(phase==='begin')this.stack.push({startedAt:Date.now(),phase});
    else if(phase==='end')this.stack.pop();
    else if(this.stack.length)this.stack.at(-1).phase=phase;
    this.update(()=>{const current=this.stack.at(-1);this.ints[3]=PHASES.indexOf(current?.phase||'none');this.ints[4]=this.stack.length;this.numbers[2]=current?.startedAt||0;});
  }
}
export function readSqlActivity(buffer,now=Date.now()){
  if(!buffer)return null;
  const ints=new Int32Array(buffer,0,8),numbers=new Float64Array(buffer,32,4),text=new Uint8Array(buffer,TEXT_OFFSET);
  for(let n=0;n<4;n++){
    const sequence=Atomics.load(ints,0);if(!sequence)return null;if(sequence%2)continue;
    const method=ints[1],length=ints[2],phase=ints[3],depth=ints[4],started=numbers[0],duration=numbers[1],transactionAt=numbers[2];
    const sql=new TextDecoder().decode(text.slice(0,Math.min(length,1024)));
    if(sequence!==Atomics.load(ints,0))continue;
    return {state:method?'executing':'idle',method:METHODS[method]||null,sql:sql||null,startedAt:started?new Date(started).toISOString():null,elapsedMs:method?Math.max(0,now-started):null,lastDurationMs:method?null:duration,transaction:depth?{phase:PHASES[phase],depth,startedAt:new Date(transactionAt).toISOString(),elapsedMs:Math.max(0,now-transactionAt)}:null};
  }
  return {state:'updating'};
}
export function trackTransactions(database,activity,{beforeBegin=null,onSlowCommit=null}={}){
  const transaction=database.transaction.bind(database);
  database.transaction=fn=>{
    let commitStarted;
    const native=transaction(function(...args){activity.transaction('body');try{const result=fn.apply(this,args);activity.transaction('commit');commitStarted=performance.now();return result;}catch(error){activity.transaction('rollback');throw error;}});
    const wrap=mode=>function(...args){beforeBegin?.();commitStarted=null;activity.transaction('begin');let success=false;try{const value=mode.apply(this,args);success=true;return value;}finally{if(commitStarted!==null && performance.now()-commitStarted>=1000)onSlowCommit?.(performance.now()-commitStarted);activity.finish(success);}};
    const result=wrap(native);for(const mode of ['deferred','immediate','exclusive'])result[mode]=wrap(native[mode]);
    result.database=database;return result;
  };
}
