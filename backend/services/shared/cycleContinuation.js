export const isResourcePressure=error=>error?.code==='STORAGE_RESOURCE_PRESSURE'&&error.notExecuted===true;

// A suspended generator retains only the current bounded cycle, never history.
// Advance only after a confirmed phase. Unknown outcomes are never replayed.
export class CycleContinuation {
  constructor(iterator,admission){this.iterator=iterator;this.admission=admission;this.current=null;this.phase='admission';}
  async run(){
    this.admission?.assert('acquisition');
    this.current ||= await this.iterator.next();
    while(!this.current.done){
      const step=this.current.value;this.phase=step.phase;
      let value;
      try{this.admission?.assert(step.kind || 'heavy');value=await step.work();}
      catch(error){
        if(isResourcePressure(error))throw error;
        if(/^(STORAGE_|SQLITE_)/.test(error.code || '')){await this.close();throw error;}
        // Let the generator's error path report the permanent failure, then close.
        try{this.current=await this.iterator.throw(error);}catch(reason){await this.close();throw reason;}
        continue;
      }
      this.current=await this.iterator.next(value);
    }
    return this.current.value;
  }
  async close(){await this.iterator.return();this.current=null;}
}
