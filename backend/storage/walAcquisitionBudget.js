import {setTimeout as pause} from 'node:timers/promises';
import {RUNTIME_POLICY} from '../config/runtimePolicy.js';
import {CommittedWritePacer} from './committedWritePacer.js';

function abortable(task,signal){
 if(!signal)return task;
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(signal.reason);};
  const cleanup=()=>signal.removeEventListener('abort',abort);
  signal.addEventListener('abort',abort,{once:true});
  task.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
 });
}

// Cooperate between already committed acquisition pages. The checkpoint is the
// existing isolated connection; waiting never holds a SQL transaction, retries
// a business mutation or weakens the FULL WAL commit that acknowledged a page.
export class WalAcquisitionBudget {
 constructor(database,checkpoint,{softLimitBytes=RUNTIME_POLICY.storage.checkpointSoftBytes,pollMs=RUNTIME_POLICY.storage.maintenanceIntervalMs,commitBuffer=null,writePacing={}}={}){
  Object.assign(this,{database,checkpoint,softLimitBytes,pollMs});
  this.pageSize=database.pragma('page_size',{simple:true});
  this.probes=0;this.waits=0;this.waitMs=0;this.maxPendingBytes=0;this.active=0;
  this.writePacer=commitBuffer?new CommittedWritePacer(commitBuffer,{bytesPerSecond:RUNTIME_POLICY.storage.acquisitionWriteBytesPerSecond,burstBytes:RUNTIME_POLICY.storage.acquisitionWriteBurstBytes,...writePacing}):null;
 }
 status(){return {softLimitBytes:this.softLimitBytes,probes:this.probes,waits:this.waits,waitMs:this.waitMs,maxPendingBytes:this.maxPendingBytes,active:this.active,writePacing:this.writePacer?.status()||null};}
 beginWorkflow(){return this.writePacer?.begin()||(()=>{});}
 async wait(signal){
  signal?.throwIfAborted();
  if(this.database.inTransaction)throw Object.assign(Error('Acquisition pacing requires a transaction boundary'),{code:'STORAGE_WAL_BUDGET_IN_TRANSACTION'});
  await this.writePacer?.wait(signal);
  let started;
  try{
   for(;;){
    signal?.throwIfAborted();
    const row=this.database.pragma('wal_checkpoint(NOOP)')[0];this.probes++;
    const pendingBytes=Math.max(0,row.log-row.checkpointed)*this.pageSize;
    this.maxPendingBytes=Math.max(this.maxPendingBytes,pendingBytes);
    if(!row.busy&&pendingBytes<this.softLimitBytes)return;
    if(started===undefined){started=performance.now();this.waits++;this.active++;}
    await abortable(this.checkpoint(),signal);
    signal?.throwIfAborted();
    const after=this.database.pragma('wal_checkpoint(NOOP)')[0];this.probes++;
    if(!after.busy&&Math.max(0,after.log-after.checkpointed)*this.pageSize<this.softLimitBytes)return;
    // A reader may still pin committed frames. Yield without replaying a page
    // or spinning checkpoints; cancellation and control keep their own lane.
    await pause(this.pollMs,undefined,{signal});
   }
  }finally{if(started!==undefined){this.active--;this.waitMs+=performance.now()-started;}}
 }
}
