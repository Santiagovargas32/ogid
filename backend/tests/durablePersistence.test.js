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
import {SqlAlertStore,SqlEventLedger,SqlResearchStore} from '../storage/sqlRepositories.js';
import {migrate} from '../storage/migrate.js';
import {createStorageBackup} from '../storage/backup.js';
import {buildAdvancedCorpus,buildFrequentTerms} from '../services/intel/advancedIntelligenceService.js';
import {publicProjection} from '../utils/researchProjection.js';
import {SqlRssCanonicalState} from '../storage/rssCanonicalState.js';
const config=dir=>({rootDir:dir,news:{analyzeLimit:3000,displayLimit:40},rss:{rssFeeds:[]}});
const sqlFixture=()=>{const dir=mkdtempSync(join(tmpdir(),'ogid-durable-')),db=new Database(join(dir,'db.sqlite'));db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');migrate(db);return {dir,db,close(){db.close();rmSync(dir,{recursive:true,force:true});}};};
async function fixture(){const dir=mkdtempSync(join(tmpdir(),'ogid-jobs-')),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(dir,'db.sqlite')});await manager.start();await manager.request('domain.configure',config(dir));return {dir,manager,async close(){await this.manager.close();rmSync(dir,{recursive:true,force:true});}};}
const request=(manager,countries=['RU'])=>manager.request('domain.call',{service:'advanced',method:'getSnapshot',args:[{countries}],context:{newsFromStorage:true,snapshot:{}}});
const settled=manager=>Promise.all([...manager.advancedCoordinator.tasks.values()]);

test('RSS checkpoints batch small polled-feed states within the existing page row bounds',async()=>{
 const f=sqlFixture(),runtime=new BusinessRuntime(f.db,()=>{}),state=new SqlRssCanonicalState(runtime),commits=[];
 const transaction=f.db.transaction.bind(f.db);let depth=0;
 f.db.transaction=work=>{const tx=transaction(work);return {immediate:(...args)=>{const outer=depth++===0;try{return tx.immediate(...args);}finally{depth--;if(outer)commits.push(true);}}};};
 try{
  const pipeline={states:new Map(Array.from({length:23},(_,n)=>['feed-'+n,{etag:'version-'+n,articles:[]} ])),corpus:[],metrics:{cycles:1}};
  await state.save(pipeline,[...pipeline.states.keys()]);
  assert.equal(commits.length,3,'23 small feeds plus the summary use three bounded commits');
  assert.equal(Object.keys(state.load().states).length,23);assert.equal(runtime.load('rss-canonical-v2').metrics.cycles,1);
  const largeIds=Array.from({length:3},(_,n)=>'large-'+n);
  for(const id of largeIds)pipeline.states.set(id,{etag:id,articles:[{title:'x'.repeat(80*1024)}]});
  await state.save(pipeline,largeIds);assert.equal(commits.length,6,'80 KiB feed payloads must not share a page above the 128 KiB byte bound');
 }finally{f.close();}
});

test('RSS checkpoints update only polled feeds, preserve legacy recovery and do not advance after a failed page',async()=>{
 const f=sqlFixture(),runtime=new BusinessRuntime(f.db,()=>{});
 try{
  const legacy={version:1,states:Object.fromEntries(Array.from({length:200},(_,i)=>[`feed-${i}`,{etag:`old-${i}`,articles:[{title:`Saved source ${i}`}]}])),corpus:[{title:'Retained corpus'}],metrics:{cycles:10}};
  runtime.save('rss-canonical',legacy);
  f.db.exec("CREATE TRIGGER protect_legacy_rss BEFORE UPDATE ON runtime_snapshots WHEN NEW.kind='rss-canonical' BEGIN SELECT RAISE(ABORT,'Legacy recovery must remain intact'); END");
  const state=new SqlRssCanonicalState(runtime),restored=state.load();
  const pipeline={states:new Map(Object.entries(restored.states)),corpus:restored.corpus,metrics:{cycles:11}};
  pipeline.states.set('feed-1',{etag:'new',articles:[{title:'New archived source'}]});
  await state.save(pipeline,['feed-1']);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM runtime_snapshots WHERE kind GLOB 'rss-canonical-feed:*'").get().n,1);
  const reopened=new SqlRssCanonicalState(runtime).load();assert.equal(Object.keys(reopened.states).length,200);assert.equal(reopened.states['feed-1'].etag,'new');assert.equal(reopened.states['feed-199'].etag,'old-199');assert.deepEqual(reopened.corpus,legacy.corpus);
  const checkpoint=runtime.load('rss-canonical-v2');
  f.db.exec("CREATE TRIGGER fail_feed_save BEFORE INSERT ON runtime_snapshots WHEN NEW.kind='rss-canonical-feed:feed-2' BEGIN SELECT RAISE(ABORT,'Simulated feed commit failure'); END");
  pipeline.metrics={cycles:12};await assert.rejects(state.save(pipeline,['feed-1','feed-2']),{code:'SQLITE_CONSTRAINT_TRIGGER'});
  assert.deepEqual(runtime.load('rss-canonical-v2'),checkpoint);assert.deepEqual(runtime.load('rss-canonical'),legacy);
 }finally{runtime.close();f.close();}
});

test('SQL ingestion preserves history without counting the archive for legacy retention',t=>{
 const f=sqlFixture(),archive=new SqlNewsArchive(f.db,{maxItems:1});
 try{
  const prepare=f.db.prepare.bind(f.db);
  const mock=t.mock.method(f.db,'prepare',sql=>{assert.ok(!/SELECT count\(\*\).*FROM articles/i.test(sql));return prepare(sql);});
  for(const n of [1,2])assert.equal(archive.ingest([{id:`retained-${n}`,title:`Source ${n}`,url:`https://fixture.invalid/${n}`,provider:'rss'}]).accepted,1);
  mock.mock.restore();assert.equal(archive.coverage().totalStored,2);
 }finally{archive.close();f.close();}
});

test('portfolio uses its archive window without loading an unused analytical corpus',async()=>{
 const f=sqlFixture();const runtime=new BusinessRuntime(f.db,()=>{});
 try{
  runtime.configure(config(f.dir));
  runtime.newsCorpus.readAnalytical=async()=>{throw Error('unused corpus must not be loaded');};
  const result=await runtime.call({service:'portfolio',method:'getContext',args:[{mode:'daily',instrumentIds:['us-equity-general-dynamics']}],context:{newsFromStorage:true,snapshot:{},awareness:{mode:'off',upcoming:[],recent:[]}}});
  assert.equal(result.mode,'daily');assert.equal(result.news.articles.length,0);assert.equal(result.universe[0].instrumentId,'us-equity-general-dynamics');
 }finally{runtime.close();f.close();}
});

test('event coverage counts verified and legacy identities without reading historical payload rows',()=>{
 const f=sqlFixture();try{
  const ledger=new SqlEventLedger({store:new SqlResearchStore(f.db)});
  assert.equal(ledger.search().coverage.storedEvents,0);assert.equal(ledger.search().coverage.legacyRequiresReplay,0);
  const insert=f.db.prepare('INSERT INTO events(event_id,identity_version,revision,observed_at,status,payload_json) VALUES(?,?,?,?,?,?)');
  for(const [id,identity] of [['verified','source-publication-v2'],['legacy','legacy'],['older','source-publication-v1']]){
   const event={eventId:id,identityVersion:identity,quality:{},evidence:[]};insert.run(id,identity,1,'2026-10-18T12:00:00Z','observed',JSON.stringify(event));
  }
  const coverage=ledger.search({eventIds:['verified']}).coverage;
  assert.equal(coverage.storedEvents,3);assert.equal(coverage.legacyRequiresReplay,2);
  const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT count(*),sum(identity_version!='source-publication-v2') FROM events INDEXED BY events_by_identity").all();
  assert.match(JSON.stringify(plan),/COVERING INDEX events_by_identity/);
 }finally{f.close();}
});

test('SQL coverage preserves empty, unknown and independent publication/reception bounds',()=>{
 const f=sqlFixture();let now=Date.parse('2026-10-18T12:00:00Z');const archive=new SqlNewsArchive(f.db,{now:()=>now});
 try{
  let coverage=archive.coverage();
  assert.equal(coverage.totalStored,0);assert.equal(coverage.unknownPublicationCount,0);
  for(const field of ['oldest','newest','oldestReceivedAt','newestReceivedAt'])assert.equal(coverage[field],null);
  archive.ingest([{id:'unknown',title:'Publication date unavailable',url:'https://fixture.invalid/unknown',publishedAt:null,provider:'rss'}]);
  coverage=archive.coverage();assert.equal(coverage.unknownPublicationCount,1);assert.equal(coverage.oldest,null);assert.equal(coverage.retainedSince,new Date(now).toISOString());
  now+=3600000;
  archive.ingest([{id:'earlier',title:'Earlier publication',url:'https://fixture.invalid/earlier',publishedAt:'2026-10-16T10:00:00Z',provider:'rss'},{id:'later',title:'Later publication',url:'https://fixture.invalid/later',publishedAt:'2026-10-17T11:00:00Z',provider:'rss'}]);
  coverage=archive.coverage({from:'2026-10-17T00:00:00Z'});
  assert.equal(coverage.totalStored,3);assert.equal(coverage.unknownPublicationCount,1);
  assert.equal(coverage.oldest,'2026-10-16T10:00:00.000Z');assert.equal(coverage.newest,'2026-10-17T11:00:00.000Z');
  assert.equal(coverage.oldestReceivedAt,'2026-10-18T12:00:00.000Z');assert.equal(coverage.newestReceivedAt,'2026-10-18T13:00:00.000Z');
  assert.equal(coverage.retainedSince,coverage.oldest);assert.equal(coverage.partial,false);
 }finally{archive.close();f.close();}
});

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
  const pending=snapshots.prepare({options:{countries:['RU']}}),job=snapshots.claim({jobId:pending.dispatchJobId,owner:'test-owner'});
  const result={methodology:{version:'advanced-intelligence-v3'},generatedAt:job.asOf,inputsAsOf:job.asOf,inputHash:'fixture',inputRevisions:job.revisions};
  f.db.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON analysis_latest BEGIN SELECT RAISE(ABORT,'injected disk failure'); END");
  assert.throws(()=>snapshots.publish({owner:'test-owner',fence:1,jobId:job.jobId,result}),/injected/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM analysis_runs').get().n,0);assert.equal(f.db.prepare('SELECT status FROM analysis_jobs').get().status,'running');
  f.db.exec('DROP TRIGGER fail_publish');snapshots.recover();assert.equal(f.db.prepare('SELECT status FROM analysis_jobs').get().status,'queued');const resumed=snapshots.claim({jobId:job.jobId,owner:'test-owner'});
  assert.equal(snapshots.publish({...resumed,result}).persisted,true);assert.equal(snapshots.publish({...resumed,result}).replayed,true);
  assert.throws(()=>snapshots.publish({...resumed,result:{...result,inputHash:'conflict'}}),{code:'STORAGE_IDEMPOTENCY_CONFLICT'});
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
 // Seed schema 008 directly: the current repository requires current migrations.
 try{
  const at=new Date().toISOString(),payload=JSON.stringify({id:'fixture',title:'Russia conflict fixture',countryMentions:['RU']});
  db.prepare("INSERT INTO articles VALUES('fixture','Russia conflict fixture',NULL,'https://fixture.invalid/one',?,?,?,1,'headline-only-link-out',?)").run(at,at,at,payload);
  db.prepare("INSERT INTO article_revisions VALUES('fixture',1,?,?)").run(at,payload);
  db.prepare("INSERT INTO article_countries VALUES('fixture','RU')").run();
  db.prepare("INSERT INTO article_aliases VALUES('legacy-fixture','fixture')").run();
  db.prepare("INSERT INTO sources VALUES('fixture-rss','Fixture RSS','configured','{}')").run();
  db.prepare("INSERT INTO article_sources VALUES('fixture','fixture-rss',?,'{}')").run(at);
  const tables=['articles','article_revisions','article_sources','article_aliases','article_countries'];const before=Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT * FROM ${t}`).all()]));
  const backup=join(dir,'backup.sqlite');await createStorageBackup(db.name,backup);migrate(db);
  for(const t of tables)assert.deepEqual(db.prepare(`SELECT * FROM ${t}`).all(),before[t]);
  db.prepare("INSERT INTO articles_fts(articles_fts,rank) VALUES('integrity-check',1)").run();assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const restored=new Database(backup);try{migrate(restored);for(const t of tables)assert.deepEqual(restored.prepare(`SELECT * FROM ${t}`).all(),before[t]);}finally{restored.close();}
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
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
  for(let i=0;i<3;i++){assert.ok(snapshots.claim({jobId:first.dispatchJobId,owner:'test-owner'}));snapshots.recover();}
  assert.equal(snapshots.claim({jobId:first.dispatchJobId,owner:'test-owner'}),null);const status=snapshots.prepare({});assert.equal(status.lifecycle.status,'failed');assert.equal(status.lifecycle.attempts,3);
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

test('search pagination freezes revision watermark without rescanning or persisting query rows',t=>{
 const f=sqlFixture();let now=Date.parse('2026-10-16T12:00:00Z');const archive=new SqlNewsArchive(f.db,{now:()=>now});try{
  const rows=Array.from({length:4},(_,i)=>({id:`page-${i}`,title:`Russia report ${i}`,url:`https://fixture.invalid/page-${i}`,publishedAt:new Date(now-i*3600000).toISOString(),provider:'rss'}));archive.ingest(rows);
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;
  const first=archive.search({limit:2});assert.equal(first.total,4);assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
  archive.ingest([{...rows[3],title:'Changed at the same millisecond'}]);
  const prepare=archive.reader.prepare.bind(archive.reader);
  t.mock.method(archive.reader,'prepare',sql=>{
    assert.ok(!/NOT EXISTS|ORDER BY/.test(sql),'cursor pages must use point reads of frozen revisions');
    return prepare(sql);
  });
  const second=archive.search({limit:2,cursor:first.nextCursor});assert.equal(second.total,4);assert.ok(second.articles.some(a=>a.title==='Russia report 3'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_query_snapshots').get().n,0);
 }finally{archive.close();f.close();}
});

test('archiveChangedAt cursor pages respect byte budgets and preserve frozen country matches',t=>{
 const f=sqlFixture(),now=Date.parse('2026-10-17T09:00:00Z'),archive=new SqlNewsArchive(f.db,{now:()=>now});try{
  const rows=Array.from({length:40},(_,i)=>({id:`budget-${i}`,title:`Russia report ${i} ${'detail '.repeat(80)}`,url:`https://fixture.invalid/budget-${i}`,publishedAt:new Date(now-i*1000).toISOString(),provider:'rss',countryMentions:['RU']}));
  archive.ingest(rows);
  const filters={countries:['RU'],timeField:'archiveChangedAt',from:new Date(now-1000).toISOString(),to:new Date(now+1000).toISOString()},input={...filters,limit:50,maxBytes:12000};
  let page=archive.search(input);assert.equal(page.total,40);assert.ok(page.articles.length>0&&page.articles.length<40);
  const snapshotId=page.snapshotId,revision=page.revision,expected=rows.map(row=>archive.getItem(row.id).article.id).sort();
  archive.ingest(rows.map(row=>({...row,title:'Changed report',countryMentions:['CN']})));
  const prepare=archive.reader.prepare.bind(archive.reader);
  t.mock.method(archive.reader,'prepare',sql=>{assert.ok(!/NOT EXISTS|ORDER BY/.test(sql));return prepare(sql);});
  const seen=[];
  for(let pages=0;;pages++){
   const payload={ok:true,queriedAt:new Date(now).toISOString(),origin:'OGID',data:page,warnings:page.warnings,truncated:false};
   assert.ok(Buffer.byteLength(JSON.stringify({structuredContent:payload,content:[{type:'text',text:JSON.stringify(payload)}]}))<=input.maxBytes);
   assert.ok(pages<40);assert.equal(page.snapshotId,snapshotId);assert.equal(page.revision,revision);assert.equal(page.total,40);
   for(const article of page.articles){seen.push(article.id);assert.ok(article.title.startsWith('Russia report'));assert.ok(article.matchReasons.some(reason=>reason.kind==='country'&&reason.evidence==='RU'));}
   if(!page.hasMore)break;
   page=archive.search({...input,cursor:page.nextCursor});
  }
  assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,40);assert.equal(page.nextCursor,null);
 }finally{archive.close();f.close();}
});

test('SQL query references stay bounded and evicted cursors expire',()=>{
 const f=sqlFixture(),archive=new SqlNewsArchive(f.db,{maxSnapshotItems:3});try{
  archive.ingest(Array.from({length:4},(_,i)=>({id:`bounded-${i}`,title:`Russia report ${i}`,url:`https://fixture.invalid/bounded-${i}`,provider:'rss'})));
  assert.throws(()=>archive.search({limit:1}),{code:'SNAPSHOT_TOO_LARGE',statusCode:413});assert.equal(archive.snapshots.size,0);
  const first=archive.search({q:'report 0',limit:1}),second=archive.search({q:'report 1',limit:1});
  archive.search({q:'report 2',limit:1});archive.search({q:'report 3',limit:1});
  assert.ok([...archive.snapshots.values()].reduce((sum,snapshot)=>sum+snapshot.rows.length,0)<=3);
  assert.throws(()=>archive.search({cursor:archive.cursor(first.snapshotId,0)}),{code:'CURSOR_EXPIRED'});
  assert.equal(archive.search({cursor:archive.cursor(second.snapshotId,0)}).total,1);
 }finally{archive.close();f.close();}
});
