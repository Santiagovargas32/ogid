// One shared owner per compatible read. A consumer abort releases its interest;
// the underlying operation is cancelled only when nobody still needs it.
export class ReadCoordinator {
  constructor({maxActive=2,maxPending=64}={}) {
    Object.assign(this,{maxActive,maxPending});
    this.entries=new Map();
    this.queue=[];
    this.active=0;
    this.heavy=0;
  }
  read(key,task,{signal,heavy=false}={}) {
    if(signal?.aborted)return Promise.reject(signal.reason);
    let entry=this.entries.get(key);
    if(!entry){
      if(this.queue.length>=this.maxPending)return Promise.reject(Object.assign(Error('Read capacity exhausted'),{code:'READ_BACKPRESSURE'}));
      entry={key,task,heavy,controller:new AbortController(),consumers:new Set()};
      this.entries.set(key,entry);
      this.queue.push(entry);
    }
    const result=new Promise((resolve,reject)=>{
      const consumer={resolve,reject,signal};
      consumer.abort=()=>{
        entry.consumers.delete(consumer);
        reject(signal.reason);
        if(!entry.consumers.size){
          entry.controller.abort();
          if(this.entries.get(key)===entry)this.entries.delete(key);
          const index=this.queue.indexOf(entry);
          if(index>=0)this.queue.splice(index,1);
        }
      };
      signal?.addEventListener('abort',consumer.abort,{once:true});
      entry.consumers.add(consumer);
    });
    this.pump();
    return result;
  }
  pump(){
    while(this.active<this.maxActive){
      const index=this.queue.findIndex(entry=>!entry.heavy||!this.heavy);
      if(index<0)return;
      const [entry]=this.queue.splice(index,1);
      if(entry.controller.signal.aborted)continue;
      this.active++;
      if(entry.heavy)this.heavy++;
      Promise.resolve().then(()=>entry.task(entry.controller.signal)).then(value=>this.settle(entry,null,value),error=>this.settle(entry,error))
        .finally(()=>{this.active--;if(entry.heavy)this.heavy--;this.pump();});
    }
  }
  settle(entry,error,value){
    if(this.entries.get(entry.key)===entry)this.entries.delete(entry.key);
    for(const consumer of entry.consumers){
      consumer.signal?.removeEventListener('abort',consumer.abort);
      if(error)consumer.reject(error);
      else consumer.resolve(value);
    }
    entry.consumers.clear();
  }
}
