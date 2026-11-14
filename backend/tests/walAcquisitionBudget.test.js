import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as wait} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {WalAcquisitionBudget} from '../storage/walAcquisitionBudget.js';
import {StorageManager} from '../storage/StorageManager.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ogid-wal-budget-')),file=join(dir,'fixture.sqlite'),db=new Database(file);
 db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('wal_autocheckpoint=0');
 db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY,payload TEXT)');db.pragma('wal_checkpoint(TRUNCATE)');
 return {db,file,dir,close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
function pin(f){const reader=new Database(f.file,{readonly:true});reader.pragma('query_only=ON');reader.exec('BEGIN');reader.prepare('SELECT count(*) FROM records').get();return reader;}

test('acquisition below the existing byte budget performs no copying or extra FULL checkpoint',async()=>{
 const f=fixture();try{
  f.db.prepare('INSERT INTO records VALUES(?,?)').run(1,'small');const before=f.db.pragma('wal_checkpoint(NOOP)');let drains=0;
  const budget=new WalAcquisitionBudget(f.db,async()=>{drains++;},{softLimitBytes:65536});await budget.wait();
  assert.equal(drains,0);assert.deepEqual(f.db.pragma('wal_checkpoint(NOOP)'),before);assert.equal(budget.status().waits,0);assert.equal(f.db.pragma('synchronous',{simple:true}),2);
 }finally{f.close();}
});

test('a pinned WAL pauses the next acquisition page without holding the writer or replaying committed data',async()=>{
 const f=fixture();let reader;try{
  reader=pin(f);f.db.prepare('INSERT INTO records VALUES(?,?)').run(1,'x'.repeat(65536));let entered,done=false,drains=0;
  const started=new Promise(resolve=>entered=resolve);
  const budget=new WalAcquisitionBudget(f.db,async()=>{drains++;assert.equal(f.db.inTransaction,false);f.db.pragma('wal_checkpoint(PASSIVE)');entered();},{softLimitBytes:16384,pollMs:5});
  const pending=budget.wait().then(()=>{done=true;});await started;await wait(10);assert.equal(done,false);
  f.db.prepare('INSERT INTO records VALUES(?,?)').run(2,'control-during-wait');assert.equal(f.db.prepare('SELECT count(*) n FROM records').get().n,2);
  reader.exec('ROLLBACK');reader.close();reader=null;await pending;
  assert.ok(drains>=2);assert.equal(budget.status().active,0);assert.equal(budget.status().waits,1);
  assert.equal(f.db.pragma('wal_checkpoint(NOOP)')[0].log,f.db.pragma('wal_checkpoint(NOOP)')[0].checkpointed);
  assert.equal(f.db.prepare('SELECT payload FROM records WHERE id=1').get().payload.length,65536);
 }finally{reader?.close();f.close();}
});

test('cancellation interrupts only the acquisition waiter while the existing checkpoint can still finish',async()=>{
 const f=fixture();let reader,finish;try{
  reader=pin(f);f.db.prepare('INSERT INTO records VALUES(?,?)').run(1,'x'.repeat(65536));
  let entered;const started=new Promise(resolve=>entered=resolve),controller=new AbortController();
  const budget=new WalAcquisitionBudget(f.db,()=>{entered();return new Promise(resolve=>finish=resolve);},{softLimitBytes:16384});
  const pending=budget.wait(controller.signal);await started;controller.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(budget.status().active,0);assert.equal(f.db.prepare('SELECT count(*) n FROM records').get().n,1);
  reader.exec('ROLLBACK');reader.close();reader=null;finish(f.db.pragma('wal_checkpoint(PASSIVE)'));
 }finally{finish?.();reader?.close();f.close();}
});

test('a failed checkpoint is not acknowledged as completion and waiting inside a transaction is rejected',async()=>{
 const f=fixture();try{
  f.db.prepare('INSERT INTO records VALUES(?,?)').run(1,'x'.repeat(65536));
  const budget=new WalAcquisitionBudget(f.db,async()=>{throw Object.assign(Error('checkpoint unavailable'),{code:'STORAGE_CHECKPOINT_UNAVAILABLE'});},{softLimitBytes:16384});
  await assert.rejects(budget.wait(),{code:'STORAGE_CHECKPOINT_UNAVAILABLE'});assert.equal(budget.status().active,0);
  f.db.exec('BEGIN');try{await assert.rejects(budget.wait(),{code:'STORAGE_WAL_BUDGET_IN_TRANSACTION'});}finally{f.db.exec('ROLLBACK');}
  assert.equal(f.db.prepare('SELECT count(*) n FROM records').get().n,1);
 }finally{f.close();}
});

test('RSS acquisition drains via its real parent checkpoint and leaves control commits available between pages',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-wal-rss-')),file=join(dir,'fixture.sqlite');
 const xml='<rss><channel><title>Fixture</title>'+Array.from({length:24},(_,i)=>`<item><title>Russia collected report ${i}</title><link>https://example.org/budget/${i}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('')+'</channel></rss>';
 const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/rss+xml'});res.end(xml);});server.listen(0,'127.0.0.1');await once(server,'listening');
 const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file,checkpointSoftBytes:16384,resourcePressureEnabled:false});let release,reader;
 try{
  await manager.start();await manager.request('domain.configure',{instruments:[],rootDir:dir,researchSources:[],rss:{pipelineMode:'canonical',maxFeedsPerRun:1,maxCorpusItems:30,rssFeeds:[{feedId:'budget-rss',label:'Fixture',url:`http://127.0.0.1:${server.address().port}/rss`} ]}});
  // Pin a real read cut so this case exercises WAL debt even when producer
  // pacing gives the normal checkpoint enough time to drain between pages.
  reader=new Database(file,{readonly:true});reader.exec('BEGIN');reader.prepare('SELECT count(*) FROM articles').get();
  let entered,held=false,drains=0;const start=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),request=manager.checkpoint.request.bind(manager.checkpoint);
  t.mock.method(manager.checkpoint,'request',async(...args)=>{if(!args.length){drains++;if(!held){held=true;entered();await gate;}}return request(...args);});
  const work=manager.request('domain.call',{service:'rss',method:'refresh',args:[{feedIds:['budget-rss'],maxFeedsPerCycle:1}]});
  await Promise.race([start,work.then(()=>{throw Error('No cooperative checkpoint boundary');})]);
  await manager.request('runtime.save',{kind:'control-during-rss-budget',payload:{confirmed:true}});
  assert.deepEqual(await manager.request('runtime.load',{kind:'control-during-rss-budget'}),{confirmed:true});reader.exec('ROLLBACK');reader.close();reader=null;release();
  const result=await work;assert.equal(result.items.length,24);assert.ok(drains>=1);
  const db=new Database(file,{readonly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM articles').get().n,24);assert.equal(db.prepare('SELECT count(*) n FROM storage_writer_owner').get().n,1);}finally{db.close();}
  assert.equal(manager.getStatus().synchronous,2);assert.deepEqual(manager.checkpoint.status().connection,{queryOnly:true,synchronous:2});
  assert.ok(manager.getStatus().walAcquisitionBudget.waits>=1);assert.equal(manager.getStatus().walAcquisitionBudget.active,0);
  assert.ok(manager.getStatus().walAcquisitionBudget.writePacing.chargedBytes>0,'the real acquisition worker must account committed writes');
  assert.equal(manager.getStatus().walAcquisitionBudget.writePacing.active,0);
 }finally{reader?.exec('ROLLBACK');reader?.close();release?.();await manager.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
