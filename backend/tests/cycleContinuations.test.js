import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../storage/migrate.js';
import {CycleContinuations} from '../storage/cycleContinuations.js';
import {StorageManager} from '../storage/StorageManager.js';
import {storageOperationContract} from '../contracts/storageOperations.js';
import {AdminHistoryProjection} from '../storage/adminHistoryProjection.js';

const intent={jobId:'cycle-1',scope:'news',phase:'financial-ingestion',input:{articles:[{id:'a',revision:3}],options:{backfill:false,trigger:'scheduled-news'}}};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ogid-continuations-')),file=join(dir,'ledger.sqlite');let db,time=1000,repo;
 const open=()=>{db=new Database(file);db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');migrate(db);repo=new CycleContinuations(db,{now:()=>time});};open();
 return {get db(){return db;},get repo(){return repo;},file,expire:()=>time+=90001,reopen(){db.close();open();},close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('exact intent survives real reopen, conflicts cannot overwrite it, and only one active scope exists',()=>{
 const f=fixture();try{
  const admitted=f.repo.admit(intent);f.reopen();assert.deepEqual(f.repo.get(intent),admitted);
  assert.deepEqual(f.repo.admit(intent),admitted);
  assert.throws(()=>f.repo.admit({...intent,input:{articles:[]}}),{code:'STORAGE_IDEMPOTENCY_CONFLICT'});
  assert.throws(()=>f.repo.admit({...intent,jobId:'cycle-2'}),{code:'CONTINUATION_SCOPE_BUSY'});
  assert.equal(f.repo.pending()[0].phase,'financial-ingestion');
 }finally{f.close();}
});
test('phase effects, cursor and transition receipt roll back together; lost ACK replays once after reopen',()=>{
 const f=fixture();try{
  f.db.exec('CREATE TABLE effect(id PRIMARY KEY)');f.repo.admit(intent);const auth=f.repo.claim({jobId:intent.jobId,owner:'writer-a'});
  const step={...auth,cursor:0,phase:'done',input:{selectionHash:'frozen'},complete:true,transitionId:'phase-1'};
  f.db.exec("CREATE TRIGGER reject_phase BEFORE UPDATE ON acquisition_jobs WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'phase failure'); END");
  assert.throws(()=>f.repo.advance(step,()=>f.db.prepare('INSERT INTO effect VALUES(?)').run('once')),/phase failure/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM effect').get().n,0);assert.equal(f.repo.get(intent).cursor,0);
  f.db.exec('DROP TRIGGER reject_phase');f.repo.advance(step,()=>f.db.prepare('INSERT INTO effect VALUES(?)').run('once'));
  f.reopen();f.expire();assert.equal(f.repo.advance(step,()=>assert.fail('must not repeat effects')).replayed,true);
  assert.equal(f.repo.pending().length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM effect').get().n,1);
  assert.throws(()=>f.repo.advance({...step,input:{different:true}}),{code:'STORAGE_IDEMPOTENCY_CONFLICT'});
  assert.equal(f.db.pragma('synchronous',{simple:true}),2);
 }finally{f.close();}
});
test('expired claim increments fence and blocks all old-owner transitions',()=>{
 const f=fixture();try{
  f.repo.admit(intent);const a=f.repo.claim({jobId:intent.jobId,owner:'a'});
  assert.equal(f.repo.claim({jobId:intent.jobId,owner:'b'}),null);f.expire();f.reopen();
  const b=f.repo.claim({jobId:intent.jobId,owner:'b'});assert.equal(b.fence,a.fence+1);
  assert.throws(()=>f.repo.renew(a),{code:'CONTINUATION_LEASE_LOST'});
  assert.throws(()=>f.repo.release(a),{code:'CONTINUATION_LEASE_LOST'});
  assert.throws(()=>f.repo.advance({...a,cursor:0,phase:'done',input:null,complete:true,transitionId:'old'}),{code:'CONTINUATION_LEASE_LOST'});
  f.repo.release(b);assert.ok(f.repo.claim({jobId:intent.jobId,owner:'c'}).fence>b.fence);
 }finally{f.close();}
});
test('descriptor and pending pages stay bounded; malformed inputs never become admitted work',()=>{
 const f=fixture();try{
  assert.throws(()=>f.repo.admit({...intent,input:'x'.repeat(65536)}),{code:'CONTINUATION_INPUT_TOO_LARGE'});
  for(const input of [{n:Infinity},{n:NaN},{missing:undefined},new Date(),{callback:()=>{}}])assert.throws(()=>f.repo.admit({...intent,input}),{code:'CONTINUATION_INVALID_INPUT'});
  assert.equal(f.repo.pending().length,0);
  for(let i=0;i<70;i++)f.repo.admit({...intent,jobId:'cycle-'+String(i).padStart(3,'0'),scope:'source-'+i});
  const first=f.repo.pending();assert.equal(first.length,64);assert.equal(f.repo.pending({after:first.at(-1).jobId}).length,6);
  assert.equal(storageOperationContract('continuation.advance').resourceClass,'commit');
  assert.equal(storageOperationContract('continuation.pending').pureRead,true);
 }finally{f.close();}
});
test('real writer transport preserves intent, fence and exact transition across restart',async()=>{
 const f=fixture();let manager;try{
  manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:f.file});await manager.start();
  await manager.request('continuation.admit',intent);const auth=await manager.request('continuation.claim',{jobId:intent.jobId,owner:'transport'});
  const step={...auth,cursor:0,phase:'source-fresh',input:{httpStatus:304},transitionId:'response-304'};
  await manager.request('continuation.advance',step);await manager.close();
  manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:f.file});await manager.start();
  const recovered=await manager.request('continuation.get',intent);assert.deepEqual(recovered.input,{httpStatus:304});assert.equal(recovered.cursor,1);
  await assert.rejects(manager.request('continuation.advance',step),{code:'CONTINUATION_LEASE_LOST'});
  const next=await manager.request('continuation.claim',{jobId:intent.jobId,owner:'transport-restarted'});
  assert.ok(next.fence>auth.fence);
  assert.equal((await manager.request('continuation.advance',{jobId:next.jobId,owner:next.owner,fence:next.fence,cursor:next.cursor,phase:'done',input:null,complete:true,transitionId:'finish'})).status,'complete');
 }finally{await manager?.close();f.close();}
});
test('pending internal continuations cannot displace candle jobs from a bounded Admin history page',()=>{
 const f=fixture();try{
  f.db.prepare('INSERT INTO acquisition_jobs VALUES(?,?,?,?,?,?,?)').run('history','history','history','pending','1970-01-01','1970-01-01','{}');
  for(let i=0;i<70;i++)f.repo.admit({...intent,jobId:'internal-'+i,scope:'source-'+i});
  const view=new AdminHistoryProjection(f.db).get({jobsLimit:1});
  assert.equal(view.jobs.length,1);assert.equal(view.jobs[0].jobId,'history');assert.equal(view.pagination.jobs.hasMore,false);
 }finally{f.close();}
});
