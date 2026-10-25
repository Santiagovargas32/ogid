import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {EventEmitter} from 'node:events';
import {mkdtempSync,readdirSync,copyFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../storage/migrate.js';
import {CommitActivity,createCommitBuffer,readCommits,acknowledgeCommits} from '../storage/commitActivity.js';
import {SqlActivity,createSqlActivityBuffer,trackTransactions} from '../storage/sqlActivity.js';
import {cacheStatements} from '../storage/statementCache.js';
import {WalCheckpoint} from '../storage/walCheckpoint.js';
import {CandleWriteJobs,CandleWriteCoordinator} from '../storage/candleWriteJobs.js';
import {StorageManager} from '../storage/StorageManager.js';
import {assertStorageVolume} from '../storage/volumeGuard.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {OpenCodeClient} from '../services/agent/opencodeClient.js';
import {transportCause} from '../services/shared/transportCause.js';
import {AdvancedSnapshots} from '../storage/advancedSnapshots.js';
import {generationFor} from '../services/agent/generation.js';
import {toolReceipt} from '../services/agent/toolReceipt.js';
import {healthDiagnostics} from '../services/healthDiagnostics.js';
import {PipelineMonitor} from '../services/pipelineMonitor.js';

test('022 preserves 001-021 checksums and rolls back all DDL on failure',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-022-')),db=new Database(':memory:');
  try{
    const source=new URL('../storage/migrations/',import.meta.url);
    for(const name of readdirSync(source).filter(n=>/^0(0\d|1\d|2[01])_/.test(n)))copyFileSync(new URL(name,source),join(dir,name));
    migrate(db,dir);const before=db.prepare('SELECT * FROM schema_migrations').all();assert.equal(before.length,21);
    const name='022_runtime_recovery.sql';copyFileSync(new URL(name,source),join(dir,name));appendFileSync(join(dir,name),'\nINVALID SQL;');
    assert.throws(()=>migrate(db,dir));assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(),before);
    assert.ok(!db.pragma('table_info(analysis_jobs)').some(c=>c.name==='owner'));
    copyFileSync(new URL(name,source),join(dir,name));migrate(db,dir);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=21').all(),before);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('commit generation includes autocommit and outer commits, excludes rollbacks and savepoints',()=>{
  const db=new Database(':memory:'),buffer=createCommitBuffer(),activity=new SqlActivity(createSqlActivityBuffer());activity.commits=new CommitActivity(buffer);
  try{
    db.exec('CREATE TABLE probe(id PRIMARY KEY)');cacheStatements(db,32,{activity});trackTransactions(db,activity);
    const put=db.prepare('INSERT INTO probe VALUES(?)');put.run('auto');assert.equal(readCommits(buffer).generation,1);
    db.transaction(()=>{put.run('outer');db.transaction(()=>put.run('inner'))();})();assert.equal(readCommits(buffer).generation,2);
    assert.throws(()=>db.transaction(()=>{put.run('rolled');throw Error('rollback');})());assert.equal(readCommits(buffer).generation,2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM probe').get().n,3);
  }finally{db.close();}
});
test('retained WAL has no periodic checkpoint without commits; reused WAL commits are detected',async()=>{
  const buffer=createCommitBuffer();let calls=0;
  class Fake extends EventEmitter{constructor(){super();queueMicrotask(()=>this.emit('message',{type:'ready',queryOnly:true,synchronous:2,pageSize:4096}));}postMessage(m){calls++;queueMicrotask(()=>this.emit('message',{id:m.id,result:[{busy:0,log:200,checkpointed:200}],durationMs:1}));}async terminate(){}}
  const cp=new WalCheckpoint({startupTimeoutMs:1000,checkpointTimeoutMs:1000,checkpointSoftBytes:4194304,checkpointHardBytes:134217728},{commitBuffer:buffer,workerFactory:()=>new Fake()});
  try{
    await cp.start();cp.walBytes=16*1024*1024;await cp.request();
    for(let n=0;n<10;n++){cp.nextEligibleAt=0;cp.observe(cp.walBytes);}assert.equal(calls,1);
    new CommitActivity(buffer).committed(4096);cp.observe(cp.walBytes);cp.dirtySince=Date.now()-5001;cp.nextEligibleAt=0;cp.observe(cp.walBytes);await cp.pending.task;
    assert.equal(calls,2);assert.equal(cp.confirmedGeneration,1);assert.equal(cp.status().backpressure,false);
  }finally{await cp.close();}
});
test('a continuous trickle cannot postpone the five-second checkpoint clock',t=>{
 const buffer=createCommitBuffer(),commits=new CommitActivity(buffer);let now=1000;t.mock.method(Date,'now',()=>now);
 commits.committed(4096);now=4000;commits.committed(4096);assert.equal(readCommits(buffer).at,1000);
 acknowledgeCommits(buffer,2);now=6000;commits.committed(4096);assert.equal(readCommits(buffer).at,6000);
});
test('durable candle pages and progress commit together and resume idempotently',()=>{
  const db=new Database(':memory:');migrate(db);db.exec('CREATE TABLE probe(id PRIMARY KEY)');let fail=false;
  const runtime={db,services:{candles:{upsert(rows){for(const r of rows)db.prepare('INSERT OR IGNORE INTO probe VALUES(?)').run(r.id);if(fail)throw Error('injected');return {inserted:rows.length};}}}};
  try{
    let jobs=new CandleWriteJobs(runtime);const candles=Array.from({length:25},(_,id)=>({id})),receipt=jobs.admit({candles});
    assert.equal(jobs.admit({candles}).jobId,receipt.jobId);assert.equal(jobs.page(receipt).completedItems,10);
    fail=true;assert.throws(()=>jobs.page(receipt));assert.equal(jobs.status(receipt).completedItems,10);assert.equal(db.prepare('SELECT count(*) AS n FROM probe').get().n,10);
    fail=false;jobs=new CandleWriteJobs(runtime);assert.equal(jobs.pending().length,1);jobs.page(receipt);assert.equal(jobs.page(receipt).committed,true);jobs.page(receipt);
    assert.equal(db.prepare('SELECT count(*) AS n FROM probe').get().n,25);assert.equal(jobs.status(receipt).inserted,25);
  }finally{db.close();}
});
test('coordinator recovers more than one durable page and reconciles a lost commit ACK',async()=>{
 const db=new Database(':memory:');migrate(db);db.exec('CREATE TABLE probe(id PRIMARY KEY)');let loseAck=true;
 const jobs=new CandleWriteJobs({db,services:{candles:{upsert(rows){let inserted=0;for(const r of rows)inserted+=db.prepare('INSERT OR IGNORE INTO probe VALUES(?)').run(r.id).changes;return {inserted,duplicates:rows.length-inserted};}}}});
 const coordinator=new CandleWriteCoordinator({localRequest:async(op,args)=>{const result=jobs[op.split('.').at(-1)](args);if(op.endsWith('.page')&&loseAck){loseAck=false;throw Object.assign(Error('lost ACK'),{code:'STORAGE_DISPATCH_TIMEOUT'});}return result;}});
 try{
  const receipts=Array.from({length:130},(_,id)=>jobs.admit({candles:[{id}]}));
  await coordinator.recover();await coordinator.recovery;assert.equal(jobs.pending().length,0);assert.equal(db.prepare('SELECT count(*) AS n FROM probe').get().n,130);
  assert.equal((await coordinator.wait({jobIds:receipts.map(r=>r.jobId)})).committed,true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM probe').get().n,130);assert.equal(coordinator.lastError,null);
 }finally{await coordinator.close();db.close();}
});
test('real worker restart preserves admission and commits candles before acknowledging completion',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-candle-restart-')),file=join(dir,'db.sqlite');let manager;
 const configure={rootDir:dir,news:{providers:[],rssFeeds:[]},rss:{rssFeeds:[]}};
 const candle={instrumentId:'crypto-bitcoin-us-dollar',interval:'5min',openTime:'2026-10-23T12:00:00.000Z',closeTime:'2026-10-23T12:05:00.000Z',open:100,high:102,low:99,close:101,volume:10,source:'yahoo',currency:'USD',adjusted:true,dataMode:'observed',quality:'valid',fetchedAt:'2026-10-23T12:20:00.000Z'};
 try{
  manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});await manager.start();await manager.request('domain.configure',configure);
  const receipt=await manager.localRequest('market.persist.admit',{candles:[candle]});
  assert.equal((await manager.localRequest('market.persist.status',receipt)).committed,false);await manager.close();
  manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});await manager.start();await manager.request('domain.configure',configure);
  const ack=await manager.marketWrites.wait({jobIds:[receipt.jobId]});assert.equal(ack.committed,true);
  const db=new Database(file,{readonly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM candles').get().n,1);assert.equal(db.prepare("SELECT status FROM acquisition_jobs WHERE job_id=?").get(receipt.jobId).status,'complete');}finally{db.close();}
 }finally{await manager?.close();rmSync(dir,{recursive:true,force:true});}
});
test('new fence or snapshot creates another generation while a lost ACK retains its identity',()=>{
  const j={jobId:'job',fence:2,model:'model',task:'instrument_outlook'},s={snapshotId:'snapshot'};
  const a=generationFor(j,s,{input:1});assert.deepEqual(generationFor(j,s,{input:1}),a);
  assert.notEqual(generationFor({...j,fence:3},s,{input:1}).messageId,a.messageId);
  assert.notEqual(generationFor(j,{snapshotId:'new'},{input:1}).sessionId,a.sessionId);
  const chat=generationFor({...j,task:'contextual_chat',opencodeId:'chat'},s,{});assert.equal(chat.sessionId,'chat');
});
test('evidence receipt requires application success and content, not transport completed',()=>{
  assert.equal(toolReceipt({isError:true,content:[]}).applicationOk,false);
  assert.equal(toolReceipt({ok:false,error:{code:'INVALID_ARGUMENTS'}}).applicationOk,false);
  assert.equal(toolReceipt('ordinary tool text'),null);
  const failed=toolReceipt({isError:true,structuredContent:{ok:false,error:{code:'INVALID_ARGUMENTS',details:{stage:'operation-parameters',issues:[{path:['evidenceId'],code:'invalid_type',expected:'string'}]}}}});
  assert.equal(failed.applicationCode,'INVALID_ARGUMENTS');assert.equal(failed.validation.issues[0].expected,'string');
  const r=toolReceipt({content:[{type:'text',text:JSON.stringify({ok:true,origin:'OGID',readReceipt:{contractHash:'a'.repeat(64),snapshotId:'s',contentRead:true,evidenceIds:['e']}})}]});
  assert.equal(r.applicationOk,true);assert.equal(r.returnedSnapshotId,'s');assert.equal(r.contentRead,true);
});
test('idle without a current assistant is explicit and historical idle cannot finish a new turn',async()=>{
 let idle=100;
 const client=new OpenCodeClient({password:'fixture',fetchImpl:async url=>Response.json(new URL(url).pathname.endsWith('/message')?{data:[{id:'current',type:'user',time:{created:200}}]}:{data:{time:{idle},outcome:'interrupted'}})});
 assert.equal((await client.progress('session',undefined,'current')).inactive,false);idle=400;
 const result=await client.progress('session',undefined,'current');assert.equal(result.inactive,true);assert.equal(result.messageId,undefined);
});
test('an unavailable configured operational image cannot become a new empty database',()=>{
 for(const file of ['/home/fedora/.local/share/ogid/db/ogid.sqlite','/srv/bitcoin/ogid/db/ogid.sqlite'])assert.throws(()=>assertStorageVolume(file,{mountpoint:()=>{},access:()=>{},exists:()=>false}),{code:'STORAGE_DATABASE_MISSING'});
});
test('provider causes distinguish HTTP, DNS, TLS and unknown without reflecting bodies',()=>{
 for(const [error,category] of [[{httpStatus:429,message:'PRIVATE'},'http'],[{cause:{code:'ENOTFOUND'}},'dns'],[{cause:{code:'CERT_HAS_EXPIRED'}},'tls'],[{message:'source timeout without transport evidence'},'unknown']]){const value=transportCause(error);assert.equal(value.category,category);assert.ok(!JSON.stringify(value).includes('PRIVATE'));}
});
test('unchanged classification retains links while provenance and checked time advance',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-semantic-links-')),db=new Database(join(dir,'db.sqlite'));migrate(db);let now=Date.now();const archive=new SqlNewsArchive(db,{now:()=>now});
 const raw={id:'same',title:'General Dynamics earnings report',provider:'rss',url:'https://fixture.invalid/report',publishedAt:new Date(now-1000).toISOString(),sourceId:'source-a',publisher:'Publisher A'};
 try{
  archive.ingest([raw]);const first=archive.search().articles[0];
  db.exec("CREATE TRIGGER unchanged_links BEFORE DELETE ON article_instruments BEGIN SELECT RAISE(ABORT,'unnecessary link regeneration'); END");
  now+=60000;archive.ingest([{...raw,receivedAt:new Date(now).toISOString(),provenance:{fetchedAt:new Date(now).toISOString()}}]);
  assert.equal(archive.search().articles[0].revision,first.revision);
  assert.equal(db.prepare('SELECT observed_at FROM article_sources WHERE source_id=?').get('source-a').observed_at,new Date(now).toISOString());
  archive.ingest([{...raw,sourceId:'source-b',publisher:'Publisher B'}]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM article_sources').get().n,2);assert.equal(archive.search().articles[0].revision,first.revision+1);
  assert.throws(()=>archive.ingest([{...raw,title:'NVIDIA earnings changed'}]),/unnecessary link regeneration/);
 }finally{archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
test('data quality remains degraded during running and a 30-minute timer is not late at minute 11',()=>{
  const monitor=new PipelineMonitor();monitor.update('news',{status:'degraded',reason:'data-stale'});monitor.update('news',{status:'running',reason:null});
  monitor.update('market',{status:'completed',lastSuccessAt:new Date(Date.now()-11*60000).toISOString()});monitor.schedule('market',{nextRunAt:new Date(Date.now()+19*60000).toISOString(),intervalMs:1800000});
  assert.equal(monitor.snapshot().market.status,'completed');
  const d=healthDiagnostics({pipelineMonitor:monitor,runtimeMetrics:{ready:true},storageManager:{getStatus:()=>({state:'ready'})}});
  assert.equal(d.operational.status,'ok');assert.equal(d.quality.status,'degraded');
});
test('Advanced status is pure and old owner/fence cannot publish after recovery',()=>{
  const db=new Database(':memory:');migrate(db);let now=Date.now();const snapshots=new AdvancedSnapshots({db},{now:()=>now});
  try{
    const r=snapshots.prepare({});const first=snapshots.claim({jobId:r.dispatchJobId,owner:'first'});
    assert.equal(snapshots.status(first.jobId).lifecycle.jobStatus,'running');
    assert.equal(db.prepare('SELECT count(*) AS n FROM analysis_jobs').get().n,1);
    snapshots.recover();const second=snapshots.claim({jobId:first.jobId,owner:'second'});assert.equal(second.fence,first.fence+1);
    assert.throws(()=>snapshots.publish({...first,result:{}}),{code:'ANALYSIS_LEASE_LOST'});
    now+=90001;assert.throws(()=>snapshots.renew(second),{code:'ANALYSIS_LEASE_LOST'});
    assert.equal(snapshots.recoverExpired(),1);assert.equal(snapshots.status(first.jobId).lifecycle.jobStatus,'queued');
    const third=snapshots.claim({jobId:first.jobId,owner:'third'});assert.equal(third.fence,second.fence+1);assert.equal(snapshots.recoverExpired(),0);
  }finally{db.close();}
});
