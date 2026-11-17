import {randomUUID} from 'node:crypto';
import {stableHash} from '../utils/stableHash.js';
import {CycleContinuations} from './cycleContinuations.js';
import {SqlAwarenessStore} from './sqlAwarenessStore.js';
import {AppError} from '../utils/error.js';

// Typed writer boundary. The operation applies only the descriptor already
// frozen by admission; callers cannot substitute effects when replaying an ACK.
export function commitNotModifiedPage(db,auth){
  const ledger=new CycleContinuations(db);
  return db.transaction(()=>{
    const job=ledger.get(auth),input=job.input;
    if(job.phase!=='source-fresh'||input.kind!=='awareness-304-v1'||job.scope!==`awareness:${input.sourceId}`||input.poll?.httpStatus!==304||input.poll?.outcome!=='not-modified')
      throw new AppError('Descriptor de poll incompatible.',409,'CONTINUATION_EFFECT_MISMATCH');
    const transitionId=`fresh-${auth.cursor}`;
    // Replayed pages must not inspect current events or repeat the poll.
    if(job.lastTransition?.id===transitionId)return ledger.advance({...auth,phase:job.phase,input,complete:job.status==='complete',transitionId});
    const store=new SqlAwarenessStore(db);
    store.now=()=>Date.parse(input.poll.completedAt);
    const rows=db.prepare("SELECT event_id,payload_json FROM awareness_events WHERE source_id=? AND event_id>? ORDER BY event_id LIMIT 64").all(input.sourceId,input.after||'');
    const events=rows.map(r=>JSON.parse(r.payload_json)).filter(e=>e.provenance?.stale||e.dataMode==='stale').map(e=>({...e,dataMode:'observed',provenance:{...e.provenance,stale:false}}));
    const after=rows.at(-1)?.event_id||input.after||'';
    const more=Boolean(db.prepare('SELECT 1 FROM awareness_events WHERE source_id=? AND event_id>? LIMIT 1').get(input.sourceId,after));
    const next={...input,after};
    return ledger.advance({...auth,phase:'source-fresh',input:next,complete:!more,transitionId},()=>{
      if(events.length)store.reconcile(events);
      if(!more)store.commitPoll(input.sourceId,input.poll,input.patch);
    });
  }).immediate();
}

export class NotModifiedCoordinator {
  constructor(manager,store){Object.assign(this,{manager,store,owner:randomUUID()});this.active=new Map();}
  async pending(){
    const result=[];let after='';
    for(;;){const page=await this.manager.request('continuation.pending',{after});result.push(...page.filter(j=>j.phase==='source-fresh'&&j.scope.startsWith('awareness:')));if(page.length<64)return result;after=page.at(-1).jobId;}
  }
  async recover(sourceId){
    const job=await this.manager.request('continuation.scope',{scope:`awareness:${sourceId}`});
    if(!job)return null;
    if(job.input.kind!=='awareness-304-v1')throw new AppError('Continuación incompatible.',409,'CONTINUATION_EFFECT_MISMATCH');
    return this.resume(job.jobId);
  }
  async commit(input){
    // No provider body or live context is consulted after this intent commits.
    const jobId='poll304-'+stableHash(input);
    await this.manager.request('continuation.admit',{jobId,scope:`awareness:${input.sourceId}`,phase:'source-fresh',input:{...input,kind:'awareness-304-v1',after:''}});
    return this.resume(jobId);
  }
  resume(jobId){
    if(this.active.has(jobId))return this.active.get(jobId);
    const task=this.run(jobId).finally(()=>this.active.delete(jobId));this.active.set(jobId,task);return task;
  }
  async run(jobId){
    let job=await this.manager.request('continuation.claim',{jobId,owner:this.owner});
    if(!job){job=await this.manager.request('continuation.get',{jobId});if(job.status!=='complete')throw new AppError('Continuación pendiente de lease.',503,'STORAGE_CONTINUATION_BUSY');}
    while(job.status==='pending'){
      await this.manager.request('continuation.renew',{jobId,owner:job.owner,fence:job.fence});
      job=await this.manager.request('continuation.notModifiedPage',{jobId,owner:job.owner,fence:job.fence,cursor:job.cursor});
    }
    // Hydrate only after confirmed publication. The writer's result is canonical.
    const saved=await this.manager.request('runtime.load',{kind:'awareness'});
    const changed=(saved.events||[]).filter(e=>e.source?.sourceId===job.input.sourceId&&stableHash(this.store.events.get(e.eventId)||null)!==stableHash(e));
    this.store.events=new Map((saved.events||[]).map(e=>[e.eventId,e]));
    this.store.sourceStatuses=new Map((saved.sourceStatus||[]).map(s=>[s.sourceId,s]));
    this.store.revision=saved.revision;
    for(const {sourceId,poll}of saved.polls||[]){if(!this.store.pollHistories.has(sourceId))this.store.pollHistories.set(sourceId,[]);const history=this.store.pollHistories.get(sourceId);if(!history.some(p=>stableHash(p)===stableHash(poll)))history.push(poll);}
    return {sourceId:job.input.sourceId,changed,status:'not-modified',durable:true,jobId};
  }
}
