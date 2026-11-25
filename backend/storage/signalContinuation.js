import {randomUUID} from 'node:crypto';
import {stableHash} from '../utils/stableHash.js';
import {AppError} from '../utils/error.js';
import {validateMeasurement} from '../services/intel/signalCorrelator.js';
import {CycleContinuations} from './cycleContinuations.js';

const domains = ['news','market'];
const phase = 'signal-measurement';
const scope = domain => 'signals:' + domain;
const staging = domain => 'signal-pending:' + domain;

function mismatch() {
  throw new AppError('Medición de señales incompatible.',409,'CONTINUATION_EFFECT_MISMATCH');
}

export function stageSignal(runtime, {jobId,domain,measurement}) {
  validateMeasurement(measurement);
  if (!domains.includes(domain) || !measurement.cutAt) mismatch();
  const {db} = runtime;
  const ledger = new CycleContinuations(db);
  const input = {version:1, domain, cutAt:measurement.cutAt, measurementHash:stableHash(measurement)};
  return db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM acquisition_jobs WHERE job_id=?').get(jobId);
    const job = ledger.admit({jobId, scope:scope(domain), phase, input});
    if (!exists) runtime.save(staging(domain),{jobId,measurement});
    return job;
  }).immediate();
}

export function applySignal(runtime, auth) {
  const {db} = runtime;
  const ledger = new CycleContinuations(db);
  const target = runtime.services.signals;
  let before = null;
  try {
    return db.transaction(() => {
      const job = ledger.get(auth), {domain,measurementHash} = job.input;
      if (job.phase !== phase || job.input.version !== 1 || !domains.includes(domain) || job.scope !== scope(domain)) mismatch();
      const transitionId = 'signal-measurement-' + auth.cursor;
      if (job.lastTransition?.id === transitionId) {
        return ledger.advance({...auth,phase,input:job.input,complete:true,transitionId});
      }
      ledger.assertOwner({descriptor:job},auth);
      if (auth.cursor !== job.cursor || job.status !== 'pending') mismatch();
      const staged = runtime.load(staging(domain));
      if (staged?.jobId !== job.jobId || stableHash(staged.measurement) !== measurementHash) mismatch();
      before = structuredClone(target.history);
      const startedAt = new Date().toISOString();
      const outcome = runtime.recordSignalMeasurement(target,staged.measurement);
      const counts = outcome === 'superseded' ? {discarded:1} : {processed:1};
      db.prepare("INSERT INTO pipeline_runs VALUES(?,'signals',?,?,'healthy',?,NULL)")
        .run(job.jobId,startedAt,new Date().toISOString(),JSON.stringify(counts));
      db.prepare('DELETE FROM runtime_snapshots WHERE kind=?').run(staging(domain));
      return ledger.advance({...auth,phase,input:{...job.input,outcome},complete:true,transitionId});
    }).immediate();
  } catch (error) {
    if (before) {
      target.history = before;
      target.invalidatePersistenceCache();
    }
    throw error;
  }
}

export class SignalContinuation {
  constructor(manager) {
    Object.assign(this,{manager, owner:randomUUID(), memory:new Map(), active:new Map()});
  }

  pending(domain) {
    return this.manager.request('continuation.scope',{scope:scope(domain)});
  }

  async unconfirmed(domain, pendingJobId) {
    const intent = this.memory.get(domain);
    if (!intent || intent.jobId === pendingJobId) return null;
    try { await this.manager.request('continuation.get',{jobId:intent.jobId}); }
    catch (error) {
      if (error.code !== 'CONTINUATION_UNKNOWN') throw error;
      return intent.jobId;
    }
    return null;
  }

  async recover(domain) {
    const job = await this.pending(domain);
    return job ? this.apply(job.jobId) : null;
  }

  async run(domain, capture) {
    const measurement = capture();
    const intent = {jobId:'signal-' + stableHash([phase,domain,measurement]),domain,measurement};
    const active = this.active.get(domain);
    if (active) {
      if (active.jobId === intent.jobId) return active.task;
      throw new AppError('Medición en curso.',409,'CONTINUATION_SCOPE_BUSY');
    }
    const task = this.resumeAndStage(intent);
    this.active.set(domain,{jobId:intent.jobId,task});
    try { return await task; }
    finally { this.active.delete(domain); }
  }

  async resumeAndStage(intent) {
    const previous = this.memory.get(intent.domain);
    if (previous && previous.jobId !== intent.jobId) await this.finish(previous);
    return this.finish(intent);
  }

  async finish(intent) {
    const {domain,jobId} = intent;
    this.memory.set(domain,intent);
    try {
      const resumed = await this.recover(domain);
      if (resumed?.jobId === jobId) {
        this.memory.delete(domain);
        return resumed;
      }
      const staged = await this.manager.request('continuation.signalStage',intent);
      const receipt = staged.status === 'complete' ? staged : await this.apply(jobId);
      this.memory.delete(domain);
      return receipt;
    } catch (error) {
      if (!['STORAGE_RESOURCE_PRESSURE','STORAGE_OUTCOME_UNKNOWN'].includes(error.code)) this.memory.delete(domain);
      throw error;
    }
  }

  async apply(jobId) {
    const job = await this.manager.request('continuation.claim',{jobId,owner:this.owner});
    if (!job) throw new AppError('Medición reclamada.',503,'STORAGE_CONTINUATION_BUSY');
    const auth = {jobId,owner:this.owner,fence:job.fence,cursor:job.cursor};
    try {
      return await this.manager.request('continuation.signalApply',auth);
    } catch (error) {
      if (error.code !== 'STORAGE_OUTCOME_UNKNOWN') throw error;
      let receipt;
      try { receipt = await this.manager.request('continuation.get',{jobId}); }
      catch (lookup) { error.receiptLookupCode = lookup.code; }
      if (receipt?.fence === job.fence && receipt.lastTransition?.id === 'signal-measurement-'+job.cursor
          && receipt.status === 'complete') return receipt;
      throw error;
    }
  }
}
