import test from 'node:test';
import assert from 'node:assert/strict';
import {createBusinessAdapters} from '../storage/businessAdapters.js';
import {providerRuntime} from '../services/providers/providerRuntime.js';
import {fetchRss} from '../services/news/providers/rssProvider.js';
import {assertPublication} from '../services/agent/contracts.js';
import {sourceFailureCode} from '../services/research/officialSources.js';
import {IntelligenceWorker} from '../services/agent/worker.js';
import {createAppServer} from '../server.js';
import {PipelinePersistence} from '../storage/pipelinePersistence.js';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {SqlEventLedger} from '../storage/sqlRepositories.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('event references and bodies keep one read view across a concurrent writer revision',()=>{
 const root=mkdtempSync(join(tmpdir(),'ogid-event-read-view-')),file=join(root,'events.sqlite'),writer=new Database(file);
 writer.pragma('journal_mode=WAL');migrate(writer);
 const value={eventId:'event-fixture',title:'before',identityVersion:'source-publication-v2'};
 writer.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(value.eventId,null,value.identityVersion,1,null,'2026-10-20T10:00:00Z','observed',JSON.stringify(value));
 const reader=new Database(file,{readonly:true});reader.pragma('query_only=ON');
 const prepare=reader.prepare.bind(reader);let revised=false;
 reader.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('SELECT rowid,event_id FROM events')){const all=statement.all;statement.all=function(...args){const rows=all.apply(this,args);if(!revised){revised=true;writer.prepare('UPDATE events SET revision=2,payload_json=? WHERE event_id=?').run(JSON.stringify({...value,title:'after'}),value.eventId);}return rows;};}return statement;};
 try{
  const ledger=new SqlEventLedger({store:{db:reader,state:{revision:1}}});
  assert.equal(ledger.search({eventIds:[value.eventId],includeTotal:false}).events[0].title,'before');
  assert.equal(reader.inTransaction,false);
  assert.equal(ledger.search({eventIds:[value.eventId],includeTotal:false}).events[0].title,'after');
 }finally{reader.close();writer.close();rmSync(root,{recursive:true,force:true});}
});

test('cold configuration buffers stage upserts without acknowledging before the actual commit',async()=>{
 let commit;const writes=[];const p=new PipelinePersistence({request:async(_op,input)=>{writes.push(input);await new Promise(r=>{commit=r;});}});
 p.deferStageWrites();let acknowledged=false;
 const one=p.save('pipeline-stage',{id:'storage',stage:{reason:'configure.registry'}}),two=p.save('pipeline-stage',{id:'storage',stage:{reason:'configure.completed'}});one.then(()=>{acknowledged=true;});
 assert.equal(writes.length,0);p.resumeStageWrites();assert.equal(writes.length,1);assert.equal(writes[0].payload.stage.reason,'configure.completed');assert.equal(acknowledged,false);
 commit();await Promise.all([one,two]);assert.equal(acknowledged,true);await p.flush();
});

test('shutdown stops acquisition admission before waiting for a long maintenance operation',async()=>{
 const runtime=createAppServer({storage:{enabled:false},agent:{mode:'off'},disableBackgroundRefresh:true});
 let release,stopped=false;const gate=new Promise(r=>{release=r;});
 runtime.app.locals.agentMaintenance.stop=()=>gate;
 runtime.orchestrator.stop=async()=>{stopped=true;};
 const closing=runtime.stop();
 try{await new Promise(setImmediate);assert.equal(stopped,true);}
 finally{release();await closing;}
});

test('source diagnostics distinguish response JSON, contract, transport, HTTP and timeout',()=>{
 for(const [error,options,code] of [[new SyntaxError('private body'),{},'SOURCE_JSON_INVALID'],[new Error('cik-mismatch'),{},'SOURCE_CONTRACT_INVALID'],[new TypeError('private URL'),{},'SOURCE_TRANSPORT_ERROR'],[Object.assign(new Error(),{status:403}),{},'HTTP_403'],[new Error(),{timedOut:true},'SOURCE_TIMEOUT'],[new Error(),{cancelled:true},'SOURCE_CANCELLED']])assert.equal(sourceFailureCode(error,options),code);
});

test('known quality and intraday validation failures share one repair and remain terminal when repeated',async()=>{
 for(const code of ['AGENT_STALE_EVIDENCE','AGENT_INVALIDATION_REQUIRED','AGENT_INTRADAY_DATA_REQUIRED'])for(const repeated of [false,true]){
  let publications=0,repairs=0,terminal;
  const proposal={schemaVersion:'ogid-agent-publication-v1',task:'global_intelligence_brief',summary:'Coverage',direction:'unavailable',sentiment:'unavailable',stability:'unavailable',horizonHours:24,probability:null,confidenceKind:'qualitative-uncalibrated',evidenceIds:['coverage:fixture'],contradictions:[],invalidation:[],limitations:['No fresh data'],technicalFacts:[]};
  const worker=new IntelligenceWorker({model:'llamacpp/fixture',policy:{heartbeatMs:100000},call:async(method,input)=>{
   if(method==='snapshot')return {snapshotId:'snap-fixture'};
   if(method==='memory')return {items:[]};
   if(method==='evidence')return {items:[]};
   if(method==='run')return {status:'running',fence:1};
   if(method==='publish'){publications++;if(publications===1||repeated)throw Object.assign(new Error('stale'),{code,details:{evidenceId:'stale-fixture'}});terminal='completed';}
   if(method==='state'&&['completed','failed','incomplete'].includes(input.status))terminal=input.status;
   return {};
  },opencode:{session:async()=>({id:'session-fixture'}),messages:async()=>({data:[]}),prompt:async(_id,{messageId})=>{if(messageId.startsWith('msg_repair_'))repairs++;},progress:async()=>({text:JSON.stringify(proposal),idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',tools:[{name:'ogid_query',status:'completed',operationId:'agent.evidence',snapshotId:'snap-fixture',applicationOk:true,contentRead:true,returnedSnapshotId:'snap-fixture'}],usage:[]}),cancel:async()=>{}}});
  await worker.execute({jobId:'job-fixture',owner:'owner',fence:1,task:'global_intelligence_brief',scope:'global',model:'llamacpp/fixture',createdAt:new Date().toISOString()});
  assert.equal(repairs,1);assert.equal(publications,2);assert.equal(terminal,repeated?'failed':'completed');
 }
});

test('worker RSS status reports real coverage and leaves unmeasured counters unknown',()=>{
 const rss={stage:'completed',catalogSize:2,availableFeedCount:2,queriedFeedCount:2,startedAt:'2026-10-20T10:00:00Z',completedAt:'2026-10-20T10:00:02Z',collectedCount:7,catalogStatus:[{status:'ok',lastAttemptAt:'2026-10-20T10:00:00Z',lastSuccessAt:'2026-10-20T10:00:02Z'},{status:'error',error:'rss-timeout',lastAttemptAt:'2026-10-20T10:00:00Z'}]};
 const manager={getStatus:()=>({worker:{rss}})};
 const status=createBusinessAdapters(manager,{}).rss.getStatus();
 assert.deepEqual(status.coverage,{checked:2,enabled:2});assert.equal(status.availability,'degraded');
 assert.equal(status.metrics.errors,1);assert.equal(status.metrics.collectedArticles,7);assert.equal(status.metrics.lastDurationMs,2000);assert.equal(status.metrics.newArticles,null);
 assert.equal(status.metrics.inFlight,0);assert.equal(rss.coverage,undefined);
});
test('an RSS host opening its circuit does not block a different publisher',async()=>{
 const original=providerRuntime.fetchImpl,threshold=providerRuntime.failureThreshold;
 providerRuntime.reset();providerRuntime.failureThreshold=1;let calls=[];
 providerRuntime.fetchImpl=async url=>{calls.push(new URL(url).host);return new Response(new URL(url).host==='broken.invalid'?'unavailable':'<rss><channel><title>Healthy</title><item><title>Release</title><link>https://healthy.invalid/news</link></item></channel></rss>',{status:new URL(url).host==='broken.invalid'?503:200});};
 try{
  await fetchRss({feeds:[{url:'https://broken.invalid/rss'}],retries:0});
  await fetchRss({feeds:[{url:'https://broken.invalid/rss2'}],retries:0});
  const healthy=await fetchRss({feeds:[{url:'https://healthy.invalid/rss'}],retries:0});
  assert.equal(healthy.articles.length,1);assert.deepEqual(calls,['broken.invalid','healthy.invalid']);
 }finally{providerRuntime.fetchImpl=original;providerRuntime.failureThreshold=threshold;providerRuntime.reset();}
});
test('stale evidence has its own error and exact offending ID without weakening rejection',()=>{
 const at=new Date().toISOString();const proposal={schemaVersion:'ogid-agent-publication-v1',task:'global_intelligence_brief',summary:'Coverage',direction:'unavailable',sentiment:'unavailable',stability:'unavailable',horizonHours:24,probability:null,confidenceKind:'qualitative-uncalibrated',evidenceIds:['technical-stale'],contradictions:[],invalidation:[],limitations:['No fresh data'],technicalFacts:[]};
 assert.throws(()=>assertPublication(proposal,{job:{task:proposal.task},snapshot:{asOf:at},lookup:()=>({availableAt:at,quality:{stale:true,synthetic:false},data:{}})}),e=>e.code==='AGENT_STALE_EVIDENCE'&&e.details.evidenceId==='technical-stale');
});
