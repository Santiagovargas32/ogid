// Only replaceable calculations use this coordinator. Accepted facts and frozen
// jobs never pass through it. Each scope retains one active and one successor.
export class ScopedWork {
  constructor({maxScopes=128,maxBytes=32*1024*1024}={}){this.maxScopes=maxScopes;this.maxBytes=maxBytes;this.bytes=0;this.scopes=new Map();this.metrics={joined:0,coalesced:0,started:0,rejected:0};}
  reject(){this.metrics.rejected++;return Promise.reject(Object.assign(Error('Calculation admission full'),{code:'STORAGE_BACKPRESSURE'}));}
  run(scope,revision,execute,{bytes=0}={}){
    const current=this.scopes.get(scope);
    if(current){
      if(current.revision===revision && !current.pending){this.metrics.joined++;return current.promise;}
      if(this.bytes-(current.pending?.bytes || 0)+bytes>this.maxBytes)return this.reject();
      if(current.pending){this.bytes+=bytes-current.pending.bytes;Object.assign(current.pending,{revision,execute,bytes});this.metrics.coalesced++;return current.pending.promise;}
      const pending={revision,execute,bytes};pending.promise=new Promise((resolve,reject)=>Object.assign(pending,{resolve,reject}));
      this.bytes+=bytes;
      current.pending=pending;return pending.promise;
    }
    if(this.scopes.size>=this.maxScopes || this.bytes+bytes>this.maxBytes)return this.reject();
    const entry={revision,pending:null,bytes};this.bytes+=bytes;this.scopes.set(scope,entry);this.metrics.started++;
    entry.promise=Promise.resolve().then(execute).finally(()=>{
      const pending=entry.pending;this.scopes.delete(scope);this.bytes-=entry.bytes+(pending?.bytes || 0);
      if(pending)this.run(scope,pending.revision,pending.execute,{bytes:pending.bytes}).then(pending.resolve,pending.reject);
    });
    return entry.promise;
  }
}
