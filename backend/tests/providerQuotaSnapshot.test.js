import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {migrate} from '../storage/migrate.js';
import {ProviderQuotaSnapshot} from '../storage/providerQuotaSnapshot.js';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'ogid-quota-chunks-')),file=join(directory,'fixture.sqlite'),db=new Database(file);
 db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('wal_autocheckpoint=0');migrate(db);
 const store=new ProviderQuotaSnapshot(db);
 return {db,store,file,flat(value){db.prepare('INSERT INTO runtime_snapshots VALUES(?,?,?)').run('provider-quota','legacy',JSON.stringify(value));},packet(){return JSON.parse(db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='provider-quota'").get().payload_json);},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const events=(n,offset=0)=>Array.from({length:n},(_,i)=>({at:Date.UTC(2026,10,1)+i+offset,units:(i+offset)%3+1}));
const state=values=>({version:1,providers:{rss:{calls:values.length,success:values.length-1,errors:1,unknown:{preserved:true},events:{calls:values,success:structuredClone(values),errors:[{at:4,units:1},{at:4,units:1}],fallback:[]}},yahoo:{events:{calls:[],success:[]},otherCounters:{value:99}}},recovery:{cursor:'exact'}});

test('legacy quota loads without writes and upgrades with every field, duplicate and event order preserved',()=>{
 const f=fixture();try{
  const value=state(events(800));f.flat(value);const before=f.db.prepare('SELECT total_changes() n').get().n;
  assert.equal(JSON.stringify(f.store.load()),JSON.stringify(value));
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  f.store.save(value,'first');assert.equal(JSON.stringify(f.store.load()),JSON.stringify(value));
  assert.equal(f.packet().storageFormat,'ogid-provider-quota-chunks-v1');
  const reader=new Database(f.file,{readonly:true,fileMustExist:true});reader.pragma('query_only=ON');
  try{assert.deepEqual(new ProviderQuotaSnapshot(reader).load(),value);}finally{reader.close();}
  const restored=f.store.load();restored.providers.rss.events.calls[0].units=999;
  assert.notEqual(restored.providers.rss.events.success[0].units,999,'shared chunks must not alias mutable events');
 }finally{f.close();}
});

test('append and rolling prefix expiry reuse immutable chunks, keep storage bounded and skip identical saves',()=>{
 const f=fixture();try{
  let value=state(events(2200));f.store.save(value,'initial');
  const original=new Set(f.db.prepare('SELECT chunk_sha256 FROM provider_quota_chunks').all().map(row=>row.chunk_sha256));
  for(let i=0;i<90;i++){
   value=structuredClone(value);value.providers.rss.events.calls.shift();value.providers.rss.events.calls.push({at:Date.UTC(2026,10,2)+i,units:2});value.providers.rss.calls++;
   f.store.save(value,String(i));assert.equal(JSON.stringify(f.store.load()),JSON.stringify(value));
  }
  const current=f.db.prepare('SELECT chunk_sha256 FROM provider_quota_chunks').all().map(row=>row.chunk_sha256);
  assert.ok(current.filter(key=>original.has(key)).length>=7,'full middle chunks survive rolling prefix expiry');
  assert.ok(current.length<25,'tail appends must not create one chunk per event');
  const referenced=new Set(f.packet().arrays.flatMap(array=>array.refs.map(ref=>ref.sha256)));
  assert.deepEqual(new Set(current),referenced,'unreferenced chunks are removed atomically');
  const before=f.db.prepare('SELECT total_changes() n').get().n;f.store.save(value,'unchanged');
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  value.providers.rss.events.calls=[];value.providers.rss.events.success.reverse();
  f.store.save(value,'arbitrary-change');assert.deepEqual(f.store.load(),value);
  value=state(Array.from({length:1200},()=>({at:1,units:2})));f.store.save(value,'duplicates');
  value.providers.rss.events.calls.splice(0,103);value.providers.rss.events.calls.push(...Array.from({length:107},()=>({at:2,units:2})));
  f.store.save(value,'duplicate-overlap');assert.deepEqual(f.store.load(),value);
 }finally{f.close();}
});

test('failed writes and outer rollback retain the previous complete checkpoint; committed state survives reopen without replay',()=>{
 const f=fixture();try{
  const old=state(events(700)),next=state(events(701));f.store.save(old,'old');
  const rows=()=>f.db.prepare('SELECT * FROM provider_quota_chunks ORDER BY chunk_sha256').all(),before=rows(),packet=f.packet();
  f.db.exec("CREATE TRIGGER reject_quota_chunk BEFORE INSERT ON provider_quota_chunks BEGIN SELECT RAISE(ABORT,'injected quota failure');END");
  assert.throws(()=>f.store.save(next,'failed'),/injected quota failure/);
  assert.deepEqual(rows(),before);assert.deepEqual(f.packet(),packet);assert.deepEqual(f.store.load(),old);
  f.db.exec('DROP TRIGGER reject_quota_chunk');
  assert.throws(()=>f.db.transaction(()=>{f.store.save(next,'released-savepoint');throw Error('outer rollback');})(),/outer rollback/);
  assert.deepEqual(rows(),before);assert.deepEqual(f.store.load(),old);
  f.store.save(next,'committed-before-lost-ack');
  const reader=new Database(f.file,{readonly:true,fileMustExist:true});reader.pragma('query_only=ON');
  try{assert.deepEqual(new ProviderQuotaSnapshot(reader).load(),next);}finally{reader.close();}
 }finally{f.close();}
});

test('a query-only reader retains one WAL cut while the writer publishes a new manifest and removes old chunks',()=>{
 const f=fixture();let reader;try{
  const old=state(events(900)),next=state(events(20,9000));f.store.save(old,'old');
  reader=new Database(f.file,{readonly:true});reader.pragma('query_only=ON');
  const prepare=reader.prepare.bind(reader);let published=false;
  reader.prepare=sql=>{
   const statement=prepare(sql);
   if(sql==="SELECT payload_json FROM runtime_snapshots WHERE kind='provider-quota'"){
    const get=statement.get;statement.get=function(...args){const value=get.apply(this,args);if(!published){published=true;f.store.save(next,'concurrent');}return value;};
   }
   return statement;
  };
  const store=new ProviderQuotaSnapshot(reader);assert.deepEqual(store.load(),old);assert.deepEqual(store.load(),next);assert.equal(published,true);
 }finally{reader?.close();f.close();}
});

test('missing or corrupt chunks fail closed and cannot replace the last quota checkpoint',()=>{
 const f=fixture();try{
  const value=state(events(600));f.store.save(value,'initial');const packet=f.packet(),key=packet.arrays.find(a=>a.refs.length).refs[0].sha256;
  const original=f.db.prepare('SELECT * FROM provider_quota_chunks WHERE chunk_sha256=?').get(key);
  f.db.prepare('DELETE FROM provider_quota_chunks WHERE chunk_sha256=?').run(key);
  assert.throws(()=>f.store.load(),{code:'STORAGE_QUOTA_CHECKPOINT_INCOMPLETE'});
  assert.throws(()=>f.store.save(state(events(601)),'must-not-reset'),{code:'STORAGE_QUOTA_CHECKPOINT_INCOMPLETE'});
  assert.deepEqual(f.packet(),packet);
  f.db.prepare('INSERT INTO provider_quota_chunks VALUES(?,?,?)').run(original.chunk_sha256,original.item_count,original.payload_json);
  f.db.prepare("UPDATE provider_quota_chunks SET item_count=1,payload_json='[null]' WHERE chunk_sha256=?").run(key);
  assert.throws(()=>f.store.load(),{code:'STORAGE_QUOTA_CHECKPOINT_INCOMPLETE'});
 }finally{f.close();}
});

test('an isolated writer crash after FULL commit recovers the new checkpoint without replay or duplicate chunks',()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-quota-crash-')),file=join(directory,'fixture.sqlite');let db;
 try{
  db=new Database(file);db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');migrate(db);
  new ProviderQuotaSnapshot(db).save(state(events(600)),'before');db.close();db=null;
  const next=state(events(601)),module=new URL('../storage/providerQuotaSnapshot.js',import.meta.url).href;
  const databaseModule=new URL('../node_modules/better-sqlite3/lib/index.js',import.meta.url).href;
  const code=`import Database from ${JSON.stringify(databaseModule)};import{readFileSync}from'node:fs';import{ProviderQuotaSnapshot}from ${JSON.stringify(module)};const db=new Database(process.argv[1]);db.pragma('synchronous=FULL');db.pragma('wal_autocheckpoint=0');new ProviderQuotaSnapshot(db).save(JSON.parse(readFileSync(0,'utf8')),'committed-without-ack');process.kill(process.pid,'SIGKILL');`;
  // Kill only this newly spawned fixture writer, never an application process.
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,file],{input:JSON.stringify(next),encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined);assert.equal(child.signal,'SIGKILL',child.stderr);
  assert.ok(statSync(file+'-wal').size>0,'recover an unclosed WAL, not a graceful checkpoint');
  db=new Database(file);db.pragma('synchronous=FULL');const store=new ProviderQuotaSnapshot(db);
  assert.deepEqual(store.load(),next);
  const before=db.prepare('SELECT total_changes() n').get().n;store.save(next,'reconciled-identical');
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
 }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
});

test('JSON keys resembling prototype properties preserve values without prototype mutation',()=>{
 const f=fixture();try{
  const value=JSON.parse('{"providers":{"__proto__":{"events":{"__proto__":[{"x":1},{"x":1}],"calls":[null,"a",2]}},"rss":{"events":{"calls":[]}}},"other":null}');
  f.store.save(value,'keys');assert.equal(JSON.stringify(f.store.load()),JSON.stringify(value));assert.equal(Object.prototype.x,undefined);
 }finally{f.close();}
});

test('a rolling update of a large quota state writes at least 80 percent fewer WAL bytes than the flat snapshot',()=>{
 const flat=fixture(),chunked=fixture();try{
  const old=state(events(12000)),next=structuredClone(old);next.providers.rss.events.calls.shift();next.providers.rss.events.calls.push({at:99999999,units:2});next.providers.rss.calls++;
  flat.flat(old);chunked.store.save(old,'initial');
  flat.db.pragma('wal_checkpoint(TRUNCATE)');chunked.db.pragma('wal_checkpoint(TRUNCATE)');
  flat.db.transaction(()=>flat.db.prepare("UPDATE runtime_snapshots SET updated_at=?,payload_json=? WHERE kind='provider-quota'").run('next',JSON.stringify(next)))();
  chunked.store.save(next,'next');
  const before=statSync(flat.file+'-wal').size,after=statSync(chunked.file+'-wal').size;
  assert.equal(JSON.stringify(chunked.store.load()),JSON.stringify(next));assert.ok(after<before*.2,JSON.stringify({before,after}));
 }finally{flat.close();chunked.close();}
});
