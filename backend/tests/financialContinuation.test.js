import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {admitFinancial,commitFinancialPage} from '../storage/financialContinuation.js';
import {CycleContinuations} from '../storage/cycleContinuations.js';
import {AwarenessService} from '../services/awareness/awarenessService.js';
import {AwarenessStore} from '../services/awareness/awarenessStore.js';

test('financial input, domain events and receipt roll back together; exact ACK replay and fenced recovery',()=>{
  const db=new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');migrate(db);
    const service=new AwarenessService({mode:'shadow',sources:[],store:new AwarenessStore()});
    const items=Array.from({length:18},(_,id)=>({id:String(id),revision:1,title:'Company report '+id,url:'https://test.example/'+id}));
    const intent=service.prepareFinancialIntent(items,{trigger:'manual',backfill:false});
    const ledger=new CycleContinuations(db);
    admitFinancial(db,intent);
    assert.throws(()=>admitFinancial(db,{...intent,items:[...intent.items].reverse()}),{code:'STORAGE_IDEMPOTENCY_CONFLICT'});
    assert.throws(()=>admitFinancial(db,{...intent,jobId:'other-cycle'}),{code:'CONTINUATION_SCOPE_BUSY'});
    const claim=ledger.claim({jobId:intent.jobId,owner:'first'});
    const auth={jobId:intent.jobId,owner:claim.owner,fence:claim.fence,cursor:0};
    db.exec("CREATE TRIGGER inject_failure BEFORE UPDATE ON acquisition_jobs BEGIN SELECT RAISE(ABORT,'page failure'); END");
    assert.throws(()=>commitFinancialPage(db,auth),/page failure/);
    assert.equal(db.prepare('SELECT count(*) FROM awareness_events').pluck().get(),0);
    assert.equal(db.prepare('SELECT count(*) FROM financial_continuation_inputs').pluck().get(),18);
    assert.equal(ledger.get(auth).cursor,0);
    db.exec('DROP TRIGGER inject_failure');
    const page=commitFinancialPage(db,auth);
    assert.equal(page.changed.length,16);
    assert.deepEqual(commitFinancialPage(db,auth).changed,page.changed);
    ledger.recoverPage();const next=ledger.claim({jobId:intent.jobId,owner:'second'});
    assert.throws(()=>commitFinancialPage(db,auth),{code:'CONTINUATION_LEASE_LOST'});
    const newAuth={jobId:intent.jobId,owner:next.owner,fence:next.fence};
    assert.deepEqual(commitFinancialPage(db,{...newAuth,cursor:0}).changed,page.changed);
    assert.equal(commitFinancialPage(db,{...newAuth,cursor:1}).changed.length,2);
    assert.equal(commitFinancialPage(db,{...newAuth,cursor:2}).job.status,'complete');
    assert.equal(db.prepare('SELECT count(*) FROM financial_continuation_inputs').pluck().get(),0);
    assert.equal(db.prepare('SELECT sum(revision) FROM awareness_events').pluck().get(),18);
  } finally {db.close();}
});

for (const scenario of ['first','lost']) test('real news cycle recovers before acquisition after principal and worker restart: '+scenario,()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-financial-cycle-'));
  const file=join(dir,'fixture.sqlite');
  const script=fileURLToPath(new URL('./fixtures/financialCycle.mjs',import.meta.url));
  const time=Date.now();
  try {
    for(const attempt of ['denied',scenario,'restart']) {
      execFileSync(process.execPath,[script,file,attempt],{env:{...process.env,FIXTURE_TIME:String(time)},timeout:30000});
    }
    const db=new Database(file,{readonly:true});
    try {
      assert.equal(db.prepare('SELECT count(*) FROM financial_continuation_inputs').pluck().get(),0);
      assert.equal(db.prepare('SELECT sum(revision) FROM awareness_events').pluck().get(),21);
      assert.equal(db.prepare("SELECT count(*) FROM acquisition_jobs WHERE status='complete' AND json_extract(job_json,'$.scope')='news:financial-ingestion'").pluck().get(),1);
    } finally {db.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
