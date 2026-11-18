import {hasValidCoordinates} from '../services/awareness/awarenessStore.js';
import {randomUUID} from 'node:crypto';
import {CycleContinuations} from './cycleContinuations.js';
import {SqlAwarenessStore} from './sqlAwarenessStore.js';
import {stableHash} from '../utils/stableHash.js';
import {AppError} from '../utils/error.js';

export function supportsPollAdmission(sourceId) {
  return sourceId === 'awareness-bls-empsit' || sourceId === 'awareness-usgs-significant';
}

function mismatch() {
  throw new AppError('Turno de adquisición incompatible.',409,'CONTINUATION_EFFECT_MISMATCH');
}

export function reservePoll(db,{selection}) {
  const {sourceId, basis, catalogHash} = selection;
  if (!supportsPollAdmission(sourceId) || !basis || !catalogHash) mismatch();
  const scope = 'awareness:' + sourceId;
  const jobId = 'poll-' + stableHash(selection);
  const ledger = new CycleContinuations(db);
  return db.transaction(() => {
    const active = ledger.scope({scope});
    if (active) return active;
    const row = db.prepare('SELECT payload_json FROM awareness_source_status WHERE source_id=?').get(sourceId);
    const confirmedAt = row && JSON.parse(row.payload_json).lastPoll?.completedAt;
    if (confirmedAt && confirmedAt !== basis.completedAt) return {status:'superseded',input:{sourceId}};
    if (db.prepare('SELECT 1 FROM acquisition_jobs WHERE job_id=?').get(jobId)) return ledger.get({jobId});
    return ledger.admit({jobId,scope,phase:'admission',input:{kind:'awareness-turn-v1', ...selection, attempts:0}});
  }).immediate();
}

function checkedJob(ledger, auth) {
  const job = ledger.get(auth);
  if (!supportsPollAdmission(job.input.sourceId) || job.scope !== 'awareness:' + job.input.sourceId) mismatch();
  return job;
}

export function stagePoll(db,{auth,poll,patch,events}) {
  const ledger = new CycleContinuations(db);
  return db.transaction(() => {
    const job = checkedJob(ledger,auth);
    const sourceId = job.input.sourceId;
    const responseHash = stableHash([poll,patch,events]);
    if (job.phase !== 'request-authorized') {
      if (job.input.responseHash !== responseHash) mismatch();
      ledger.assertOwner({descriptor:job}, auth);
      return job;
    }
    if (job.input.kind !== 'awareness-turn-v1' || !Array.isArray(events)
        || events.some(event => event.source?.sourceId !== sourceId)
        || poll.attemptedAt !== job.input.attemptedAt) mismatch();
    const notModified = poll.httpStatus === 304 && poll.outcome === 'not-modified';
    const input = {kind:notModified?'awareness-304-v1':'awareness-response-v1', sourceId,
      validators:job.input.validators, unknownAttempts:job.input.unknownAttempts || 0, poll, patch:{...patch, attempts:job.input.baseAttempts+job.input.attempts,
        lastAttemptAt:job.input.attemptedAt}, responseHash, after:notModified?'':0,
      count:events.length, deduplicated:0, rejected:0, unlocated:0};
    return ledger.advance({...auth, phase:notModified?'source-fresh':'poll-confirm',input,
      transitionId:'response-'+auth.cursor}, () => {
      const insert = db.prepare('INSERT INTO awareness_poll_inputs VALUES(?,?,?)');
      events.forEach((event,index) => insert.run(job.jobId,index,JSON.stringify(event)));
    });
  }).immediate();
}

export function commitPollPage(db,auth) {
  const ledger = new CycleContinuations(db);
  return db.transaction(() => {
    let job = checkedJob(ledger,auth);
    const input = job.input;
    if (job.phase !== 'poll-confirm' || input.kind !== 'awareness-response-v1') mismatch();
    const transitionId = 'poll-page-'+auth.cursor;
    if (job.lastTransition?.id === transitionId) {
      return ledger.advance({...auth, phase:job.phase, input, complete:job.status==='complete', transitionId});
    }
    ledger.assertOwner({descriptor:job},auth);
    if (job.cursor!==auth.cursor || job.status!=='pending') mismatch();
    const store = new SqlAwarenessStore(db);
    store.now = () => Date.parse(input.poll.completedAt);
    const sourceId = input.sourceId;
    const next = {...input};
    let more = false;
    if (input.poll.outcome==='error') {
      const rows = db.prepare('SELECT event_id,payload_json FROM awareness_events WHERE source_id=? AND event_id>? ORDER BY event_id LIMIT 64')
        .all(sourceId,input.afterEvent || '');
      const events = rows.map(row=>JSON.parse(row.payload_json)).filter(event=>!event.provenance?.stale || event.dataMode!=='stale')
        .map(event=>({...event,dataMode:'stale',provenance:{...event.provenance,stale:true}}));
      if (events.length) store.reconcile(events);
      next.afterEvent = rows.at(-1)?.event_id || input.afterEvent || '';
      more = rows.length===64;
    } else {
      const rows = db.prepare('SELECT ordinal,payload_json FROM awareness_poll_inputs WHERE job_id=? AND ordinal>=? ORDER BY ordinal LIMIT 64')
        .all(job.jobId,input.after);
      if (rows.length!==Math.min(64,input.count-input.after) || rows.some((row,i)=>row.ordinal!==input.after+i)) mismatch();
      const events=rows.map(row=>JSON.parse(row.payload_json));
      const result=store.reconcile(events);
      next.after += rows.length;
      next.deduplicated += result.deduplicated;
      next.rejected += result.rejected;
      next.unlocated += events.filter(e=>!hasValidCoordinates(e.location)).length;
      db.prepare('DELETE FROM awareness_poll_inputs WHERE job_id=? AND ordinal>=? AND ordinal<?').run(job.jobId,input.after,next.after);
      more=next.after<input.count;
    }
    if (!more) {
      const counts = {deduplicated:next.deduplicated, rejected:next.rejected};
      const success = input.poll.outcome!=='error';
      store.commitPoll(sourceId, success?{...input.poll,...counts}:input.poll, success?
        {...input.patch,...counts,parsed:input.count,eventCount:input.count,unlocated:next.unlocated}:input.patch);
    }
    return ledger.advance({...auth,phase:job.phase,input:next,complete:!more,transitionId});
  }).immediate();
}

export class PollAdmissionCoordinator {
  constructor(manager, notModified, flush) {
    Object.assign(this,{manager,notModified,flush});
    this.owner = randomUUID();
  }
  supports(sourceId) { return supportsPollAdmission(sourceId); }
  async reserve(source,previous,trigger,selectedAt) {
    await this.flush();
    const selection={sourceId:source.sourceId, catalogHash:stableHash(source), selectedAt,trigger,
      basis:{completedAt:previous.lastPoll?.completedAt || null,eligibleAt:previous.nextEligibleAt || null,
        admissionState:previous.admissionState || source.admissionState,runtimeBlocked:previous.runtimeBlocked===true},
      validators:{etag:previous.etag || null,lastModified:previous.lastModified || null}};
    return this.manager.request('continuation.pollReserve',{selection});
  }
  async claim(job) {
    const owned=await this.manager.request('continuation.claim',{jobId:job.jobId,owner:this.owner});
    if(!owned) throw new AppError('Turno reclamado.',503,'STORAGE_CONTINUATION_BUSY');
    return owned;
  }
  auth(job) {return {jobId:job.jobId,owner:job.owner,fence:job.fence,cursor:job.cursor};}
  async begin(job,attemptedAt,nextEligibleAt,previous) {
    const auth=this.auth(job);
    await this.manager.request('continuation.renew',auth);
    return this.manager.request('continuation.advance',{...auth,phase:'request-authorized',transitionId:'request-'+job.cursor,
      input:{...job.input,attemptedAt,nextEligibleAt,attempts:job.input.attempts+1,
        unknownAttempts:(job.input.unknownAttempts || 0) + Number(job.phase==='request-authorized'),
        baseAttempts:job.input.baseAttempts ?? Number(previous.attempts || 0),
        validators:{etag:previous.etag || null,lastModified:previous.lastModified || null}}});
  }
  async deferUnsent(job) {
    const {attemptedAt,nextEligibleAt,...input}=job.input;
    return this.manager.request('continuation.advance',{
      ...this.auth(job),phase:'admission',transitionId:'unsent-'+job.cursor,
      input:{...input,attempts:input.attempts-1}
    });
  }
  async skip(job,reason,eligibleAt) {
    return this.manager.request('continuation.advance',{...this.auth(job),phase:'skipped',transitionId:'skip-'+job.cursor,
      input:{...job.input,reason,eligibleAt},complete:true});
  }
  async stage(job,poll,patch,events=[]) {
    const auth=this.auth(job);
    await this.manager.request('continuation.renew',auth);
    return this.manager.request('continuation.pollStage',{auth,poll,patch,events});
  }
  async drain(job,beforePage) {
    // The caller may resume after several pages committed before a deferral.
    job=await this.manager.request('continuation.get',{jobId:job.jobId});
    if (job.status==='pending') job=await this.claim(job);
    while(job.status==='pending') {
      beforePage();
      const auth=this.auth(job);
      await this.manager.request('continuation.renew',auth);
      job=await this.manager.request(job.phase==='source-fresh'?'continuation.notModifiedPage':'continuation.pollPage',auth);
    }
    return this.notModified.hydrate(job,job.input.poll.outcome);
  }
}
