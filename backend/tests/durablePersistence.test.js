import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,cpSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {StorageManager} from '../storage/StorageManager.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {SqlNewsCorpus} from '../storage/sqlNewsCorpus.js';
import {SqlAlertStore} from '../storage/sqlRepositories.js';
import {migrate} from '../storage/migrate.js';
import {createStorageBackup} from '../storage/backup.js';
import {buildAdvancedCorpus,buildFrequentTerms} from '../services/intel/advancedIntelligenceService.js';
import {publicProjection} from '../utils/researchProjection.js';
const config=dir=>({rootDir:dir,news:{analyzeLimit:3000,displayLimit:40},rss:{rssFeeds:[]}});
const sqlFixture=()=>{const dir=mkdtempSync(join(tmpdir(),'ogid-durable-')),db=new Database(join(dir,'db.sqlite'));db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');migrate(db);return {dir,db,close(){db.close();rmSync(dir,{recursive:true,force:true});}};};
async function fixture(){const dir=mkdtempSync(join(tmpdir(),'ogid-jobs-')),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(dir,'db.sqlite')});await manager.start();await manager.request('domain.configure',config(dir));return {dir,manager,async close(){await this.manager.close();rmSync(dir,{recursive:true,force:true});}};}
const request=(manager,countries=['RU'])=>manager.request('domain.call',{service:'advanced',method:'getSnapshot',args:[{countries}],context:{newsFromStorage:true,snapshot:{}}});
const settled=manager=>Promise.all([...manager.advancedCoordinator.tasks.values()]);

test('twenty equivalent requests share one durable job, commit once and recover after restart',async()=>{
 const f=await fixture();try{
  const values=await Promise.all(Array.from({length:20},(_,i)=>request(f.manager,i%2?['RU','US']:['US','RU'])));
  assert.ok(values.every(v=>v.lifecycle.status==='preparing'));assert.equal(new Set(values.map(v=>v.lifecycle.jobId)).size,1);
  await settled(f.manager);
  let db=new Database(f.manager.options.databasePath,{readonly:true});
  assert.equal(db.prepare('SELECT count(*) AS n FROM analysis_jobs').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM analysis_runs').get().n,1);
  assert.equal(db.prepare('SELECT attempts FROM analysis_jobs').get().attempts,1);db.close();
  const ready=await request(f.manager,['US','RU']);assert.equal(ready.lifecycle.status,'ready');assert.ok(ready.generatedAt);
  assert.equal(ready.methodology.version,'advanced-intelligence-v3');
  await f.manager.close();f.manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(f.dir,'db.sqlite')});await f.manager.start();await f.manager.request('domain.configure',config(f.dir));
  const start=performance.now(),restored=await request(f.manager,['RU','US']);assert.ok(performance.now()-start<1000);assert.equal(restored.generatedAt,ready.generatedAt);
  db=new Database(f.manager.options.databasePath,{readonly:true});assert.equal(db.prepare('SELECT count(*) AS n FROM analysis_runs').get().n,1);db.close();
 }finally{await f.close();}
});

test('a calculation exceeding 12 seconds does not block reads or cancel its shared result',async()=>{
 const f=await fixture();try{
  await request(f.manager);await settled(f.manager);const previous=await request(f.manager);
  const original=f.manager.analysisManager.localRequest.bind(f.manager.analysisManager);let calculations=0;
  // Fault injection at the dispatch boundary; calculation and commit still use real workers/SQLite.
  f.manager.analysisManager.localRequest=async(...args)=>{if(args[0]==='domain.call'&&args[1].service==='advanced'){calculations++;await new Promise(r=>setTimeout(r,12500));}return original(...args);};
  const context={newsFromStorage:true,snapshot:{countries:{RU:{score:1}}}};
  const start=performance.now();const responses=await Promise.all(Array.from({length:20},()=>f.manager.request('domain.call',{service:'advanced',method:'getSnapshot',args:[{countries:['RU']}],context})));
  assert.ok(performance.now()-start<1000);assert.ok(responses.every(v=>v.generatedAt===previous.generatedAt&&v.lifecycle.status==='refreshing'));
  await settled(f.manager);assert.equal(calculations,1);
  const value=await f.manager.request('domain.call',{service:'advanced',method:'getSnapshot',args:[{countries:['RU']}],context});assert.equal(value.lifecycle.status,'ready');assert.notEqual(value.generatedAt,previous.generatedAt);
 }finally{await f.close();}
});

test('failed result commit never publishes; completed publication is idempotent and rejects conflicting content',async()=>{
 const f=sqlFixture(),runtime=new BusinessRuntime(f.db,()=>{});try{
  runtime.configure(config(f.dir));const snapshots=runtime.advancedSnapshots;
  const pending=snapshots.prepare({options:{countries:['RU']}}),job=snapshots.claim(pending.dispatchJobId);
  const result={methodology:{version:'advanced-intelligence-v3'},generatedAt:job.asOf,inputsAsOf:job.asOf,inputHash:'fixture',inputRevisions:job.revisions};
  f.db.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON analysis_latest BEGIN SELECT RAISE(ABORT,'injected disk failure'); END");
  assert.throws(()=>snapshots.publish({jobId:job.jobId,result}),/injected/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM analysis_runs').get().n,0);assert.equal(f.db.prepare('SELECT status FROM analysis_jobs').get().status,'running');
  f.db.exec('DROP TRIGGER fail_publish');snapshots.recover();assert.equal(f.db.prepare('SELECT status FROM analysis_jobs').get().status,'queued');snapshots.claim(job.jobId);
  assert.equal(snapshots.publish({jobId:job.jobId,result}).persisted,true);assert.equal(snapshots.publish({jobId:job.jobId,result}).replayed,true);
  assert.throws(()=>snapshots.publish({jobId:job.jobId,result:{...result,inputHash:'conflict'}}),{code:'STORAGE_IDEMPOTENCY_CONFLICT'});
 }finally{runtime.close();f.close();}
});

test('SQL analytical window exceeds 6000 articles, preserves republications, excludes unknown/future and uses asOf revisions',async()=>{
 const f=sqlFixture();let now=Date.parse('2026-10-16T12:00:00Z');const archive=new SqlNewsArchive(f.db,{now:()=>now}),corpus=new SqlNewsCorpus(archive,{analyzeLimit:3,displayLimit:1});
 try{
  const rows=Array.from({length:6501},(_,i)=>({id:`fixture-${i}`,title:`Russia conflict report ${i}`,url:`https://fixture.invalid/${i}`,publishedAt:new Date(now-(i%2?30:2)*3600000).toISOString(),provider:'rss'}));
  for(let i=0;i<rows.length;i+=100)archive.ingest(rows.slice(i,i+100));
  archive.ingest([{...rows[0],id:'wire',url:'https://other.invalid/wire'},{...rows[0],id:'unknown',url:'https://fixture.invalid/unknown',publishedAt:null},{...rows[0],id:'future',url:'https://fixture.invalid/future',publishedAt:new Date(now+3600000).toISOString()}]);
  const asOf=new Date(now).toISOString();now+=3600000;archive.ingest([{...rows[0],title:'Russia revised report'}]);
  const result=await corpus.readAnalytical({asOf,windowHours:48});assert.equal(result.articles.length,6502);assert.equal(result.meta.analysisTruncated,false);assert.equal(result.meta.unknownPublicationCount,1);assert.equal(result.meta.futurePublicationCount,1);
  assert.ok(result.articles.some(a=>a.title==='Russia conflict report 0'));assert.ok(!result.articles.some(a=>a.title==='Russia revised report'));
  const active=buildAdvancedCorpus({signalCorpus:result.articles,windowHours:24,now:Date.parse(asOf)}),comparison=buildAdvancedCorpus({signalCorpus:result.articles,windowHours:48,now:Date.parse(asOf)});
  const terms=buildFrequentTerms(active.articles,{previousArticles:comparison.articles,windowHours:24,now:Date.parse(asOf)});
  assert.equal(active.articles.length,3252);assert.equal(terms.comparison.previousSampleSize,3250);assert.equal(terms.comparison.currentSampleSize,3252);
  const small=await corpus.readAnalytical({asOf,windowHours:48,maxBytes:2000});assert.equal(small.meta.analysisTruncated,true);assert.equal(small.meta.truncationReason,'analytical-input-byte-budget');assert.equal(small.meta.eligibleCount,6502);
  const plan=f.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM article_revisions WHERE article_id=? AND observed_at<=? ORDER BY observed_at DESC').all('x',asOf);assert.match(JSON.stringify(plan),/article_revisions_available/);
 }finally{archive.close();f.close();}
});

test('oversized historical change is fully reconstructable, keeps sequence and checkpoint, survives restart',()=>{
 const f=sqlFixture();try{
  let alerts=new SqlAlertStore(f.db);const snapshot={instrumentId:'fixture',status:'watch',context:{text:'á漢🙂'.repeat(12000)},evidence:Array.from({length:100},(_,i)=>({eventId:`e${i}`,revision:1}))};
  alerts.researchTransaction(s=>alerts.appendChange(s,{kind:'signal',entityId:'fixture',revision:1,snapshot,reason:'fixture'}));
  const delta=alerts.delta({consumerId:'fixture',maxBytes:4096});assert.equal(delta.changes.length,1);assert.equal(delta.changes[0].representation,'historical-reference-v1');assert.equal(alerts.research.consumers.fixture,undefined);
  const chunks=[];let offset=0,detail;do{detail=alerts.getChange({changeId:delta.changes[0].changeId,offset,maxBytes:4096});assert.equal(publicProjection(detail).chunk,detail.chunk);chunks.push(Buffer.from(detail.chunk,'base64'));offset=detail.nextOffset;}while(detail.hasMore);
  const bytes=Buffer.concat(chunks);assert.equal(createHash('sha256').update(bytes).digest('hex'),detail.sha256);assert.deepEqual(JSON.parse(bytes).snapshot,snapshot);
  alerts=new SqlAlertStore(f.db);assert.equal(alerts.research.changes.length,0);assert.equal(alerts.delta({consumerId:'fixture',maxBytes:4096}).changes[0].changeId,delta.changes[0].changeId);
  alerts.acknowledgeChanges({consumerId:'fixture',checkpointCursor:delta.checkpointCursor,expectedSequence:0});assert.equal(alerts.delta({consumerId:'fixture'}).changes.length,0);
 }finally{f.close();}
});

test('SQL alert rollback restores sequence, maps and persisted diff after injected write failure',()=>{
 const f=sqlFixture();try{
  const alerts=new SqlAlertStore(f.db);f.db.exec("CREATE TRIGGER reject_changes BEFORE INSERT ON signal_changes BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(()=>alerts.researchTransaction(s=>{s.signals.x={revision:1};alerts.appendChange(s,{kind:'signal',entityId:'x',revision:1,snapshot:{status:'watch'}});}),/injected/);
  assert.equal(alerts.research.sequence,0);assert.equal(alerts.research.signals.x,undefined);assert.equal(alerts.persisted.size,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM alert_rows').get().n,0);
  f.db.exec('DROP TRIGGER reject_changes');alerts.researchTransaction(s=>alerts.appendChange(s,{kind:'signal',entityId:'x',revision:1,snapshot:{status:'watch'}}));assert.equal(alerts.delta({}).changes[0].sequence,1);
 }finally{f.close();}
});

test('additive migration and online restore preserve article facts, revisions, provenance and FTS',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-upgrade-')),old=join(dir,'old');mkdirSync(old);
 const migrations=new URL('../storage/migrations/',import.meta.url);
 for(const name of readdirSync(migrations).filter(n=>/^00[1-8]_/.test(n)))cpSync(new URL(name,migrations),join(old,name));
 const db=new Database(join(dir,'source.sqlite'));db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');migrate(db,old);
 const archive=new SqlNewsArchive(db);try{
  archive.ingest([{id:'fixture',title:'Russia conflict fixture',url:'https://fixture.invalid/one',publishedAt:new Date().toISOString(),provider:'rss'}]);
  const tables=['articles','article_revisions','article_sources','article_aliases','article_countries'];const before=Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT * FROM ${t}`).all()]));
  const backup=join(dir,'backup.sqlite');await createStorageBackup(db.name,backup);migrate(db);
  for(const t of tables)assert.deepEqual(db.prepare(`SELECT * FROM ${t}`).all(),before[t]);
  db.prepare("INSERT INTO articles_fts(articles_fts,rank) VALUES('integrity-check',1)").run();assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const restored=new Database(backup);try{migrate(restored);for(const t of tables)assert.deepEqual(restored.prepare(`SELECT * FROM ${t}`).all(),before[t]);}finally{restored.close();}
 }finally{archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('writer ownership excludes another manager, while reader connection is physically read-only',async()=>{
 const f=await fixture(),second=new StorageManager({enabled:true,businessEnabled:true,databasePath:f.manager.options.databasePath});
 try{assert.equal(f.manager.analysisManager.getStatus().readOnlyConnection,true);await assert.rejects(second.start(),{code:'STORAGE_WRITER_ACTIVE'});assert.equal((await f.manager.request('runtime.save',{kind:'ownership-test',payload:{ok:true}})).persisted,true);}
 finally{await second.close();await f.close();}
});

test('retrying runtime and ingest writes reconciles IDs and detects a content conflict',async()=>{
 const f=await fixture();try{
  const input={service:'news',method:'ingest',args:[[{id:'once',title:'Russia test',url:'https://fixture.invalid/once',publishedAt:new Date().toISOString(),provider:'rss'}]]};
  const first=await f.manager.request('domain.call',input,{requestId:'same-news'});const again=await f.manager.request('domain.call',input,{requestId:'same-news'});assert.deepEqual(again,first);
  await assert.rejects(f.manager.request('domain.call',{...input,args:[[]]},{requestId:'same-news'}),{code:'STORAGE_IDEMPOTENCY_CONFLICT'});
  await f.manager.request('runtime.save',{kind:'fixture',payload:{v:1}},{requestId:'same-runtime'});
  await assert.rejects(f.manager.request('runtime.save',{kind:'fixture',payload:{v:2}},{requestId:'same-runtime'}),{code:'STORAGE_IDEMPOTENCY_CONFLICT'});
  const db=new Database(f.manager.options.databasePath,{readonly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM articles').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM article_revisions').get().n,1);}finally{db.close();}
 }finally{await f.close();}
});

test('real SQLITE_FULL and SQLITE_BUSY leave journal state consistent and retryable',()=>{
 const f=sqlFixture();try{
  const alerts=new SqlAlertStore(f.db),pages=f.db.pragma('page_count',{simple:true});f.db.pragma(`max_page_count=${pages}`);
  assert.throws(()=>alerts.researchTransaction(s=>alerts.appendChange(s,{kind:'large',entityId:'x',revision:1,snapshot:{text:'x'.repeat(1024*1024)}})),{code:'SQLITE_FULL'});
  assert.equal(alerts.research.sequence,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM signal_changes').get().n,0);
  f.db.pragma('max_page_count=1073741823');f.db.pragma('busy_timeout=1');const other=new Database(f.db.name);
  try{other.exec('BEGIN IMMEDIATE');assert.throws(()=>alerts.researchTransaction(s=>alerts.appendChange(s,{kind:'small',entityId:'x',revision:1,snapshot:{v:1}})),{code:'SQLITE_BUSY'});assert.equal(alerts.research.sequence,0);other.exec('ROLLBACK');}finally{other.close();}
  alerts.researchTransaction(s=>alerts.appendChange(s,{kind:'small',entityId:'x',revision:1,snapshot:{v:1}}));assert.equal(alerts.delta().changes[0].sequence,1);
 }finally{f.close();}
});

test('interrupted durable jobs stop retrying after three starts',()=>{
 const f=sqlFixture(),runtime=new BusinessRuntime(f.db,()=>{});try{
  runtime.configure(config(f.dir));const snapshots=runtime.advancedSnapshots;const first=snapshots.prepare({});
  for(let i=0;i<3;i++){assert.ok(snapshots.claim(first.dispatchJobId));snapshots.recover();}
  assert.equal(snapshots.claim(first.dispatchJobId),null);const status=snapshots.prepare({});assert.equal(status.lifecycle.status,'failed');assert.equal(status.lifecycle.attempts,3);
 }finally{runtime.close();f.close();}
});

test('cached projections retain their original input descriptor and do not persist again',async()=>{
 const f=sqlFixture(),runtime=new BusinessRuntime(f.db,()=>{});try{
  runtime.configure(config(f.dir));
  runtime.services.news.ingest([{id:'cache',title:'Russia military conflict',url:'https://fixture.invalid/cache',publishedAt:new Date(Date.now()-3600000).toISOString(),provider:'rss'}]);
  const context={newsFromStorage:true,selectedInstrumentIds:[],snapshot:{countries:{},market:{quotes:{}}}};
  const first=await runtime.call({service:'conditions',method:'getSnapshot',args:[{countries:['RU']}],context});
  const before=f.db.prepare('SELECT count(*) AS n FROM analysis_runs').get().n;
  const second=await runtime.call({service:'conditions',method:'getSnapshot',args:[{countries:['RU']}],context});
  assert.deepEqual(second.newsCoverage,first.newsCoverage);assert.equal(f.db.prepare('SELECT count(*) AS n FROM analysis_runs').get().n,before);
  const descriptor=f.db.prepare('SELECT * FROM analysis_inputs').get();assert.deepEqual(JSON.parse(descriptor.parameters_json),[{countries:['RU']}]);assert.equal(JSON.parse(descriptor.manifest_json).coverage.revision,first.newsCoverage.revision);
  await runtime.call({service:'news',method:'getProjection',args:[{}],context});
  const changes=f.db.prepare('SELECT total_changes() AS n').get().n;
  await runtime.call({service:'news',method:'getProjection',args:[{}],context});
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,changes);
 }finally{runtime.close();f.close();}
});

test('search pagination freezes revision watermark without persisting query rows',()=>{
 const f=sqlFixture();let now=Date.parse('2026-10-16T12:00:00Z');const archive=new SqlNewsArchive(f.db,{now:()=>now});try{
  const rows=Array.from({length:4},(_,i)=>({id:`page-${i}`,title:`Russia report ${i}`,url:`https://fixture.invalid/page-${i}`,publishedAt:new Date(now-i*3600000).toISOString(),provider:'rss'}));archive.ingest(rows);
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;
  const first=archive.search({limit:2});assert.equal(first.total,4);assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
  archive.ingest([{...rows[3],title:'Changed at the same millisecond'}]);
  const second=archive.search({limit:2,cursor:first.nextCursor});assert.equal(second.total,4);assert.ok(second.articles.some(a=>a.title==='Russia report 3'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_query_snapshots').get().n,0);
 }finally{archive.close();f.close();}
});
