import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {operationContext} from '../services/shared/operationContext.js';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'ogid-rss-articles-')),db=new Database(join(directory,'db.sqlite'));
 db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('wal_autocheckpoint=0');migrate(db);
 const runtime=new BusinessRuntime(db,()=>{});
 return {db,runtime,close(){runtime.close();db.close();rmSync(directory,{recursive:true,force:true});}};
}
const snapshot=items=>({generatedAt:'2026-11-03T17:00:00.000Z',items,meta:{feedStatus:[{feedId:'real-source',status:'ok'}]}});
const articles=count=>Array.from({length:count},(_,n)=>({id:'source-'+n,title:'Permitted report '+n,description:'Retained permitted description '.repeat(80),provenance:{sourceId:'source-'+n,fetchedAt:'2026-11-03T17:00:00.000Z'}}));

test('RSS legacy/public checkpoints reopen with exact values, order, duplicates and independent objects',async()=>{
 const f=fixture();try{
  const [a,b]=articles(2);a.title='Titular con símbolos: España, 📈 y 𠮷';const value=snapshot([a,b,a]);f.runtime.save('rss',value);
  assert.deepEqual(f.runtime.load('rss'),value);
  await f.runtime.saveRssSnapshot(value);
  const restored=new BusinessRuntime(f.db,()=>{}).load('rss');
  assert.deepEqual(restored,value);assert.equal(JSON.stringify(restored),JSON.stringify(value));assert.notEqual(restored.items[0],restored.items[2]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM runtime_snapshots WHERE kind GLOB 'rss-article:v4:*'").get().n,2);
  await f.runtime.saveRssSnapshot(snapshot([]));assert.deepEqual(f.runtime.load('rss').items,[]);
 }finally{f.close();}
});

test('RSS descriptor failure preserves the previous complete snapshot and staged bodies recover after restart',async()=>{
 const f=fixture();try{
  const before=snapshot(articles(1)),after=snapshot(articles(3));await f.runtime.saveRssSnapshot(before);
  f.db.exec("CREATE TRIGGER fail_rss_descriptor BEFORE INSERT ON runtime_snapshots WHEN NEW.kind='rss' BEGIN SELECT RAISE(ABORT,'Descriptor failure'); END");
  await assert.rejects(f.runtime.saveRssSnapshot(after),{code:'SQLITE_CONSTRAINT_TRIGGER'});
  const reopened=new BusinessRuntime(f.db,()=>{});assert.deepEqual(reopened.load('rss'),before);
  while(reopened.rssArticles.needsPrune)reopened.rssArticles.prune({limit:2});
  assert.deepEqual(reopened.load('rss'),before);
  f.db.exec('DROP TRIGGER fail_rss_descriptor');await reopened.saveRssSnapshot(after);assert.deepEqual(reopened.load('rss'),after);
 }finally{f.close();}
});

test('RSS cancellation between staged pages holds no transaction, retains its old descriptor and resumes without lost items',async()=>{
 const f=fixture(),controller=new AbortController();try{
  const before=snapshot([{id:'previous'}]),after=snapshot(articles(35));await f.runtime.saveRssSnapshot(before);
  await assert.rejects(operationContext.run({signal:controller.signal,committed:()=>controller.abort(Object.assign(Error('Stopped'),{code:'TEST_STOP'}))},()=>f.runtime.saveRssSnapshot(after)),{code:'TEST_STOP'});
  assert.equal(f.db.inTransaction,false);assert.deepEqual(f.runtime.load('rss'),before);
  const staged=f.db.prepare("SELECT count(*) n FROM runtime_snapshots WHERE kind GLOB 'rss-article:v4:*'").get().n;
  assert.ok(staged>1&&staged<36);
  const reopened=new BusinessRuntime(f.db,()=>{});await reopened.saveRssSnapshot(after);assert.deepEqual(reopened.load('rss'),after);
 }finally{f.close();}
});

test('RSS captures bodies and metadata before yielding to another cooperative update',async()=>{
 const f=fixture();let release,arrived;const entered=new Promise(r=>{arrived=r;}),gate=new Promise(r=>{release=r;});
 try{
  const value=snapshot(articles(2)),expected=structuredClone(value);
  const saving=operationContext.run({signal:new AbortController().signal,committed:()=>{},waitForResources:async()=>{arrived();await gate;}},()=>f.runtime.saveRssSnapshot(value));
  await entered;assert.equal(f.db.inTransaction,false);
  value.items[0].title='A later in-memory revision';value.meta.feedStatus[0].status='failed';value.generatedAt='2026-11-03T18:00:00.000Z';
  release();await saving;assert.deepEqual(f.runtime.load('rss'),expected);
 }finally{release?.();f.close();}
});

test('RSS missing or altered bodies and altered order fail closed rather than returning a partial checkpoint',async()=>{
 const f=fixture();try{
  const value=snapshot(articles(2));await f.runtime.saveRssSnapshot(value);
  const stored=JSON.parse(f.db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='rss'").get().payload_json),key='rss-article:v4:'+stored.items.refs[0];
  const payload=f.db.prepare('SELECT payload_json FROM runtime_snapshots WHERE kind=?').get(key).payload_json;
  f.db.prepare('DELETE FROM runtime_snapshots WHERE kind=?').run(key);assert.throws(()=>f.runtime.load('rss'),{code:'STORAGE_RSS_CHECKPOINT_INCOMPLETE'});
  f.db.prepare('INSERT INTO runtime_snapshots VALUES(?,?,?)').run(key,new Date().toISOString(),'{"id":"tampered"}');assert.throws(()=>f.runtime.load('rss'),{code:'STORAGE_RSS_CHECKPOINT_INCOMPLETE'});
  f.db.prepare('UPDATE runtime_snapshots SET payload_json=? WHERE kind=?').run(payload,key);
  stored.items.refs.reverse();f.db.prepare("UPDATE runtime_snapshots SET payload_json=? WHERE kind='rss'").run(JSON.stringify(stored));assert.throws(()=>f.runtime.load('rss'),{code:'STORAGE_RSS_CHECKPOINT_INCOMPLETE'});
 }finally{f.close();}
});

test('one changed RSS article preserves the full snapshot with at least 80% fewer WAL bytes than the monolithic checkpoint',async t=>{
 const legacy=fixture(),current=fixture();try{
  const first=snapshot(articles(256)),next=structuredClone(first);next.generatedAt='2026-11-03T17:01:00.000Z';next.items[0].title='Corrected permitted title';
  legacy.runtime.save('rss',first);legacy.db.pragma('wal_checkpoint(TRUNCATE)');legacy.runtime.save('rss',next);const beforeBytes=statSync(legacy.db.name+'-wal').size;
  await current.runtime.saveRssSnapshot(first);current.db.pragma('wal_checkpoint(TRUNCATE)');await current.runtime.saveRssSnapshot(next);const afterBytes=statSync(current.db.name+'-wal').size;
  const reduction=1-afterBytes/beforeBytes;t.diagnostic(JSON.stringify({fixture:true,changed:1,total:256,beforeBytes,afterBytes,reduction,synchronous:current.db.pragma('synchronous',{simple:true})}));
  assert.ok(reduction>=0.8);assert.equal(current.db.pragma('synchronous',{simple:true}),2);assert.deepEqual(current.runtime.load('rss'),next);
 }finally{legacy.close();current.close();}
});

test('RSS cache pruning follows every current owner and removes only unreferenced derived bodies in bounded pages',async()=>{
 const f=fixture();try{
  const value=snapshot(articles(24));await f.runtime.saveRssSnapshot(value);
  const captured=f.runtime.rssArticles.capture(value.items);await f.runtime.rssArticles.stage(captured);
  f.runtime.save('rss-canonical-corpus:v3',captured.descriptor);
  await f.runtime.saveRssSnapshot(snapshot([]));
  let pages=0;while(f.runtime.rssArticles.needsPrune){const page=f.runtime.rssArticles.prune({limit:3});assert.ok(page.processed<=3);pages++;assert.ok(pages<100);}
  assert.deepEqual(f.runtime.rssArticles.load(f.runtime.load('rss-canonical-corpus:v3')),value.items);
  assert.equal(f.db.prepare("SELECT count(*) n FROM runtime_snapshots WHERE kind GLOB 'rss-article:v4:*'").get().n,24);
  f.runtime.save('rss-canonical-corpus:v3',[]);
  while(f.runtime.rssArticles.needsPrune)f.runtime.rssArticles.prune({limit:3});
  assert.equal(f.db.prepare("SELECT count(*) n FROM runtime_snapshots WHERE kind GLOB 'rss-article:v4:*'").get().n,0);
  assert.deepEqual(f.runtime.load('rss'),snapshot([]));
 }finally{f.close();}
});

test('a pinned read-only RSS checkpoint remains complete while the writer replaces and prunes its old cache bodies',async()=>{
 const f=fixture();let reader;try{
  const before=snapshot(articles(3));await f.runtime.saveRssSnapshot(before);
  reader=new Database(f.db.name,{readonly:true});reader.pragma('query_only=ON');reader.exec('BEGIN');
  reader.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='rss'").get();
  const oldView=new BusinessRuntime(reader,()=>{});
  await f.runtime.saveRssSnapshot(snapshot([]));while(f.runtime.rssArticles.needsPrune)f.runtime.rssArticles.prune({limit:2});
  assert.deepEqual(oldView.load('rss'),before);assert.equal(reader.readonly,true);assert.equal(reader.pragma('query_only',{simple:true}),1);
  reader.exec('ROLLBACK');reader.close();reader=null;
  assert.deepEqual(f.runtime.load('rss'),snapshot([]));
 }finally{reader?.close();f.close();}
});
