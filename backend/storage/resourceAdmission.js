import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { RUNTIME_POLICY } from '../config/runtimePolicy.js';

const states=['unknown','normal','degraded','recovering'];
const reasons=[null,'low-memory','memory-pressure','io-pressure','critical-pressure','sample-unavailable'];
export const createPressureBuffer=()=>new SharedArrayBuffer(64);
export function writePressure(buffer,snapshot){
  const ints=new Int32Array(buffer,0,4),values=new Float64Array(buffer,16,6);
  Atomics.add(ints,0,1);
  ints[1]=states.indexOf(snapshot.state);ints[2]=snapshot.critical?1:0;ints[3]=Math.max(0,reasons.indexOf(snapshot.reason));
  values.set([snapshot.sampledAt||0,snapshot.availableBytes??-1,snapshot.memoryFull??-1,snapshot.ioFull??-1,snapshot.since||0,snapshot.recoveringSince||0]);
  Atomics.add(ints,0,1);
}
export function readPressure(buffer,{now=Date.now(),staleMs=RUNTIME_POLICY.storage.resourcePressure.staleMs}={}){
  const ints=new Int32Array(buffer,0,4),values=new Float64Array(buffer,16,6);
  for(let n=0;n<4;n++){
    const seq=Atomics.load(ints,0);if(seq%2)continue;
    const state=states[ints[1]]||'unknown',critical=ints[2]===1,reason=reasons[ints[3]],[sampledAt,availableBytes,memoryFull,ioFull,since,recoveringSince]=values.slice();
    if(seq!==Atomics.load(ints,0))continue;
    const fresh=sampledAt>0&&now>=sampledAt&&now-sampledAt<=staleMs;
    return {state:fresh?state:'unknown',critical:fresh?critical:false,reason:!fresh?'sample-unavailable':state==='normal'?null:reason||'recovery-window',sampledAt:sampledAt||null,ageMs:sampledAt?Math.max(0,now-sampledAt):null,availableBytes:!sampledAt||availableBytes<0?null:availableBytes,memoryFull:!sampledAt||memoryFull<0?null:memoryFull,ioFull:!sampledAt||ioFull<0?null:ioFull,since:since||null,recoveringSince:recoveringSince||null};
  }
  return {state:'unknown',critical:false,reason:'sample-updating',sampledAt:null,ageMs:null};
}

export class PressurePolicy {
  constructor(policy=RUNTIME_POLICY.storage.resourcePressure){this.policy=policy;this.snapshot={state:'unknown',critical:false};this.badSamples=0;}
  observe(sample,now=Date.now(),monotonic=now){
    const p=this.policy,previous=this.snapshot;
    const lastMonotonic=this.lastMonotonic;this.lastMonotonic=monotonic;
    const valid=sample&&['availableBytes','memoryFull','ioFull'].every(k=>Number.isFinite(sample[k])&&sample[k]>=0)&&sample.memoryFull<=100&&sample.ioFull<=100;
    if(!valid){this.badSamples=0;this.recoveryStarted=null;this.snapshot={state:'unknown',critical:false,sampledAt:now,since:now,reason:'sample-unavailable'};return this.snapshot;}
    const gap=lastMonotonic===undefined||monotonic-lastMonotonic>p.sampleIntervalMs*2||monotonic<lastMonotonic;
    if(gap)this.recoveryStarted=null;
    const critical=sample.availableBytes<p.criticalAvailableBytes||sample.memoryFull>=p.criticalMemoryFull||sample.ioFull>=p.criticalIoFull;
    const reason=sample.availableBytes<p.lowAvailableBytes?'low-memory':sample.memoryFull>=p.memoryFull?'memory-pressure':sample.ioFull>=p.ioFull?'io-pressure':null;
    this.badSamples=reason?(gap?1:this.badSamples+1):0;
    let state=previous.state, recoveringSince=gap?null:previous.recoveringSince;
    if(critical||this.badSamples>=p.badSamples){state='degraded';recoveringSince=null;this.recoveryStarted=null;}
    else if(state==='normal'&&!gap)state='normal';
    else if(state==='unknown'&&!critical&&!reason&&!previous.sampledAt)state='normal';
    else {
      const healthy=sample.availableBytes>=p.resumeAvailableBytes&&sample.memoryFull<p.resumeMemoryFull&&sample.ioFull<p.resumeIoFull;
      if(healthy){recoveringSince??=now;this.recoveryStarted??=monotonic;state=monotonic-this.recoveryStarted>=p.recoveryMs?'normal':'recovering';}
      else {state='degraded';recoveringSince=null;this.recoveryStarted=null;}
    }
    this.snapshot={...sample,state,critical,sampledAt:now,since:state===previous.state?previous.since:now,recoveringSince:state==='normal'?null:recoveringSince,reason:critical?'critical-pressure':reason};
    return this.snapshot;
  }
}

export const pressureAllows=(status,kind)=>kind==='control'||kind==='commit'||kind==='read'||status.state==='normal'||kind==='journal'&&status.state!=='unknown'&&!status.critical;
export function pressureError(status){return Object.assign(Error('Work deferred until host resources recover'),{code:'STORAGE_RESOURCE_PRESSURE',statusCode:503,retryAfterMs:1000,notExecuted:true,details:{state:status.state,critical:status.critical,reason:status.reason}});}

// One sampler and one heavy reservation are shared by all storage lanes.
// The sampler writes its buffer without depending on HTTP or a SQLite thread.
export class ResourceAdmission extends EventEmitter {
  constructor({enabled=true,now=Date.now,policy=RUNTIME_POLICY.storage.resourcePressure,workerFactory=data=>new Worker(new URL('./resourcePressureWorker.js',import.meta.url),{workerData:data,execArgv:[]})}={}){
    super();Object.assign(this,{enabled,now,policy,workerFactory});this.buffer=createPressureBuffer();this.evaluator=new PressurePolicy(policy);this.rejected=0;this.waiters=new Map();
  }
  status(){return {...(this.enabled?readPressure(this.buffer,{now:this.now(),staleMs:this.policy.staleMs}):{state:'normal',critical:false,reason:null}),enabled:this.enabled,heavyActive:this.owner?1:0,deferred:this.rejected};}
  observe(sample){const previous=this.status();writePressure(this.buffer,this.evaluator.observe(sample,this.now()));this.changed(previous);}
  changed(previous){const current=this.status();if(previous.state!==current.state||previous.critical!==current.critical)this.emit('change',current);this.emit('sample',current);}
  async start(){
    if(!this.enabled||this.worker)return;
    await new Promise((resolve,reject)=>{
      const worker=this.worker=this.workerFactory({buffer:this.buffer,policy:this.policy});
      let ready=false,previous=this.status();
      worker.on('message',()=>{const before=previous;previous=this.status();this.changed(before);if(!ready){ready=true;resolve();}});
      worker.on('error',reason=>{this.observe(null);if(!ready)reject(reason);});
      worker.on('exit',()=>{if(!this.closed){this.observe(null);if(!ready)reject(Error('Resource sampler exited'));}});
    });
  }
  assert(kind){const status=this.status();if(!pressureAllows(status,kind)){this.rejected++;throw pressureError(status);}}
  offer(id,queuedAt,eligible){if(eligible)this.waiters.set(id,queuedAt);else this.waiters.delete(id);}
  eligible(id){if(this.owner)return this.owner===id;let oldest=null,at=Infinity;for(const [key,value] of this.waiters)if(value<at){at=value;oldest=key;}return oldest===null||oldest===id;}
  withdraw(id){if(this.waiters.delete(id))this.emit('available');}
  acquire(id){if(!this.eligible(id))return false;this.waiters.delete(id);this.owner=id;return true;}
  release(id){if(this.owner===id){this.owner=null;this.emit('available');}}
  waitReady(signal){
    if(signal?.aborted)return Promise.reject(signal.reason);
    if(this.status().state==='normal')return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{this.off('sample',check);signal?.removeEventListener('abort',abort);};
      const check=()=>{if(this.status().state==='normal'){cleanup();resolve();}};
      const abort=()=>{cleanup();reject(signal.reason);};
      this.on('sample',check);signal?.addEventListener('abort',abort,{once:true});check();
    });
  }
  async close(){this.closed=true;await this.worker?.terminate();this.worker=null;}
}
