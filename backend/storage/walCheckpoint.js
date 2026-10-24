import {readCommits,acknowledgeCommits} from './commitActivity.js';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {RUNTIME_POLICY} from '../config/runtimePolicy.js';
import {createLogger} from '../utils/logger.js';
import {readNativeWait} from './nativeWait.js';
const log=createLogger('backend/storage/checkpoint');
const failure=code=>Object.assign(Error(code),{code,statusCode:503});

export class WalCheckpoint {
  constructor(options,{commitBuffer=null,pressureBuffer=new SharedArrayBuffer(4),workerFactory=data=>new Worker(new URL('./walCheckpointWorker.js',import.meta.url),{workerData:data,execArgv:[]})}={}){
    this.options=options;this.commitBuffer=commitBuffer;this.confirmedGeneration=0;this.confirmedBytes=0;this.pressure=new Int32Array(pressureBuffer);this.workerFactory=workerFactory;
    this.state='new';this.walBytes=0;this.confirmedWalBytes=0;this.pageSize=4096;this.completed=0;this.failures=0;this.nextEligibleAt=0;
  }
  status(){return {state:this.state,mode:'PASSIVE',connection:this.connection||null,walBytes:this.walBytes,backpressure:Atomics.load(this.pressure,0)===1,
    softLimitBytes:this.options.checkpointSoftBytes,hardLimitBytes:this.options.checkpointHardBytes,limitScope:'uncheckpointed-pages-and-growth',completed:this.completed,failures:this.failures,
    commits:readCommits(this.commitBuffer),confirmedGeneration:this.confirmedGeneration,dirtySince:this.dirtySince?new Date(this.dirtySince).toISOString():null,
    active:this.pending?{startedAt:new Date(this.pending.startedAt).toISOString(),elapsedMs:Date.now()-this.pending.startedAt}:null,
    lastResult:this.lastResult||null,lastError:this.lastError||null,nextEligibleAt:this.nextEligibleAt?new Date(this.nextEligibleAt).toISOString():null};}
  setPressure(value){
    const changed=Atomics.exchange(this.pressure,0,value?1:0)!==(value?1:0);
    if(changed)log.warn('storage_wal_pressure',{paused:value,walBytes:this.walBytes,hardLimitBytes:this.options.checkpointHardBytes});
  }
  behindLimit(){return (this.lastResult?.pendingBytes||0)>=this.options.checkpointHardBytes || this.walBytes-this.confirmedWalBytes>=this.options.checkpointHardBytes;}
  async start(){
    if(this.startTask)return this.startTask;
    this.state='starting';
    this.startTask=new Promise((resolve,reject)=>{
      this.readyResolve=resolve;this.readyReject=reject;
      this.startTimer=setTimeout(()=>this.fail('STORAGE_CHECKPOINT_START_TIMEOUT'),this.options.startupTimeoutMs);
      try{
        const worker=this.worker=this.workerFactory({databasePath:this.options.databasePath,writerToken:this.options.writerToken});
        worker.on('message',message=>{if(this.worker===worker)this.handleMessage(message);});
        worker.on('error',()=>{if(this.worker===worker)this.fail('STORAGE_CHECKPOINT_WORKER_FAILED');});
        worker.on('exit',()=>{if(this.worker===worker && !['closed','failed'].includes(this.state))this.fail('STORAGE_CHECKPOINT_WORKER_EXITED');});
      }catch{this.fail('STORAGE_CHECKPOINT_START_FAILED');}
    });
    return this.startTask;
  }
  observe(walBytes){
    if(Number.isSafeInteger(walBytes)&&walBytes>=0)this.walBytes=walBytes;
    if(this.state==='failed' && Date.now()>=this.nextEligibleAt && !this.recovery){
      this.recovery=(async()=>{
        await this.termination;
        if(this.state!=='failed')return;
        this.startTask=null;this.termination=null;
        try{await this.start();if(this.state==='ready')await this.request();}catch{/* Reported separately from business writes; retry on a later heartbeat. */}
      })().finally(()=>{this.recovery=null;});
    }
    clearTimeout(this.scheduleTimer);
    const commits=readCommits(this.commitBuffer),dirty=commits?commits.generation>this.confirmedGeneration:this.walBytes>this.confirmedWalBytes;
    if(dirty&&!this.dirtySince)this.dirtySince=commits?.at||Date.now();
    if(!dirty)this.dirtySince=null;
    // A PASSIVE checkpoint does not shrink the file. A fully copied, retained
    // WAL is not debt; pause only until the next checkpoint confirms progress.
    if(this.behindLimit() && (this.pending || this.state==='failed' || this.lastResult?.pendingFrames>0))this.setPressure(true);
    const debt=(this.lastResult?.pendingFrames||0)>0;
    const due=debt || dirty && ((commits?commits.bytes-this.confirmedBytes:this.walBytes-this.confirmedWalBytes)>=this.options.checkpointSoftBytes || Date.now()-this.dirtySince>=5000);
    if(this.state==='ready'&&!this.pending&&Date.now()>=this.nextEligibleAt&&due)this.request().catch(()=>{});
    else if(this.state==='ready'&&(dirty||debt)){this.scheduleTimer=setTimeout(()=>this.observe(this.walBytes),Math.max(25,Math.max(this.nextEligibleAt-Date.now(),debt?1000:Math.min(1000,5000-(Date.now()-this.dirtySince)))));this.scheduleTimer.unref();}
  }
  request(){
    if(this.pending)return this.pending.task;
    if(this.state!=='ready')return Promise.reject(failure('STORAGE_CHECKPOINT_UNAVAILABLE'));
    const id=randomUUID();let resolve,reject;
    const task=new Promise((yes,no)=>{resolve=yes;reject=no;});
    this.pending={id,task,resolve,reject,startedAt:Date.now(),walBytes:this.walBytes,commits:readCommits(this.commitBuffer)};
    this.pending.timer=setTimeout(()=>this.fail('STORAGE_CHECKPOINT_TIMEOUT'),this.options.checkpointTimeoutMs);
    if(this.behindLimit())this.setPressure(true);
    try{this.worker.postMessage({type:'checkpoint',id});}catch{this.fail('STORAGE_CHECKPOINT_WORKER_FAILED');}
    return task;
  }
  handleMessage(message){
    if(message.type==='ready'){
      if(this.state!=='starting')return;
      clearTimeout(this.startTimer);this.state='ready';this.nativeId=message.nativeThreadId;this.pageSize=message.pageSize||4096;this.connection={queryOnly:message.queryOnly,synchronous:message.synchronous};this.readyResolve(this.status());return;
    }
    if(message.type==='failed'){this.fail(message.error.code);return;}
    const pending=this.pending;if(!pending || pending.id!==message.id)return;
    clearTimeout(pending.timer);this.pending=null;
    if(message.error){
      this.recordFailure(message.error.code);this.nextEligibleAt=Date.now()+10000;pending.reject(failure(message.error.code));
    }else{
      const row=message.result[0];
      const pendingFrames=Math.max(0,row.log-row.checkpointed),pendingBytes=pendingFrames*this.pageSize;
      this.lastResult={...row,pendingFrames,pendingBytes,durationMs:message.durationMs,completedAt:new Date().toISOString()};
      if(!row.busy&&pendingFrames===0){this.confirmedGeneration=pending.commits?.generation||0;this.confirmedBytes=pending.commits?.bytes||0;acknowledgeCommits(this.commitBuffer,this.confirmedGeneration);this.dirtySince=null;}
      this.completed++;this.nextEligibleAt=Date.now()+RUNTIME_POLICY.storage.maintenanceIntervalMs;
      if(!row.busy && row.log>=0){this.confirmedWalBytes=Math.max(0,pending.walBytes-pendingBytes);this.setPressure(pendingBytes>=this.options.checkpointHardBytes);}
      else if(this.behindLimit())this.setPressure(true);
      if(message.durationMs>=1000 || this.lastResult.pendingFrames>0)log.warn('storage_wal_checkpoint',this.lastResult);
      pending.resolve(message.result);this.observe(this.walBytes);
    }
  }
  recordFailure(code){this.failures++;this.lastError={code,at:new Date().toISOString(),nativeWait:readNativeWait(this.nativeId)};log.warn('storage_wal_checkpoint_failed',this.lastError);}
  fail(code){
    if(['failed','closed'].includes(this.state))return;
    this.state='failed';clearTimeout(this.startTimer);this.recordFailure(code);this.readyReject?.(failure(code));
    this.nextEligibleAt=Date.now()+10000;
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(failure(code));this.pending=null;}
    if(this.behindLimit())this.setPressure(true);
    this.termination=this.worker?.terminate();
  }
  close(){
    if(this.closeTask)return this.closeTask;
    this.closeTask=(async()=>{
      clearTimeout(this.startTimer);clearTimeout(this.scheduleTimer);this.state='closed';this.readyReject?.(failure('STORAGE_CHECKPOINT_CLOSED'));
      if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(failure('STORAGE_CHECKPOINT_CLOSED'));this.pending=null;}
      // Termination waits for any native checkpoint to return. No business
      // mutation is ever declared uncertain because this thread is delayed.
      await (this.termination ||= this.worker?.terminate());
    })();
    return this.closeTask;
  }
}
