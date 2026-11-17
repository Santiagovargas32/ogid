import {randomUUID} from 'node:crypto';
import {stableHash} from '../utils/stableHash.js';
import {AppError} from '../utils/error.js';
import {CycleContinuations} from './cycleContinuations.js';
import {SqlAwarenessStore} from './sqlAwarenessStore.js';

export const FINANCIAL_SCOPE = 'news:financial-ingestion';
const phase = 'financial-ingestion';
const kind = 'financial-selection-v1';
const pageSize = 16;

function invalid() {
  throw new AppError('Selección financiera incompatible.', 409, 'CONTINUATION_EFFECT_MISMATCH');
}

// The manifest freezes the normalized domain input, including fallback articles
// whose enriched representation may never have existed in the SQL archive.
export function admitFinancial(db, {jobId, context, items}) {
  if (!Array.isArray(items) || items.length > 200 || !Number.isFinite(Date.parse(context?.observedAt))
      || !Number.isFinite(Date.parse(context?.asOf)) || typeof context.trigger !== 'string'
      || typeof context.backfill !== 'boolean' || !['shadow','visible'].includes(context.mode)
      || items.some(item => !item || !/^[a-f0-9]{64}$/.test(item.articleHash)
        || (item.event !== null && (!item.event?.eventId || !item.event.source?.sourceId
          || item.event.observedAt !== context.observedAt)))) invalid();
  const input = {kind, context, selectionHash:stableHash(items), count:items.length, after:0,
    changedIds:[], deduplicated:0, rejected:0};
  const ledger = new CycleContinuations(db);
  return db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM acquisition_jobs WHERE job_id=?').get(jobId);
    const job = ledger.admit({jobId, scope:FINANCIAL_SCOPE, phase, input});
    if (!exists) {
      const insert = db.prepare('INSERT INTO financial_continuation_inputs VALUES(?,?,?)');
      items.forEach((item, ordinal) => insert.run(jobId, ordinal, JSON.stringify(item)));
    }
    return job;
  }).immediate();
}

export function commitFinancialPage(db, auth) {
  const ledger = new CycleContinuations(db);
  return db.transaction(() => {
    let job = ledger.get(auth);
    if (job.scope !== FINANCIAL_SCOPE || job.phase !== phase || job.input.kind !== kind) invalid();
    const transitionId = 'financial-' + auth.cursor;
    const input = job.input;
    if (job.lastTransition?.id === transitionId) {
      job = ledger.advance({...auth, phase, input, complete:job.status === 'complete', transitionId});
    } else if (input.after === input.count && job.cursor > 0) {
      // Keep the last committed page discoverable until its caller has hydrated it.
      job = ledger.advance({...auth, phase, input:{...input, changedIds:[]}, complete:true, transitionId});
    } else {
      ledger.assertOwner({descriptor:job}, auth);
      if (job.cursor !== auth.cursor || job.status !== 'pending') invalid();
      const rows = db.prepare('SELECT ordinal,item_json FROM financial_continuation_inputs WHERE job_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?')
        .all(job.jobId, input.after, pageSize);
      if (rows.length !== Math.min(pageSize, input.count - input.after)
          || rows.some((row, index) => row.ordinal !== input.after + index)) invalid();
      const events = rows.map(row => JSON.parse(row.item_json).event).filter(Boolean);
      const store = new SqlAwarenessStore(db);
      store.now = () => Date.parse(input.context.observedAt);
      const result = store.reconcile(events);
      const after = input.after + rows.length;
      db.prepare('DELETE FROM financial_continuation_inputs WHERE job_id=? AND ordinal>=? AND ordinal<?')
        .run(job.jobId, input.after, after);
      const next = {...input, after, revision:result.revision, changedIds:result.changed.map(e => e.eventId),
        rejected:input.rejected + result.rejected, deduplicated:input.deduplicated + result.deduplicated};
      job = ledger.advance({...auth, phase, input:next, complete:false, transitionId});
    }
    const load = db.prepare('SELECT payload_json FROM awareness_events WHERE event_id=?');
    const changed = job.input.changedIds.map(id => JSON.parse(load.get(id).payload_json));
    return {job, changed};
  }).immediate();
}

export class FinancialCoordinator {
  constructor(manager, store) {
    this.manager = manager;
    this.store = store;
    this.owner = randomUUID();
    this.active = new Map();
  }
  pending() {
    return this.manager.request('continuation.scope', {scope:FINANCIAL_SCOPE});
  }
  admit(intent) {
    return this.manager.request('continuation.financialAdmit', intent);
  }
  resume(jobId, beforePage, publish) {
    if (!this.active.has(jobId)) {
      this.active.set(jobId, this.run(jobId, beforePage, publish).finally(() => this.active.delete(jobId)));
    }
    return this.active.get(jobId);
  }
  async run(jobId, beforePage, publish) {
    let job = await this.manager.request('continuation.claim', {jobId, owner:this.owner});
    if (!job) {
      job = await this.manager.request('continuation.get', {jobId});
      if (job.status !== 'complete') throw new AppError('Selección financiera reclamada.', 503, 'STORAGE_CONTINUATION_BUSY');
    }
    const changed = [];
    let replay = job.status === 'pending' && job.cursor > 0;
    while (job.status === 'pending') {
      beforePage();
      const auth = {jobId, owner:this.owner, fence:job.fence};
      await this.manager.request('continuation.renew', auth);
      const page = await this.manager.request('continuation.financialPage', {...auth, cursor:replay ? job.cursor - 1 : job.cursor});
      replay = false;
      job = page.job;
      const delta = [];
      for (const event of page.changed) {
        if ((this.store.events.get(event.eventId)?.revision ?? 0) >= event.revision) continue;
        this.store.events.set(event.eventId, event);
        delta.push(event);
      }
      this.store.revision = Math.max(this.store.revision, job.input.revision);
      this.store.prune();
      if (delta.length) publish(delta, job.input.context);
      changed.push(...delta);
    }
    return {jobId, changed, revision:job.input.revision, deduplicated:job.input.deduplicated, rejected:job.input.rejected};
  }
}
