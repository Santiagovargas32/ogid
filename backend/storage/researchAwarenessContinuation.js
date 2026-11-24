import {randomUUID} from 'node:crypto';
import {stableHash} from '../utils/stableHash.js';
import {AppError} from '../utils/error.js';
import {CycleContinuations} from './cycleContinuations.js';
import {readMeta, writeMeta, SqlEventLedger, SqlResearchStore} from './sqlRepositories.js';

export const RESEARCH_AWARENESS_SCOPE = 'research:awareness-events';
const phase = 'awareness-events';
const latestKey = 'research.awareness.last-applied';
const pageSize = 16;
const maxItems = 200;
const maxBytes = 1024 * 1024;

function mismatch() {
  throw new AppError('Selección de investigación incompatible.', 409, 'CONTINUATION_EFFECT_MISMATCH');
}

export function admitResearchAwareness(db, {jobId, observedAt, revision, items}) {
  if (!Number.isFinite(Date.parse(observedAt)) || !Number.isSafeInteger(revision) || revision < 0
      || !Array.isArray(items) || !items.length || items.length > maxItems
      || items.some(item => !item?.eventId || !item.source?.sourceId)) mismatch();
  if (Buffer.byteLength(JSON.stringify(items)) > maxBytes) {
    throw new AppError('Selección de investigación demasiado grande.', 503, 'CONTINUATION_INPUT_TOO_LARGE');
  }
  const pages = [];
  for (let i = 0; i < items.length; i += pageSize) pages.push(items.slice(i, i + pageSize));
  const input = {version:1, observedAt, revision, count:items.length, pageHashes:pages.map(stableHash),
    accepted:0, changed:0, excluded:0};
  const ledger = new CycleContinuations(db);
  return db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM acquisition_jobs WHERE job_id=?').get(jobId);
    if (!exists && !ledger.scope({scope:RESEARCH_AWARENESS_SCOPE})) {
      const latest = readMeta(db, latestKey, null);
      if (latest?.selection === stableHash([input.revision, input.pageHashes])
          && latest.researchRevision === readMeta(db, 'research.revision', 0)) {
        return ledger.get({jobId:latest.jobId});
      }
    }
    const job = ledger.admit({jobId, scope:RESEARCH_AWARENESS_SCOPE, phase, input});
    if (!exists) {
      const insert = db.prepare('INSERT INTO research_awareness_inputs VALUES(?,?,?)');
      pages.forEach((page, index) => insert.run(jobId, index, JSON.stringify(page)));
    }
    return job;
  }).immediate();
}

export function commitResearchAwarenessPage(db, {auth, visible}) {
  if (typeof visible !== 'boolean') mismatch();
  const ledger = new CycleContinuations(db);
  return db.transaction(() => {
    const job = ledger.get(auth);
    if (job.scope !== RESEARCH_AWARENESS_SCOPE || job.phase !== phase || job.input.version !== 1) mismatch();
    const transitionId = 'research-awareness-' + auth.cursor;
    const input = job.input;
    if (job.lastTransition?.id === transitionId) {
      return ledger.advance({...auth, phase, input, complete:job.status === 'complete', transitionId});
    }
    ledger.assertOwner({descriptor:job}, auth);
    if (job.cursor !== auth.cursor || job.status !== 'pending') mismatch();
    const saved = db.prepare('SELECT items_json FROM research_awareness_inputs WHERE job_id=? AND page=?')
      .get(job.jobId, auth.cursor);
    if (!saved) mismatch();
    const items = JSON.parse(saved.items_json);
    if (stableHash(items) !== input.pageHashes[auth.cursor]) mismatch();
    const source = db.prepare('SELECT json_extract(payload_json,\'$.admissionState\') AS state FROM awareness_source_status WHERE source_id=?');
    const admitted = visible === true ? items.filter(item => {
      const status = source.get(item.source.sourceId);
      return !status || status.state === 'active';
    }) : [];
    const events = new SqlEventLedger({store:new SqlResearchStore(db), now:() => Date.parse(input.observedAt)});
    const result = events.ingest(admitted, {sourceId:'awareness', retainNewerEvidence:true});
    const next = {...input, accepted:input.accepted + result.accepted, changed:input.changed + result.changed,
      excluded:input.excluded + items.length - admitted.length};
    db.prepare('DELETE FROM research_awareness_inputs WHERE job_id=? AND page=?').run(job.jobId, auth.cursor);
    const complete = auth.cursor+1 === input.pageHashes.length;
    if (complete && !next.excluded) {
      writeMeta(db, latestKey, {selection:stableHash([input.revision, input.pageHashes]), jobId:job.jobId,
        researchRevision:readMeta(db, 'research.revision', 0)});
    }
    return ledger.advance({...auth, phase, input:next, complete, transitionId});
  }).immediate();
}

export class ResearchAwarenessCoordinator {
  constructor(manager, visible) {
    Object.assign(this, {manager, visible, owner:randomUUID(), unstaged:null, acceptedJobId:null});
  }

  pending() {
    return this.manager.request('continuation.scope', {scope:RESEARCH_AWARENESS_SCOPE});
  }

  async recover() {
    const pending = await this.pending();
    let recovered = null;
    if (pending) {
      if (pending.jobId === this.unstaged?.jobId) {
        this.acceptedJobId = pending.jobId;
        this.unstaged = null;
      }
      recovered = await this.resume(pending.jobId);
    } else if (this.acceptedJobId) {
      // The final commit may have succeeded while its ACK and receipt read failed.
      const job = await this.manager.request('continuation.get', {jobId:this.acceptedJobId});
      if (job.status === 'complete') recovered = job;
    }
    if (this.unstaged) {
      const job = await this.manager.request('continuation.researchAwarenessAdmit', this.unstaged);
      this.acceptedJobId = job.jobId;
      this.unstaged = null;
      return job.status === 'complete' ? job : this.resume(job.jobId);
    }
    return recovered;
  }

  async ingest(capture) {
    const recoveringCurrent = Boolean(this.unstaged || this.acceptedJobId);
    const recovered = await this.recover();
    if (recoveringCurrent && recovered) {
      this.acceptedJobId = null;
      return recovered;
    }
    const snapshot = capture();
    if (snapshot.mode !== 'visible') return recovered;
    const items = [...snapshot.recent, ...snapshot.upcoming]
      .map(event => ({...event, url:event.canonicalUrl ?? null, eventTime:event.scheduledAt ?? null}));
    if (!items.length) return recovered;
    this.unstaged = {jobId:randomUUID(), observedAt:new Date().toISOString(), revision:snapshot.revision, items};
    try {
      const job = await this.manager.request('continuation.researchAwarenessAdmit', this.unstaged);
      this.unstaged = null;
      if (job.status === 'complete') return job;
      this.acceptedJobId = job.jobId;
      const result = await this.resume(job.jobId);
      this.acceptedJobId = null;
      return result;
    } catch (error) {
      if (!['STORAGE_RESOURCE_PRESSURE','STORAGE_OUTCOME_UNKNOWN'].includes(error.code)) this.unstaged = null;
      throw error;
    }
  }

  async resume(jobId) {
    const claimed = await this.manager.request('continuation.claim', {jobId, owner:this.owner});
    if (!claimed) throw new AppError('Investigación reclamada.', 503, 'STORAGE_CONTINUATION_BUSY');
    let job = claimed;
    while (job.status === 'pending') {
      const auth = {jobId, owner:this.owner, fence:job.fence, cursor:job.cursor};
      if (job.leaseUntil - Date.now() < 45000) await this.manager.request('continuation.renew', auth);
      try {
        job = await this.manager.request('continuation.researchAwarenessPage', {auth, visible:this.visible()});
      } catch (error) {
        if (error.code !== 'STORAGE_OUTCOME_UNKNOWN') throw error;
        let saved;
        try { saved = await this.manager.request('continuation.get', {jobId}); }
        catch (lookup) { error.receiptLookupCode = lookup.code; }
        if (saved?.fence !== auth.fence || saved.lastTransition?.id !== 'research-awareness-'+auth.cursor) throw error;
        job = saved;
      }
    }
    return job;
  }
}
