import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {StorageManager} from '../storage/StorageManager.js';
import {PipelinePersistence} from '../storage/pipelinePersistence.js';
import {SqlAwarenessStore} from '../storage/sqlAwarenessStore.js';
import {AwarenessService} from '../services/awareness/awarenessService.js';
import {AwarenessStore} from '../services/awareness/awarenessStore.js';
import {AWARENESS_SOURCES} from '../services/awareness/awarenessCatalog.js';
import {pressureError} from '../storage/resourceAdmission.js';
import {reservePoll,stagePoll,commitPollPage} from '../storage/awarenessAdmission.js';
import {CycleContinuations} from '../storage/cycleContinuations.js';

const empsit=AWARENESS_SOURCES.find(s=>s.sourceId==='awareness-bls-empsit');
const usgs=AWARENESS_SOURCES.find(s=>s.sourceId==='awareness-usgs-significant');
const pressure=()=>pressureError({state:'degraded',reason:'fixture'});
for (const source of [empsit,usgs]) test(source.sourceId+' retains admission without HTTP, resumes once and confirms across worker restart', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-poll-admit-')),file=join(dir,'fixture.sqlite');
  const seed=new Database(file);
  migrate(seed);const sql=new SqlAwarenessStore(seed);sql.registerSources([source]);
  sql.updateSourceStatus(source.sourceId,{admissionState:source.admissionState || 'active',etag:'turn-validator'});seed.close();
  let manager,service,store,calls=0,blocked=true;
  const boot=async()=>{
    manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});await manager.start();
    store=new AwarenessStore();service=new AwarenessService({mode:'shadow',sources:[source],store,fetchImpl:async (_url,opts)=>{
      calls++;assert.equal(opts.headers['If-None-Match'],'turn-validator');
      return source===empsit?new Response(null,{status:304}):new Response('{"type":"FeatureCollection","features":[]}',{headers:{'Content-Type':'application/json','etag':'next'}});
    }});
    service.admission={assert(){if(blocked)throw pressure();},status(){return {state:blocked?'degraded':'normal'};}};
    const pipeline=new PipelinePersistence(manager);
    await pipeline.hydrate({awarenessStore:store,aiStore:{records:new Map(),recoverInterrupted(){},upsert(x){return x;}},
      aiBudget:{state:{}},marketHistoryStore:{},quotaTracker:{ensureProvider(){},providers:{}}});
    await pipeline.flush();
  };
  try {
    await boot();
    const initial=await service.runCycle('scheduled-awareness');assert.equal(initial.status,'deferred');assert.equal(calls,0);
    const scope={scope:'awareness:'+source.sourceId};
    const pending=await manager.request('continuation.scope',scope);
    assert.equal(pending.phase,'admission');assert.equal(pending.input.validators.etag,'turn-validator');
    assert.equal(store.getPollHistory(source.sourceId).length,0);
    await service.stop();assert.equal(service.deferredAtShutdown[0].durable,true);await manager.close();
    blocked=false;await boot();
    const request=manager.request.bind(manager);
    manager.request=(op,...args)=>(op==='continuation.pollPage'||op==='continuation.notModifiedPage')?Promise.reject(pressure()):request(op,...args);
    const recovered=await Promise.all([service.pollSource(source),service.pollSource(source)]);
    assert.ok(recovered.every(x=>x.status==='deferred'));assert.equal(calls,1);
    assert.equal((await request('continuation.scope',scope)).phase,source===empsit?'source-fresh':'poll-confirm');
    await service.stop();await manager.close();
    await boot();
    const final=await service.runCycle('startup-awareness');
    assert.equal(final.results[0].status,source===empsit?'not-modified':'empty-valid');
    assert.equal(calls,1);assert.equal(await manager.request('continuation.scope',scope),null);
    assert.equal(store.getPollHistory(source.sourceId).length,1);
    assert.equal(store.sourceStatuses.get(source.sourceId).attempts,1);
    assert.ok(Date.parse(store.sourceStatuses.get(source.sourceId).nextEligibleAt)>Date.now());
  } finally {await service?.stop();await manager?.close();rmSync(dir,{recursive:true,force:true});}
});

test('poll confirmation failure leaves staged result and cursor intact; stale fences and lost ACK cannot double count',()=>{
  const db=new Database(':memory:');try{
    migrate(db);
    const ledger=new CycleContinuations(db);
    const at=new Date().toISOString(),sourceId=usgs.sourceId;
    const job=reservePoll(db,{selection:{sourceId,basis:{},catalogHash:'fixture',validators:{},selectedAt:at}});
    const owner=ledger.claim({jobId:job.jobId,owner:'worker'});
    const auth={jobId:job.jobId,owner:owner.owner,fence:owner.fence};
    ledger.advance({...auth,cursor:0,phase:'request-authorized',transitionId:'request-0',input:{...job.input,attemptedAt:at,baseAttempts:0,attempts:1}});
    const event={eventId:'earthquake',title:'Test earthquake',source:usgs,status:'released',observedAt:at};
    stagePoll(db,{auth:{...auth,cursor:1},poll:{attemptedAt:at,completedAt:at,outcome:'ok',httpStatus:200},patch:{},events:[event]});
    db.exec("CREATE TRIGGER reject_poll BEFORE INSERT ON source_polls BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
    assert.throws(()=>commitPollPage(db,{...auth,cursor:2}),/fixture rollback/);
    assert.equal(ledger.get(auth).cursor,2);assert.equal(db.prepare('SELECT count(*) FROM awareness_events').pluck().get(),0);
    assert.equal(db.prepare('SELECT count(*) FROM awareness_poll_inputs').pluck().get(),1);
    db.exec('DROP TRIGGER reject_poll');ledger.recoverPage();const second=ledger.claim({jobId:job.jobId,owner:'restart'});
    assert.throws(()=>commitPollPage(db,{...auth,cursor:2}),{code:'CONTINUATION_LEASE_LOST'});
    const step={jobId:job.jobId,owner:second.owner,fence:second.fence,cursor:2};
    assert.equal(commitPollPage(db,step).status,'complete');assert.equal(commitPollPage(db,step).replayed,true);
    assert.equal(db.prepare('SELECT count(*) FROM source_polls').pluck().get(),1);
  }finally{db.close();}
});

test('dispatch rechecks validators, a block, pressure and uncertain authorization before a later real poll',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-admission-race-')),file=join(dir,'fixture.sqlite');
  const seed=new Database(file);
  migrate(seed);const sql=new SqlAwarenessStore(seed);sql.registerSources([empsit]);
  sql.updateSourceStatus(empsit.sourceId,{admissionState:'active',etag:'old'});seed.close();
  const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});
  const store=new AwarenessStore();
  let now=Date.now(),calls=0,inject='validators',pressured=false;
  const service=new AwarenessService({mode:'shadow',sources:[empsit],store,now:()=>now,fetchImpl:async (_url,{headers})=>{
    calls++;assert.equal(headers['If-None-Match'],'new');return new Response(null,{status:304});
  }});
  service.admission={assert(){if(pressured)throw pressure();},status(){return {state:pressured?'degraded':'normal'};}};
  const pipeline=new PipelinePersistence(manager);
  try {
    await manager.start();
    await pipeline.hydrate({awarenessStore:store,aiStore:{records:new Map(),recoverInterrupted(){},upsert(x){return x;}},
      aiBudget:{state:{}},marketHistoryStore:{},quotaTracker:{ensureProvider(){},providers:{}}});
    const request=manager.request.bind(manager);
    manager.request=async(op,input,...args)=>{
      const result=await request(op,input,...args);
      if(op==='continuation.advance' && input.phase==='request-authorized'){
        if(inject==='validators')store.updateSourceStatus(empsit.sourceId,{etag:'new'});
        if(inject==='block')store.updateSourceStatus(empsit.sourceId,{runtimeBlocked:true});
        if(inject==='pressure')pressured=true;
        if(inject==='unknown')throw Object.assign(Error('injected ACK loss'),{code:'STORAGE_OUTCOME_UNKNOWN'});
      }
      return result;
    };
    assert.equal((await service.pollSource(empsit)).reason,'validators-changed');
    inject='block';assert.equal((await service.pollSource(empsit)).reason,'source-ineligible');
    now++;store.updateSourceStatus(empsit.sourceId,{runtimeBlocked:false});
    inject='pressure';assert.equal((await service.pollSource(empsit)).status,'deferred');
    assert.equal(calls,0);
    const active=await request('continuation.scope',{scope:'awareness:'+empsit.sourceId});
    assert.equal(active.phase,'admission');assert.equal(active.input.attempts,0);
    pressured=false;inject='unknown';
    await assert.rejects(service.pollSource(empsit),{code:'STORAGE_OUTCOME_UNKNOWN'});
    assert.equal((await service.pollSource(empsit)).status,'pending');assert.equal(calls,0);
    inject=null;now+=3600000;
    assert.equal((await service.pollSource(empsit)).status,'not-modified');assert.equal(calls,1);
    const final=await request('continuation.get',{jobId:active.jobId});assert.equal(final.input.unknownAttempts,1);
    assert.equal(store.getPollHistory(empsit.sourceId).length,1);
  }finally{await service.stop();await manager.close();rmSync(dir,{recursive:true,force:true});}
});
