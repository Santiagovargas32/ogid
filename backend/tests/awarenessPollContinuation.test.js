import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {migrate} from '../storage/migrate.js';
import {CycleContinuations} from '../storage/cycleContinuations.js';
import {commitNotModifiedPage,NotModifiedCoordinator} from '../storage/awarenessPollContinuation.js';
import {SqlAwarenessStore} from '../storage/sqlAwarenessStore.js';
import {AwarenessStore} from '../services/awareness/awarenessStore.js';
import {AwarenessService} from '../services/awareness/awarenessService.js';
import {AWARENESS_SOURCES} from '../services/awareness/awarenessCatalog.js';
import {createAwarenessEvent} from '../services/awareness/awarenessParsers.js';
import {StorageManager} from '../storage/StorageManager.js';
import {PipelinePersistence} from '../storage/pipelinePersistence.js';
import {pressureError} from '../storage/resourceAdmission.js';

const source=AWARENESS_SOURCES.find(s=>s.sourceId==='awareness-bls-eci');
const at=new Date().toISOString(),later=new Date(Date.now()+3600000).toISOString();
const input={kind:'awareness-304-v1',sourceId:source.sourceId,after:'',validators:{etag:'frozen-etag',lastModified:null},poll:{attemptedAt:at,completedAt:at,outcome:'not-modified',httpStatus:304,latencyMs:4,nextEligibleAt:later},patch:{status:'healthy',successes:1,lastSuccessAt:at,nextEligibleAt:later,stale:false}};
test('a lost continuation fence is not recorded as an upstream failure',async()=>{
 const store=new AwarenessStore(),service=new AwarenessService({mode:'shadow',sources:[source],store,fetchImpl:async()=>new Response(null,{status:304})});
 store.commitNotModified=async()=>{throw Object.assign(Error('lost fence'),{code:'CONTINUATION_LEASE_LOST'});};
 try{await assert.rejects(service.pollSource(source),{code:'CONTINUATION_LEASE_LOST'});assert.equal(store.getPollHistory(source.sourceId).length,0);assert.notEqual(store.sourceStatuses.get(source.sourceId).status,'unhealthy');}
 finally{await service.stop();}
});
function fixture(count=130){
 const dir=mkdtempSync(join(tmpdir(),'ogid-poll304-')),file=join(dir,'fixture.sqlite');let db;
 const open=()=>{db=new Database(file);db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');migrate(db);};open();
 const store=new SqlAwarenessStore(db);store.registerSources([source]);
 store.reconcile(Array.from({length:count},(_,i)=>{const e=createAwarenessEvent({source,rawId:'test-'+i,title:'Employment cost '+i,canonicalUrl:source.url+'?item='+i,publishedAt:at,observedAt:at});return {...e,dataMode:'stale',provenance:{...e.provenance,stale:true}};}));
 store.updateSourceStatus(source.sourceId,{etag:'frozen-etag',nextEligibleAt:null,successes:0});
 return {file,dir,get db(){return db;},closeDb(){db.close();},reopen(){if(db.open)db.close();open();},close(){if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('real writer effect and phase rollback together on poll failure; bounded pages replay ACKs without duplicate revisions',()=>{
 const f=fixture();try{
  const ledger=new CycleContinuations(f.db);ledger.admit({jobId:'eci304',scope:'awareness:'+source.sourceId,phase:'source-fresh',input});
  const plan=f.db.prepare('EXPLAIN QUERY PLAN SELECT event_id,payload_json FROM awareness_events WHERE source_id=? AND event_id>? ORDER BY event_id LIMIT 64').all(source.sourceId,'');
  assert.ok(plan.every(row=>!row.detail.includes('TEMP B-TREE')));assert.ok(plan.some(row=>row.detail.includes('source_id=? AND event_id>?')));
  const auth=ledger.claim({jobId:'eci304',owner:'first'});let step={jobId:auth.jobId,owner:auth.owner,fence:auth.fence,cursor:0};
  const page=commitNotModifiedPage(f.db,step);assert.equal(page.cursor,1);assert.equal(page.status,'pending');
  const before=f.db.prepare('SELECT sum(revision) n FROM awareness_events').get().n;
  assert.equal(commitNotModifiedPage(f.db,step).replayed,true);assert.equal(f.db.prepare('SELECT sum(revision) n FROM awareness_events').get().n,before);
  step.cursor=1;assert.equal(commitNotModifiedPage(f.db,step).cursor,2);step.cursor=2;
  f.db.exec("CREATE TRIGGER reject_poll BEFORE INSERT ON source_polls BEGIN SELECT RAISE(ABORT,'poll failure'); END");
  assert.throws(()=>commitNotModifiedPage(f.db,step),/poll failure/);assert.equal(ledger.get(auth).cursor,2);
  assert.equal(f.db.prepare("SELECT count(*) n FROM awareness_events WHERE json_extract(payload_json,'$.provenance.stale')=1").get().n,2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_polls').get().n,0);f.db.exec('DROP TRIGGER reject_poll');
  f.reopen();const reopened=new CycleContinuations(f.db);reopened.recoverPage();const claim=reopened.claim({jobId:auth.jobId,owner:'restart'});
  assert.throws(()=>commitNotModifiedPage(f.db,step),{code:'CONTINUATION_LEASE_LOST'});
  step={jobId:claim.jobId,owner:claim.owner,fence:claim.fence,cursor:claim.cursor};assert.equal(commitNotModifiedPage(f.db,step).status,'complete');
  assert.equal(commitNotModifiedPage(f.db,step).replayed,true);assert.equal(f.db.prepare('SELECT count(*) n FROM source_polls').get().n,1);
  const status=JSON.parse(f.db.prepare('SELECT payload_json FROM awareness_source_status WHERE source_id=?').get(source.sourceId).payload_json);
  assert.equal(status.successes,1);assert.equal(status.lastSuccessAt,at);assert.equal(status.etag,'frozen-etag');
 }finally{f.close();}
});
test('Awareness runtime resumes a frozen 304 after pressure, stop, worker/DB reopen and startup without a second HTTP request',async()=>{
 const f=fixture(4);f.closeDb();let manager,service,pipeline,network=0;
 const boot=async(fetchImpl)=>{
  manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:f.file});await manager.start();
  const store=new AwarenessStore();service=new AwarenessService({mode:'shadow',sources:[source],store,fetchImpl});
  pipeline=new PipelinePersistence(manager);
  await pipeline.hydrate({awarenessStore:store,aiStore:{records:new Map(),recoverInterrupted(){},upsert(x){return x;}},aiBudget:{state:{}},marketHistoryStore:{},quotaTracker:{ensureProvider(){},providers:{}}});
  await pipeline.flush();
 };
 try{
  await boot(async(_url,options)=>{network++;assert.equal(options.headers['If-None-Match'],'frozen-etag');return new Response(null,{status:304});});
  const request=manager.request.bind(manager);let blocked=true;
  manager.request=(op,...args)=>op==='continuation.notModifiedPage'&&blocked?Promise.reject(pressureError({state:'degraded',reason:'fixture'})):request(op,...args);
  assert.equal((await service.pollSource(source)).status,'deferred');assert.equal(network,1);
  const selected=await manager.request('continuation.scope',{scope:'awareness:'+source.sourceId});assert.equal(selected.input.poll.httpStatus,304);assert.equal(selected.input.validators.etag,'frozen-etag');
  await service.stop();assert.equal(service.deferredAtShutdown[0].durable,true);await manager.close();
  await boot(async()=>{assert.fail('must not repeat HTTP for a frozen 304');});
  const result=await service.runCycle('startup-awareness');assert.equal(result.results.length,1);assert.equal(result.results[0].status,'not-modified');
  assert.equal((await manager.request('continuation.pending')).length,0);await service.stop();service=null;await manager.close();manager=null;
  f.reopen();assert.equal(f.db.prepare('SELECT count(*) n FROM source_polls').get().n,1);
  assert.equal(JSON.parse(f.db.prepare('SELECT payload_json FROM awareness_source_status WHERE source_id=?').get(source.sourceId).payload_json).successes,1);
 }finally{await service?.stop();await manager?.close();f.close();}
});
