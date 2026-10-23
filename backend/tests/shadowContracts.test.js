import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {AgentRepository} from '../storage/agentRepository.js';
import {publicationExample,validatePublicationForJob,parsePublication,assertPublication} from '../services/agent/contracts.js';
import {numericPaths} from '../services/agent/evidencePaths.js';
import {PipelineMonitor} from '../services/pipelineMonitor.js';
import {recordContinuity} from '../scripts/agent-shadow-observe.js';
import {ReadCoordinator} from '../../frontend/js/readCoordinator.js';
import {StateSync} from '../websocket/stateSync.js';
import {StateSynchronizer} from '../../frontend/js/stateSync.js';
import {summarizeProposals} from '../services/agent/proposalMetrics.js';
import {IntelligenceWorker} from '../services/agent/worker.js';
import {RuntimeMetrics} from '../services/runtimeMetrics.js';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

function repository(t){
  const directory=mkdtempSync(join(tmpdir(),'ogid-shadow-contract-')),db=new Database(join(directory,'test.sqlite'));db.pragma('journal_mode=WAL');migrate(db);let clock=Date.now();
  const runtime=new BusinessRuntime(db,()=>{});runtime.configure({rootDir:directory,news:{},rss:{rssFeeds:[]}});
  const repo=new AgentRepository(runtime,{now:()=>clock,debounceMs:0});
  repo.enqueue({task:'global_intelligence_brief',model:'llamacpp/fixture',key:'fixture'});
  const auth={...repo.claim({owner:'owner'}),owner:'owner'};
  t.after(()=>{runtime.close();db.close();rmSync(directory,{recursive:true,force:true});});
  return {db,repo,auth,advance:ms=>{clock+=ms;}};
}
test('task examples satisfy the exact contracts and foreign fields/directional omissions fail',()=>{
  for(const task of ['global_intelligence_brief','geopolitical_alert_assessment','market_outlook_global','instrument_outlook']){
    const job={task,scope:'fixture'},value=publicationExample(job,'coverage:fixture');
    assert.equal(validatePublicationForJob(value,job),true,task);
    if(task!=='geopolitical_alert_assessment')assert.equal(validatePublicationForJob({...value,alertAssessments:[{alertId:'a',revision:1,summary:'a',evidenceIds:['coverage:fixture']}]},job),false);
    if(task.includes('outlook'))assert.equal(validatePublicationForJob({...value,direction:'up'},job),false);
  }
});
test('strict publication parser rejects concatenated objects, exterior text and trailing garbage',()=>{
  assert.deepEqual(parsePublication('```json\n{"a":1}\n```'),{a:1});
  for(const text of ['{}{}','prefix {}','{} suffix','```json\n{}\n``` trailing'])assert.throws(()=>parsePublication(text),SyntaxError);
});
test('all numeric problems are returned from the same frozen evidence with exact paths and bounded catalogs',()=>{
  const at=new Date().toISOString(),job={task:'global_intelligence_brief'};
  const data={indicators:{sma:{value:337.60950164794923},rsi:{value:57.3}}};
  const value={...publicationExample(job,'technical:fixture'),technicalFacts:[{evidenceId:'technical:fixture',path:'indicators.sma',value:337.60950164794923},{evidenceId:'technical:fixture',path:'indicators.rsi.value',value:57}]};
  const context={job,snapshot:{asOf:at},lookup:()=>({availableAt:at,quality:{},data})};
  assert.throws(()=>assertPublication(value,context),error=>error.details.problems.length===2 && error.details.suggestedPath==='indicators.sma.value');
  value.technicalFacts[0].path='indicators.sma.value';value.technicalFacts[1].value=57.3;assertPublication(value,context);
  const catalog=numericPaths(data,{maxPaths:1});assert.equal(catalog.paths.length,1);assert.equal(catalog.truncated,true);
  assert.equal(catalog.paths[0].value,337.60950164794923);
});
test('renewal replay never extends the lease and rejects reuse with different intent',t=>{
  const f=repository(t),input={...f.auth,renewalId:'renewal-one'};
  const first=f.repo.heartbeat(input);f.advance(2000);
  const replay=f.repo.heartbeat(input);assert.equal(replay.leaseUntil,first.leaseUntil);assert.equal(replay.replayed,true);
  assert.throws(()=>f.repo.heartbeat({...input,progress:{phase:'repair'}}),{code:'AGENT_IDEMPOTENCY_CONFLICT'});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM storage_commands').get().n,1);
});
test('a heartbeat after durable publication acknowledges only the same completed owner and fence',t=>{
  const f=repository(t),snapshot=f.repo.snapshot(f.auth),item=f.repo.evidence({snapshotId:snapshot.snapshotId}).items[0];
  const proposal=publicationExample({task:f.auth.task},item.evidenceId);
  const published=f.repo.publish({...f.auth,proposal,mode:'shadow'});f.advance(100000);
  assert.deepEqual(f.repo.heartbeat(f.auth),{renewed:false,closed:true,status:'completed'});
  assert.throws(()=>f.repo.heartbeat({...f.auth,owner:'other'}),{code:'AGENT_LEASE_LOST'});
  assert.throws(()=>f.repo.publish({...f.auth,owner:'other',proposal,mode:'shadow'}),{code:'AGENT_LEASE_LOST'});
  assert.equal(f.repo.publish({...f.auth,proposal,mode:'shadow'}).publicationId,published.publicationId);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_publications').get().n,1);
});
test('one-shot storage does not expire while a periodic stage still becomes stale',()=>{
  const monitor=new PipelineMonitor(),lastSuccessAt=new Date(Date.now()-601000).toISOString();
  monitor.update('storage',{status:'completed',lastSuccessAt});monitor.update('periodic',{status:'completed',lastSuccessAt});
  assert.equal(monitor.snapshot().storage.status,'completed');assert.equal(monitor.snapshot().periodic.status,'stale');
});
test('elapsed observation can complete while continuity explicitly records outage, restart and gaps',()=>{
  const summary={completedObservation:true};const sample={at:'2026-10-21T18:00:00Z',pid:1,startedAt:'2026-10-21T17:00:00Z',build:'a',http:{health:200,ready:200,agent:200}};
  recordContinuity(summary,sample);recordContinuity(summary,{...sample,at:'2026-10-21T18:02:00Z',http:{health:null,ready:null,agent:null}},{gapMs:120000});
  recordContinuity(summary,{...sample,pid:2,at:'2026-10-21T18:03:00Z'});
  assert.equal(summary.continuousBackendObservation,false);assert.equal(summary.completedObservation,true);assert.equal(summary.backendChanges,1);assert.equal(summary.telemetryGaps,1);assert.equal(summary.segments.length,3);
});
test('readiness degradation is separate from continuous observation of the same live backend',()=>{
  const summary={},sample={at:'2026-10-21T18:00:00Z',pid:1,startedAt:'2026-10-21T17:00:00Z',build:'a',http:{health:200,ready:503,agent:401}};
  recordContinuity(summary,sample);
  assert.equal(summary.continuousBackendObservation,true);assert.equal(summary.segments[0].available,false);assert.equal(summary.segments[0].backendObserved,true);
});
test('independent consumers share a read and one abort cannot cancel another consumer',async()=>{
  const coordinator=new ReadCoordinator();let release,calls=0,sharedSignal;
  const task=signal=>{calls++;sharedSignal=signal;return new Promise(resolve=>{release=resolve;});};
  const controller=new AbortController();const first=coordinator.read('same',task,{signal:controller.signal});const second=coordinator.read('same',task);
  await Promise.resolve();controller.abort();await assert.rejects(first);assert.equal(sharedSignal.aborted,false);release(42);assert.equal(await second,42);assert.equal(calls,1);
});
test('announced unread revisions and Unicode pages retain exact bytes within the final HTTP budget',()=>{
  const state={news:[{text:'🌎\"\\\n'.repeat(20000)}]},sync=new StateSync({getSnapshot:()=>state});
  const manifest=sync.manifest(),original=structuredClone(state.news);state.news=[];sync.change(['news']);
  let cursor=0,fragments=[];
  do{const result=sync.page({resource:'news',epoch:manifest.epoch,revision:manifest.resources.news,cursor});assert.equal(result.status,200);assert.ok(Buffer.byteLength(JSON.stringify({ok:true,data:result.data}))<=65536);fragments.push(result.data.fragment);cursor=result.data.nextCursor;}while(cursor!==null);
  assert.deepEqual(JSON.parse(fragments.join('')),original);
});
test('a valid conflict manifest is used without a second manifest GET and complete resources survive',async()=>{
  let manifests=0,conflicted=false;const updates=[];
  const manifest={protocol:2,epoch:'epoch',revision:2,resources:{news:1,meta:2}};
  const client=new StateSynchronizer({onUpdate:value=>updates.push(value),api:{getSyncSnapshot:async query=>{
    if(!query.resource){manifests++;return manifest;}
    if(query.resource==='meta'&&!conflicted){conflicted=true;throw Object.assign(Error('conflict'),{status:409,details:manifest});}
    return {epoch:'epoch',revision:query.revision,cursor:0,nextCursor:null,fragment:JSON.stringify(query.resource==='news'?[{id:'retained'}]:{ok:true})};
  }}});
  await client.requestSnapshot();assert.equal(manifests,1);assert.deepEqual(updates[0].news,[{id:'retained'}]);assert.equal(client.applied.meta,2);client.close();
});
test('proposal conformity and repair rates have independent denominators and bounded coverage',()=>{
  const row=validation=>({task:'instrument_outlook',model:'fixture',validation});
  const metrics=summarizeProposals([
    row({candidateAttempts:1,initialOutcome:'valid'}),
    row({candidateAttempts:2,initialOutcome:'invalid',repairAttempted:true,repairOutcome:'valid'}),
    row({candidateAttempts:1,initialOutcome:'unknown',repairAttempted:true,repairOutcome:'unknown'}),
    row(null),row({candidateAttempts:1,initialOutcome:'invalid'})
  ],{limit:4});
  assert.equal(metrics.truncated,true);assert.equal(metrics.excluded,1);
  const group=metrics.groups[0];
  assert.equal(group.initialConformity,.5);assert.equal(group.initialAssessed,2);assert.equal(group.initialUnknown,1);
  assert.equal(group.repairSuccess,1);assert.equal(group.repairAssessed,1);assert.equal(group.repairAttempts,2);assert.equal(group.repairUnknown,1);
});
test('ASML/SPCX/EUNL/AMD/ORCL/AAPL equivalent candidates preserve identity and require exact eligible evidence',()=>{
  const at=new Date().toISOString();
  for(const symbol of ['ASML','SPCX','EUNL','AMD','ORCL','AAPL']){
    const job={task:'instrument_outlook',scope:`fixture-${symbol}`},evidenceId=`technical:${symbol}`;
    const item={domain:'technical.get',availableAt:at,quality:{},data:{instrumentId:job.scope,interval:'1day',quality:{},lastClosedCandleAt:at,indicators:{sma:{value:337.60950164794923}}}};
    const value={...publicationExample(job,evidenceId),direction:'up',invalidation:['Cierre inferior al soporte observado'],technicalFacts:[{evidenceId,path:'indicators.sma.value',value:item.data.indicators.sma.value}],drivers:[{domain:'technical',description:'Tendencia observada',evidenceIds:[evidenceId]}],scenarios:['base','bull','bear'].map(name=>({name,description:'Escenario condicional'}))};
    const context={job,snapshot:{asOf:at},lookup:()=>item};
    assertPublication(value,context);
    assert.throws(()=>assertPublication({...value,instrumentId:'other'},context),{code:'AGENT_INSTRUMENT_MISMATCH'});
    assert.throws(()=>assertPublication({...value,invalidation:[]},context),{code:'AGENT_INVALIDATION_REQUIRED'});
    assert.throws(()=>assertPublication({...value,alertAssessments:[{alertId:'foreign',revision:1,summary:'No corresponde',evidenceIds:[evidenceId]}]},context),{code:'AGENT_TASK_FIELD_MISMATCH'});
    assert.throws(()=>assertPublication({...value,technicalFacts:[{...value.technicalFacts[0],path:'indicators.sma'}]},context),error=>error.details.suggestedPath==='indicators.sma.value');
    item.data.quality.reason='insufficient-bars';assert.throws(()=>assertPublication(value,context),{code:'AGENT_TECHNICAL_DATA_REQUIRED'});
  }
});
test('new reservations cannot displace accepted downloads and expiry remains absolute under changes',()=>{
  let now=0;const state={news:[{text:'ñ'.repeat(1000)}]},sync=new StateSync({getSnapshot:()=>state},{now:()=>now,pageChars:100,retainedLimit:0,cacheBytes:12000});
  const first=sync.page({resource:'news',profile:'dashboard-v1',clientKey:'one'});
  assert.equal(first.status,200);const id=first.data.downloadId,expiry=first.data.expiresAt;
  const other=sync.page({resource:'news',profile:'dashboard-v1',clientKey:'one'});assert.equal(other.status,200);
  assert.equal(sync.page({resource:'news',profile:'dashboard-v1',clientKey:'one'}).code,'SYNC_CAPACITY_EXHAUSTED');
  state.news=[{text:'new'}];sync.change(['news']);now=59000;
  const next=sync.page({resource:'news',revision:0,cursor:first.data.nextCursor,profile:'dashboard-v1',clientKey:'one',downloadId:id});
  assert.equal(next.status,200);assert.equal(next.data.expiresAt,expiry);assert.ok(sync.metrics.representationBytes<=12000);assert.equal(sync.retained.size,0);
  now=60000;assert.equal(sync.page({resource:'news',revision:0,profile:'dashboard-v1',clientKey:'one',downloadId:id}).code,'SYNC_DOWNLOAD_EXPIRED');
});
test('one shared repair yields one durable publication or none, including missing tool evidence',async()=>{
  for(const kind of ['valid','repair','invalid','missing-tool','missing-tool-repeated']){
    const proposal=publicationExample({task:'global_intelligence_brief'},'coverage:fixture');
    let publications=0,repairs=0,metadata,terminal;
    const worker=new IntelligenceWorker({model:'llamacpp/fixture',policy:{heartbeatMs:100000},call:async(method,input)=>{
      if(method==='snapshot')return {snapshotId:'snapshot-fixture'};
      if(method==='memory'||method==='evidence')return {items:[]};
      if(method==='run')return {status:'running',fence:1};
      if(method==='publish'){publications++;metadata=input.metadata;terminal='completed';return {status:'completed'};}
      if(method==='state'&&['failed','incomplete'].includes(input.status)){metadata=input.metadata;terminal=input.status;}
      return {};
    },opencode:{session:async()=>({id:'session-fixture'}),messages:async()=>({data:[]}),cancel:async()=>{},prompt:async(_id,{messageId,text})=>{
      if(messageId.startsWith('msg_repair_')){repairs++;if(kind.startsWith('missing-tool'))assert.match(text,/EXCLUSIVAMENTE un objeto JSON/);}
    },progress:async(_session,_signal,messageId)=>{
      const repaired=messageId.startsWith('msg_repair_');
      return {text:kind==='invalid'||kind==='repair'&&!repaired?'{} garbage':JSON.stringify(proposal),idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',usage:[],tools:kind.startsWith('missing-tool')&&(!repaired||kind==='missing-tool-repeated')?[]:[{name:'ogid_query',status:'completed',operationId:'agent.evidence',snapshotId:'snapshot-fixture'}]};
    }}});
    await worker.execute({jobId:'job-fixture',fence:1,task:'global_intelligence_brief',scope:'global',model:'llamacpp/fixture',createdAt:new Date().toISOString()});
    const success=!['invalid','missing-tool-repeated'].includes(kind);
    assert.equal(publications,success?1:0,kind);assert.equal(terminal,success?'completed':'failed',kind);assert.equal(repairs,kind==='valid'?0:1);
    assert.equal(metadata.validation.initialOutcome,kind==='valid'?'valid':'invalid');
    if(repairs)assert.equal(metadata.validation.repairOutcome,success?'valid':'invalid');
  }
});
test('HTTP telemetry separates internal agent work and counts an aborted response only once',()=>{
  const metrics=new RuntimeMetrics(),middleware=metrics.middleware();
  for(const [path,finished] of [['/api/intel/bootstrap',true],['/api/agent/v1/internal/publish',false]]){
    const res=new EventEmitter();res.statusCode=200;res.writableFinished=finished;
    middleware({path},res,()=>{});res.emit(finished?'finish':'close');res.emit('close');
  }
  const summary=metrics.snapshot();assert.equal(summary.http.requests,2);assert.equal(summary.http.active,0);
  assert.equal(summary.http.byTraffic.agentInternal.aborted,1);assert.equal(summary.http.byTraffic.browserAndOther.requests,1);
});
test('concurrent invalid conflict manifests share exactly one additional manifest read',async()=>{
  let calls=0,release;
  const client=new StateSynchronizer({onUpdate:()=>{},api:{getSyncSnapshot:async()=>{calls++;return new Promise(resolve=>{release=resolve;});}}});
  const first=client.recoverManifest({protocol:2,epoch:'e',revision:1,resources:{news:-1}},client.controller.signal);
  const second=client.recoverManifest(null,client.controller.signal);
  assert.equal(calls,1);release({protocol:2,epoch:'e',revision:1,resources:{news:1}});
  assert.deepEqual(await first,await second);client.close();
});
test('a delayed compact reply for an old filter never overwrites the newer selection',async()=>{
  let country='RU';const pending=[],updates=[];
  const client=new StateSynchronizer({profile:'dashboard-v1',getFilters:()=>({countries:country}),onUpdate:value=>updates.push(value),api:{getDashboardBootstrap:filters=>new Promise(resolve=>pending.push({filters,resolve}))}});
  const old=client.syncCompact(client.controller.signal);country='US';const current=client.syncCompact(client.controller.signal);
  const payload=(id,revision)=>({profile:'dashboard-v1',protocol:1,epoch:'epoch',revision,resources:{news:revision},data:{news:[{id}]}});
  pending[1].resolve(payload('US',2));await current;pending[0].resolve(payload('RU',1));await old;
  assert.deepEqual(updates,[{news:[{id:'US'}]}]);client.close();
});
test('compact-budget fallback refreshes the full v2 shapes even after a compact representation was applied',async()=>{
  const state={market:{quotes:{GD:{price:1}},timeseries:{GD:[{price:1}]}},meta:{full:true}},sync=new StateSync({getSnapshot:()=>state}),updates=[];
  const client=new StateSynchronizer({profile:'dashboard-v1',onUpdate:value=>updates.push(value),api:{getDashboardBootstrap:async()=>{throw Object.assign(Error('budget'),{code:'DASHBOARD_BUDGET_EXCEEDED'});},getSyncSnapshot:async input=>input.resource?sync.page(input).data:sync.manifest()}});
  client.applied={...sync.manifest().resources};client.lastHydration='compact';
  await client.requestSnapshot();assert.equal(client.profile,null);assert.deepEqual(updates.at(-1),state);client.close();
});
