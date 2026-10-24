import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
// A backend-owned acquisition executor, with no DB handles or extra scheduler.
// SQL readers never perform HTTP or parse provider bodies.
export class SourceAcquisition {
  constructor(){this.pending=new Map();this.accepting=true;}
  run(input){
    if(!this.accepting||this.pending.size>=4)return Promise.reject(Object.assign(Error('Acquisition backpressure'),{code:'SOURCE_BUSY'}));
    if(!this.worker){
      this.worker=new Worker(new URL('./sourceAcquisitionWorker.js',import.meta.url),{execArgv:[]});
      this.worker.on('message',m=>{const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Object.assign(Error(m.error.code),m.error)):p.resolve(m.result);});
      this.worker.on('error',()=>this.fail('SOURCE_WORKER_FAILED'));
      this.worker.on('exit',()=>{this.worker=null;if(this.pending.size)this.fail('SOURCE_WORKER_EXITED');});
    }
    // OfficialSourceService already single-flights acquisition. Reject rather
    // than silently enqueueing overlapping ownership in this one executor.
    if(this.pending.size)return Promise.reject(Object.assign(Error('Acquisition busy'),{code:'SOURCE_BUSY'}));
    return new Promise((resolve,reject)=>{
      const id=input.attemptId||randomUUID();
      const timer=setTimeout(()=>{this.fail('SOURCE_WORKER_TIMEOUT');void this.worker?.terminate();},input.timeoutMs+5000);
      this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({type:'acquire',id,input});
    });
  }
  cancel(attemptId){this.worker?.postMessage({type:'cancel',id:attemptId});return {requested:true};}
  fail(code){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(Error(code),{code}));}this.pending.clear();}
  async close(){this.accepting=false;this.fail('SOURCE_CANCELLED');await this.worker?.terminate();this.worker=null;}
}
