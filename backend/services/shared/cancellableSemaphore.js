export class Semaphore {
  constructor(limit) { this.limit=Math.max(1,limit);this.active=0;this.waiters=[]; }
  acquire(signal) {
    if(signal?.aborted) return Promise.reject(signal.reason);
    if(this.active<this.limit){this.active++;return Promise.resolve();}
    return new Promise((resolve,reject)=>{
      const entry={resolve:()=>{signal?.removeEventListener('abort',abort);resolve();}};
      const abort=()=>{this.waiters.splice(this.waiters.indexOf(entry),1);reject(signal.reason);};
      this.waiters.push(entry);signal?.addEventListener('abort',abort,{once:true});
    });
  }
  release(){const next=this.waiters.shift();if(next)next.resolve();else this.active--;}
  async use(callback, signal){await this.acquire(signal);try{signal?.throwIfAborted();return await callback();}finally{this.release();}}
}
