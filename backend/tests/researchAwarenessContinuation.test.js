import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {CycleContinuations} from '../storage/cycleContinuations.js';
import {migrate} from '../storage/migrate.js';
import {admitResearchAwareness,commitResearchAwarenessPage} from '../storage/researchAwarenessContinuation.js';
import {SqlEventLedger,SqlResearchStore} from '../storage/sqlRepositories.js';
import {SqlAwarenessStore} from '../storage/sqlAwarenessStore.js';

const asOf = '2026-11-24T12:00:00.000Z';
const item = (i, revision=1) => ({eventId:'release-'+i, title:'Release '+i, source:{sourceId:'fixture'},
  revision, url:'https://fixture.invalid/'+i, eventTime:asOf});

test('research effect, cursor and staged input are atomic, with replay and policy revalidation', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db);
    const ledger = new CycleContinuations(db), auth = job => ({jobId:job.jobId, owner:job.owner, fence:job.fence, cursor:job.cursor});
    const intent = {jobId:'research-test', observedAt:asOf, revision:1, items:Array.from({length:17},(_,i)=>item(i))};
    const count = table => db.prepare('SELECT count(*) FROM '+table).pluck().get();
    admitResearchAwareness(db,intent);
    assert.throws(()=>admitResearchAwareness(db,{...intent,jobId:'second'}),{code:'CONTINUATION_SCOPE_BUSY'});
    const first = ledger.claim({jobId:intent.jobId,owner:'first'});
    db.exec("CREATE TRIGGER fixture_failure BEFORE UPDATE ON acquisition_jobs BEGIN SELECT RAISE(ABORT,'cursor failure'); END");
    assert.throws(()=>commitResearchAwarenessPage(db,{auth:auth(first),visible:true}),/cursor failure/);
    assert.equal(count('events'),0);
    assert.equal(count('research_awareness_inputs'),2);
    assert.equal(ledger.get(first).cursor,0);
    db.exec('DROP TRIGGER fixture_failure');
    const events = new SqlEventLedger({store:new SqlResearchStore(db)});
    events.ingest([{...item(0,2),title:'Newer revision'}],{sourceId:'awareness'});
    assert.equal(commitResearchAwarenessPage(db,{auth:auth(first),visible:true}).input.changed,15);
    assert.equal(commitResearchAwarenessPage(db,{auth:auth(first),visible:true}).replayed,true);
    assert.equal(count('events'),16);
    assert.equal(db.prepare("SELECT count(*) FROM events WHERE json_extract(payload_json,'$.title')='Newer revision'").pluck().get(),1);
    ledger.recoverPage();
    const next = ledger.claim({jobId:intent.jobId,owner:'next'});
    assert.throws(()=>commitResearchAwarenessPage(db,{auth:auth(first),visible:true}),{code:'CONTINUATION_LEASE_LOST'});
    assert.equal(next.cursor,1);
    new SqlAwarenessStore(db).updateSourceStatus('fixture',{admissionState:'blocked'});
    const done = commitResearchAwarenessPage(db,{auth:auth(next),visible:true});
    assert.equal(done.status,'complete');
    assert.equal(done.input.excluded,1);
    assert.equal(count('events'),16);
    assert.equal(count('research_awareness_inputs'),0);
  } finally {
    db.close();
  }
});

test('an identical selection reuses its confirmed receipt until the research ledger changes', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const ledger = new CycleContinuations(db);
    const input = {jobId:'original', observedAt:asOf, revision:1, items:[item(0)]};
    admitResearchAwareness(db,input);
    const claim = ledger.claim({jobId:input.jobId,owner:'fixture'});
    const auth = {jobId:claim.jobId, owner:claim.owner, cursor:claim.cursor, fence:claim.fence};
    const done = commitResearchAwarenessPage(db,{auth,visible:true});
    const before = db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(admitResearchAwareness(db,{...input,jobId:'duplicate'}),done);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);
    new SqlEventLedger({store:new SqlResearchStore(db)}).ingest([item(1)],{sourceId:'awareness'});
    assert.equal(admitResearchAwareness(db,{...input,jobId:'after-change'}).status,'pending');
  } finally {
    db.close();
  }
});

test('two real app processes recover Awareness before a later selection and reconcile an exact lost ACK', () => {
  const dir = mkdtempSync(join(tmpdir(),'ogid-research-awareness-'));
  try {
    const fixture = fileURLToPath(new URL('./fixtures/researchAwarenessContinuation.mjs',import.meta.url));
    for (const attempt of ['defer','recover']) {
      execFileSync(process.execPath,['--require','./tests/testSetup.cjs',fixture,dir,attempt],{timeout:30000});
    }
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test('shutdown distinguishes pre-admission pressure from an unavailable persistence inspection', () => {
  const fixture = fileURLToPath(new URL('./fixtures/researchAwarenessContinuation.mjs',import.meta.url));
  for (const attempt of ['admission','unknown']) {
    const dir = mkdtempSync(join(tmpdir(),'ogid-research-awareness-'));
    try {
      execFileSync(process.execPath,['--require','./tests/testSetup.cjs',fixture,dir,attempt],{timeout:30000});
    } finally {
      rmSync(dir,{recursive:true,force:true});
    }
  }
});
