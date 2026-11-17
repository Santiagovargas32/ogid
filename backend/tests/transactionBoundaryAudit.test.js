import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {AdvancedSnapshots} from '../storage/advancedSnapshots.js';
import {SqlActivity,createSqlActivityBuffer,trackTransactions} from '../storage/sqlActivity.js';
import {cacheStatements} from '../storage/statementCache.js';
import {StorageManager} from '../storage/StorageManager.js';

// Audit existing atomicity; a released nested savepoint is not publication.
for(const [label,target]of [
  ['manifest','BEFORE INSERT ON analysis_inputs'],
  ['latest pointer','BEFORE INSERT ON analysis_latest'],
  ['job completion',"BEFORE UPDATE ON analysis_jobs WHEN NEW.status='complete'"]
])test(`advanced rolls result, manifest, pointer and completion back on failure at ${label}`,()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-boundary-audit-')),file=join(dir,'fixture.sqlite');
  let db=new Database(file),runtime;
  try{
    db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('foreign_keys=ON');migrate(db);
    runtime=new BusinessRuntime(db);const snapshots=new AdvancedSnapshots(runtime);
    const pending=snapshots.prepare({options:{countries:['RU']}}),job=snapshots.claim({jobId:pending.dispatchJobId,owner:'audit'});
    const result={methodology:{version:'advanced-intelligence-v3'},inputsAsOf:job.asOf,generatedAt:job.asOf,inputRevisions:job.revisions,inputHash:'audit'};
    db.exec(`CREATE TRIGGER reject_boundary ${target} BEGIN SELECT RAISE(ABORT,'audit failure'); END`);
    const activity=new SqlActivity(createSqlActivityBuffer());trackTransactions(db,activity);cacheStatements(db,64,{activity});
    assert.throws(()=>snapshots.publish({...job,result}),/audit failure/);
    assert.equal(db.inTransaction,false);assert.equal(activity.writeMetrics.status().total.transactions,0);
    for(const table of ['analysis_runs','analysis_inputs','analysis_latest'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,0,table);
    assert.equal(db.prepare('SELECT status FROM analysis_jobs').get().status,'running');
    runtime.close();db.close();
    // Real reopen and recovery, not a retry using cached repository state.
    db=new Database(file);db.pragma('foreign_keys=ON');db.pragma('synchronous=FULL');db.exec('DROP TRIGGER reject_boundary');
    runtime=new BusinessRuntime(db);const recovered=new AdvancedSnapshots(runtime);recovered.recover();
    const next=recovered.claim({jobId:job.jobId,owner:'audit-after-restart'});
    assert.ok(next.fence>job.fence);
    assert.throws(()=>recovered.publish({...job,result}),{code:'ANALYSIS_LEASE_LOST'});
    assert.equal(recovered.publish({...next,result}).persisted,true);
    assert.equal(recovered.publish({...next,result}).replayed,true);
    for(const table of ['analysis_runs','analysis_inputs','analysis_latest'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,1,table);
    assert.equal(db.prepare('SELECT status FROM analysis_jobs').get().status,'complete');
    assert.equal(db.pragma('synchronous',{simple:true}),2);
  }finally{runtime?.close();if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}
});

test('failure writing the real worker receipt rolls back market history and snapshot, then survives restart once',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-receipt-boundary-')),file=join(dir,'fixture.sqlite'),requestId='boundary-audit-receipt';
  let db=new Database(file),manager;
  try{
    migrate(db);
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON storage_commands WHEN NEW.request_id='boundary-audit-receipt' BEGIN SELECT RAISE(ABORT,'receipt audit failure'); END");
    db.close();
    const configure=()=>manager.request('domain.configure',{rootDir:dir,instruments:globalThis.__OGID_TEST_MARKET_INSTRUMENTS__,rss:{rssFeeds:[]}});
    manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});await manager.start();await configure();
    const quote={price:300,asOf:'2026-11-17T12:00:00Z',source:'yahoo',dataMode:'observed',synthetic:false};
    const input={kind:'market-publication',payload:{quotes:{GD:quote},snapshot:{quotes:{GD:quote},revision:'audit'}}};
    await assert.rejects(manager.request('runtime.save',input,{requestId}),{code:'SQLITE_CONSTRAINT_TRIGGER'});
    await manager.close();manager=null;
    db=new Database(file);
    assert.equal(db.prepare('SELECT count(*) n FROM quote_observations').get().n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM runtime_snapshots WHERE kind='market'").get().n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM storage_commands WHERE request_id=?').get(requestId).n,0);
    db.exec('DROP TRIGGER reject_receipt');db.close();
    manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});await manager.start();await configure();
    assert.deepEqual(await manager.request('runtime.save',input,{requestId}),{persisted:true});
    assert.deepEqual(await manager.request('runtime.save',input,{requestId}),{persisted:true});
    await manager.close();manager=null;
    db=new Database(file,{readonly:true});
    assert.equal(db.prepare('SELECT count(*) n FROM quote_observations').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM storage_commands WHERE request_id=?').get(requestId).n,1);
    assert.equal(JSON.parse(db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='market'").get().payload_json).revision,'audit');
  }finally{await manager?.close();if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}
});
