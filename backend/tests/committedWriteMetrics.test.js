import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cacheStatements} from '../storage/statementCache.js';
import {SqlActivity,createSqlActivityBuffer,trackTransactions} from '../storage/sqlActivity.js';
import {writeMetricBucket} from '../storage/committedWriteMetrics.js';
import {StorageManager} from '../storage/StorageManager.js';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'ogid-committed-writes-')),db=new Database(join(directory,'fixture.sqlite'));
 db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');
 db.exec('CREATE TABLE runtime_snapshots(kind TEXT PRIMARY KEY,updated_at TEXT,payload_json TEXT);CREATE TABLE articles(id TEXT PRIMARY KEY,payload TEXT);');
 const activity=new SqlActivity(createSqlActivityBuffer());trackTransactions(db,activity);cacheStatements(db,64,{activity});
 const put=db.prepare('INSERT INTO runtime_snapshots VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json WHERE runtime_snapshots.payload_json!=excluded.payload_json');
 return {db,activity,save:(kind,payload)=>put.run(kind,'2026-11-14T00:00:00Z',payload),close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('write metrics advance only after the outer FULL commit and discard rolled back savepoints',()=>{
 const f=fixture();try{
  const quota='{"calls":[1]}',body='{"title":"private body"}';
  f.db.transaction(()=>{
   f.save('provider-quota',quota);
   assert.throws(()=>f.db.transaction(()=>{f.save('provider-quota','{"calls":[1,2]}');throw Error('nested rollback');})(),/nested rollback/);
   f.db.transaction(()=>f.save('rss-article:v5:private-identity',body))();
   assert.equal(f.activity.writeMetrics.status().total.transactions,0,'a released savepoint is not a durable outer commit');
  })();
  const status=f.activity.writeMetrics.status();
  assert.equal(f.db.pragma('synchronous',{simple:true}),2);
  assert.deepEqual(status.total,{transactions:1,statements:2,rowsChanged:2,bindingBytes:Buffer.byteLength(quota)+Buffer.byteLength(body),largestBindingBytes:Buffer.byteLength(body)});
  assert.equal(status.buckets['snapshot:provider-quota'].transactions,1);
  assert.equal(status.buckets['snapshot:rss-body'].transactions,1);
  assert.equal(f.db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='provider-quota'").get().payload_json,quota);
  const before=structuredClone(status);
  assert.throws(()=>f.db.transaction(()=>{f.db.transaction(()=>f.save('provider-quota','{"calls":[3]}'))();throw Error('outer rollback');})(),/outer rollback/);
  assert.deepEqual(f.activity.writeMetrics.status(),before);
 }finally{f.close();}
});

test('unchanged snapshots and reads do not count, autocommits do, and buckets preserve transaction overlap',()=>{
 const f=fixture();try{
  const quota='{"calls":1}';f.save('provider-quota',quota);
  f.save('provider-quota',quota);
  f.db.transaction(()=>f.db.prepare('SELECT * FROM runtime_snapshots').all())();
  assert.equal(f.activity.writeMetrics.status().total.transactions,1);
  f.db.transaction(()=>{
   f.save('provider-quota','{"calls":2}');f.save('provider-quota','{"calls":3}');
   f.db.prepare('INSERT INTO articles VALUES(?,?)').run('id','article');
  })();
  const status=f.activity.writeMetrics.status();
  assert.equal(status.total.transactions,2);assert.equal(status.total.statements,4);
  assert.equal(status.buckets['snapshot:provider-quota'].transactions,2);
  assert.equal(status.buckets['snapshot:provider-quota'].statements,3);
  assert.equal(status.buckets.articles.transactions,1);
  status.buckets.articles.transactions=1000;
  assert.equal(f.activity.writeMetrics.status().buckets.articles.transactions,1);
 }finally{f.close();}
});

test('arbitrary snapshot and table identities collapse to fixed labels without exposing bindings',()=>{
 const f=fixture();try{
  f.db.transaction(()=>{
   for(let n=0;n<300;n++){
    f.save('rss-canonical-feed:private-feed-'+n,'{"privateContent":true}');
    f.save('unrecognized-private-'+n,'{"privateContent":true}');
   }
  })();
  const status=f.activity.writeMetrics.status(),serialized=JSON.stringify(status);
  assert.deepEqual(Object.keys(status.buckets).sort(),['snapshot:other','snapshot:rss-feed']);
  assert.equal(status.total.transactions,1);assert.equal(status.total.statements,600);
  assert.ok(serialized.length<2048);assert.equal(serialized.includes('private'),false);
  assert.equal(writeMetricBucket('unrecognized_private_table',[]),'other');
 }finally{f.close();}
});

test('the real writer exposes committed quota frequency without changing persistence or counting identical saves',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-write-metrics-worker-'));
 const manager=new StorageManager({enabled:true,databasePath:join(directory,'fixture.sqlite')});
 try{
  await manager.start();const payload={providers:{fixture:{calls:1}}};
  await manager.request('runtime.save',{kind:'provider-quota',payload});
  await manager.request('runtime.save',{kind:'provider-quota',payload});
  assert.deepEqual(await manager.request('runtime.load',{kind:'provider-quota'}),payload);
  const status=await manager.request('storage.status');
  assert.equal(status.synchronous,2);assert.equal(status.readOnlyConnection,false);
  assert.equal(status.committedWrites.buckets['snapshot:provider-quota'].transactions,1);
  assert.equal(status.committedWrites.buckets['snapshot:provider-quota'].statements,1);
  assert.equal(status.committedWrites.buckets['snapshot:provider-quota'].bindingBytes,Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(JSON.stringify(status.committedWrites).includes('"fixture"'),false);
 }finally{await manager.close();rmSync(directory,{recursive:true,force:true});}
});
