import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../storage/migrate.js';
import {SqlResearchStore,SqlCandleStore} from '../storage/sqlRepositories.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {ingestNewsBatches} from '../storage/newsIngestion.js';
import {StorageManager} from '../storage/StorageManager.js';
import {createSqlActivityBuffer,SqlActivity,readSqlActivity,trackTransactions} from '../storage/sqlActivity.js';
import {cacheStatements} from '../storage/statementCache.js';

const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
function fixture(){const directory=mkdtempSync(join(tmpdir(),'ogid-writer-responsive-')),db=new Database(join(directory,'fixture.sqlite'));db.pragma('journal_mode=WAL');migrate(db);return {db,close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
function delayRows(db,pattern,ms){const prepare=db.prepare.bind(db);db.prepare=sql=>{const statement=prepare(sql);if(pattern.test(sql)){const get=statement.get;statement.get=function(...args){pause(ms);return get.apply(this,args);};}return statement;};}
test('projection validation stops at a time boundary and resumes without dropping any historical event',()=>{
 const f=fixture();try{
  const store=new SqlResearchStore(f.db);
  store.transact(state=>{for(let i=0;i<20;i++)state.events[`event-${i}`]={eventId:`event-${i}`,identityVersion:'legacy',revision:1,evidence:[]};});
  f.db.prepare("DELETE FROM runtime_meta WHERE key='projection.events.status'").run();
  delayRows(f.db,/SELECT entity_id,payload_json FROM research_rows WHERE rowid/,3);
  const first=store.validateProjectionPage({limit:20,budgetMs:5});assert.ok(first.processed<20);assert.equal(first.hasMore,true);
  let count=first.processed,result=first;while(result.hasMore){result=store.validateProjectionPage({limit:20,budgetMs:5});count+=result.processed;}
  assert.equal(count,20);assert.equal(result.status,'ready');
 }finally{f.close();}
});
test('candle validation yields between bounded time pages and retains all original revisions',()=>{
 const f=fixture();try{
  const store=new SqlCandleStore(f.db);
  store.append(Array.from({length:20},(_,i)=>({instrumentId:'crypto-bitcoin-us-dollar',interval:'5min',openTime:new Date(Date.UTC(2026,0,1,0,i*5)).toISOString(),closeTime:new Date(Date.UTC(2026,0,1,0,(i+1)*5)).toISOString(),open:100,high:102,low:99,close:101,volume:1,adjusted:true,revision:1})));
  f.db.prepare('DELETE FROM candle_validations').run();delayRows(f.db,/SELECT \* FROM candles WHERE rowid/,3);
  let result=store.validatePage({limit:20,budgetMs:5}),count=result.processed;assert.ok(count<20);assert.equal(result.hasMore,true);
  while(result.hasMore){result=store.validatePage({limit:20,budgetMs:5});count+=result.processed;}
  assert.equal(count,20);assert.equal(f.db.prepare('SELECT count(*) AS n FROM candle_revisions').get().n,20);assert.equal(f.db.prepare('SELECT count(*) AS n FROM candle_validations').get().n,20);
 }finally{f.close();}
});
test('one maintenance command performs only one validation phase',()=>{
 const f=fixture();try{
  const runtime=new BusinessRuntime(f.db,()=>{}),called=[];
  runtime.services={candles:{validatePage(){called.push('candles');return {hasMore:true};}},store:{validateProjectionPage(){called.push('research');return {hasMore:true};}}};
  for(let i=0;i<4;i++){const before=called.length;runtime.indexPage({});assert.ok(called.length-before<=1);}
  assert.ok(called.includes('candles'));assert.ok(called.includes('research'));
 }finally{f.close();}
});
test('RSS intake adapts commit size to elapsed work and acknowledges only actually committed rows',async()=>{
 const f=fixture();let archive;
 try{
  archive=new SqlNewsArchive(f.db);const save=archive.save.bind(archive);archive.save=article=>{pause(25);return save(article);};
  const articles=Array.from({length:14},(_,i)=>({id:`source-${i}`,title:`Fixture report ${i}`,url:`https://fixture.invalid/${i}`,provider:'rss',publishedAt:'2026-10-23T12:00:00Z'})),pages=[];
  const accepted=await ingestNewsBatches(archive,articles,{},(_offset,page)=>pages.push(page));
  assert.ok(pages[0].rows<10);assert.equal(pages.reduce((n,p)=>n+p.rows,0),14);assert.equal(accepted,14);assert.equal(f.db.prepare('SELECT count(*) AS n FROM articles').get().n,14);
 }finally{archive?.close();f.close();}
});
test('a rolled-back RSS page never acknowledges rows or retains an advanced in-memory revision',async()=>{
 const f=fixture();let archive;try{
  archive=new SqlNewsArchive(f.db);const save=archive.save.bind(archive);let saved=0,acks=0;
  archive.save=article=>{if(++saved===2)throw Object.assign(Error('fixture full'),{code:'SQLITE_FULL'});return save(article);};
  const articles=Array.from({length:3},(_,i)=>({title:`Rollback ${i}`,url:`https://fixture.invalid/rollback-${i}`,provider:'rss'}));
  await assert.rejects(ingestNewsBatches(archive,articles,{},()=>acks++),{code:'SQLITE_FULL'});
  assert.equal(acks,0);assert.equal(archive.revision,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM articles').get().n,0);
  archive.save=save;assert.equal(await ingestNewsBatches(archive,articles,{}),3);
 }finally{archive?.close();f.close();}
});
test('maintenance admission waits for acquisition and gives a real commit the next writer slot',async()=>{
 const manager=new StorageManager({enabled:true,businessEnabled:true}),sent=[];
 manager.state='ready';manager.worker={postMessage:m=>sent.push(m),terminate:()=>Promise.resolve()};
 const finish=message=>manager.handleMessage({id:message.id,result:{},durationMs:1,status:{}});
 const rss=manager.localRequest('domain.call',{service:'rss',method:'refresh'});
 const maintenance=manager.localRequest('domain.indexPage',{}),write=manager.localRequest('runtime.save',{kind:'fixture',payload:{}});
 assert.deepEqual(sent.map(m=>JSON.parse(m.encoded).operation),['domain.call','runtime.save']);
 finish(sent[1]);await write;assert.equal(sent.length,2);finish(sent[0]);await rss;
 assert.equal(JSON.parse(sent[2].encoded).operation,'domain.indexPage');finish(sent[2]);await maintenance;
 manager.state='closed';
});
test('native transaction stalls remain observable from the parent and keep the original write guard',async()=>{
 const f=fixture(),manager=new StorageManager({enabled:true,databasePath:f.db.name,timeoutMs:100,busyTimeoutMs:2000});
 try{
  await manager.start();f.db.exec('BEGIN IMMEDIATE');
  const now=new Date().toISOString();await assert.rejects(manager.request('pipeline.record',{runId:'blocked-fixture',pipelineId:'storage',status:'healthy',startedAt:now,completedAt:now,counts:{processed:1}}),{code:'STORAGE_OUTCOME_UNKNOWN'});
  const status=manager.getStatus();assert.equal(status.failure.causeCode,'STORAGE_EXECUTION_TIMEOUT');assert.equal(status.failure.sqlActivity.transaction.phase,'begin');assert.ok(status.failure.sqlActivity.transaction.elapsedMs>=90);
  f.db.exec('ROLLBACK');await manager.close();
 }finally{if(f.db.inTransaction)f.db.exec('ROLLBACK');await manager.close();f.close();}
});
test('shared native activity contains no bindings or quoted content and preserves nested rollback behavior',()=>{
 const f=fixture();try{
  const buffer=createSqlActivityBuffer(),activity=new SqlActivity(buffer);cacheStatements(f.db,256,{activity});trackTransactions(f.db,activity);
  f.db.transaction(()=>{
   f.db.prepare("SELECT 'private-source-value', ?").get('private-binding-value');
   assert.doesNotMatch(JSON.stringify(readSqlActivity(buffer)),/private-source|private-binding/);
   assert.throws(()=>f.db.transaction(()=>{throw Error('fixture rollback');}).immediate());
   assert.equal(readSqlActivity(buffer).transaction.depth,1);
  }).immediate();
  assert.equal(readSqlActivity(buffer).transaction,null);
 }finally{f.close();}
});
