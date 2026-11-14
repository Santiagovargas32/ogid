import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommitBuffer,CommitActivity} from '../storage/commitActivity.js';
import {CommittedWritePacer} from '../storage/committedWritePacer.js';
import {WalAcquisitionBudget} from '../storage/walAcquisitionBudget.js';

test('committed SQL weight is charged once, with bounded refill and no work replay',async()=>{
 const buffer=createCommitBuffer(),commits=new CommitActivity(buffer),delays=[];let clock=0;
 const pacer=new CommittedWritePacer(buffer,{bytesPerSecond:4096,burstBytes:4096,now:()=>clock,sleep:async ms=>{delays.push(ms);clock+=ms;}});
 commits.committed(4096);await pacer.wait();assert.equal(delays.length,0);
 commits.committed(8192);await pacer.wait();assert.deepEqual(delays,[1000,1000]);
 await pacer.wait();assert.equal(delays.length,2);assert.equal(pacer.status().chargedBytes,12288);assert.equal(pacer.status().active,0);
});

test('a long idle period cannot accumulate an unbounded later write burst',async()=>{
 const buffer=createCommitBuffer(),commits=new CommitActivity(buffer),delays=[];let clock=0;
 const pacer=new CommittedWritePacer(buffer,{bytesPerSecond:4096,burstBytes:4096,now:()=>clock,sleep:async ms=>{clock+=ms;delays.push(ms);}});
 clock=1000000;commits.committed(12288);await pacer.wait();
 assert.deepEqual(delays,[1000,1000]);assert.equal(pacer.status().debtBytes,0);
});

test('workflow boundaries skip unrelated historical writes but preserve acquisition debt and concurrent accounting',async()=>{
 const buffer=createCommitBuffer(),commits=new CommitActivity(buffer),delays=[];let clock=0;
 const pacer=new CommittedWritePacer(buffer,{bytesPerSecond:4096,burstBytes:4096,now:()=>clock,sleep:async ms=>{clock+=ms;delays.push(ms);}});
 commits.committed(64*1024*1024);const finish=pacer.begin();await pacer.wait();assert.equal(pacer.status().chargedBytes,0);
 const other=pacer.begin();commits.committed(8192);finish();finish();
 assert.equal(pacer.status().workflows,1);await pacer.wait();other();
 assert.equal(pacer.status().workflows,0);assert.equal(pacer.status().chargedBytes,8192);assert.deepEqual(delays,[1000]);
 const tail=pacer.begin();commits.committed(4096);tail();
 commits.committed(64*1024*1024);const next=pacer.begin();await pacer.wait();next();
 assert.equal(pacer.status().chargedBytes,12288);assert.deepEqual(delays,[1000,1000]);
});

test('concurrent acquisition waiters share charges while cancellation retains committed debt for recovery',async()=>{
 const buffer=createCommitBuffer(),commits=new CommitActivity(buffer);let clock=0;const releases=[];
 const pacer=new CommittedWritePacer(buffer,{bytesPerSecond:4096,burstBytes:4096,now:()=>clock,sleep:()=>new Promise(resolve=>releases.push(resolve))});
 commits.committed(8192);const first=pacer.wait(),second=pacer.wait();assert.equal(releases.length,2);
 clock=1000;for(const release of releases)release();await Promise.all([first,second]);
 assert.equal(pacer.status().chargedBytes,8192);assert.equal(pacer.status().active,0);
 const controller=new AbortController();
 const cancelled=new CommittedWritePacer(buffer,{bytesPerSecond:4096,burstBytes:4096,now:()=>clock,sleep:(_ms,signal)=>pause(10000,undefined,{signal})});
 commits.committed(8192);const pending=cancelled.wait(controller.signal);controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled.status().active,0);assert.equal(cancelled.status().chargedBytes,8192);
 clock+=1000;await cancelled.wait();assert.equal(cancelled.status().chargedBytes,8192);assert.equal(cancelled.status().debtBytes,0);
});

test('producer pacing yields without a SQLite transaction or checkpoint and admits control writes meanwhile',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-write-pacing-')),db=new Database(join(directory,'fixture.sqlite'));
 try{
  db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY,payload TEXT)');db.pragma('wal_checkpoint(TRUNCATE)');
  const buffer=createCommitBuffer(),commits=new CommitActivity(buffer);let clock=0,controls=0,drains=0;
  const budget=new WalAcquisitionBudget(db,async()=>{drains++;},{commitBuffer:buffer,writePacing:{bytesPerSecond:4096,burstBytes:4096,now:()=>clock,sleep:async ms=>{
   assert.equal(db.inTransaction,false);if(!controls++){db.prepare('INSERT INTO records VALUES(?,?)').run(1,'control');commits.committed(4096);}clock+=ms;
  }}});
  commits.committed(8192);await budget.wait();
  assert.equal(db.prepare('SELECT payload FROM records WHERE id=1').get().payload,'control');assert.equal(drains,0);
  assert.equal(budget.status().writePacing.chargedBytes,12288);assert.equal(budget.status().writePacing.active,0);assert.equal(db.pragma('synchronous',{simple:true}),2);
  db.exec('BEGIN');try{await assert.rejects(budget.wait(),{code:'STORAGE_WAL_BUDGET_IN_TRANSACTION'});}finally{db.exec('ROLLBACK');}
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
