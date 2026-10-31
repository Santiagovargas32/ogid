import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {AgentRepository} from '../storage/agentRepository.js';
import {OpenCodeClient} from '../services/agent/opencodeClient.js';
import {readEvents} from '../services/agent/eventStream.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'ogid-demand-')),db=new Database(join(dir,'test.sqlite'));db.pragma('foreign_keys=ON');migrate(db);const runtime=new BusinessRuntime(db,()=>{});runtime.configure({rootDir:dir,news:{},rss:{rssFeeds:[]}});const repo=new AgentRepository(runtime,{debounceMs:0});const d=repo.deviceCreate({label:'owner'}),s=repo.sessionCreate({deviceId:d.deviceId,model:'llamacpp/fixture'});return {db,repo,auth:{sessionId:s.sessionId,deviceId:d.deviceId},close(){runtime.close();db.close();rmSync(dir,{force:true,recursive:true});}};}
test('explicit requests are owned, idempotent and serialized across workers',()=>{const f=fixture();try{
 const input={...f.auth,key:'first',family:'brief',context:{view:'dashboard',countries:['ES']}};
 const first=f.repo.requestAgent(input),again=f.repo.requestAgent(input);assert.equal(first.jobId,again.jobId);assert.equal(again.replayed,true);
 assert.throws(()=>f.repo.requestAgent({...input,family:'outlook'}),{code:'AGENT_IDEMPOTENCY_CONFLICT'});
 assert.throws(()=>f.repo.requestAgent({...input,deviceId:'foreign'}));
 const second=f.repo.requestAgent({...input,key:'second',family:'outlook'});
 const active=f.repo.claim({owner:'one'});assert.equal(active.jobId,first.jobId);assert.equal(f.repo.claim({owner:'two'}),null);
 f.repo.cancel({...active,owner:'one',internal:true});assert.equal(f.repo.claim({owner:'two'}).jobId,second.jobId);
 assert.equal(f.repo.messages(f.auth).items.length,2);
 }finally{f.close();}});
test('context is validated, frozen at send and bounded snapshots disclose partial coverage',()=>{const f=fixture();try{
 assert.throws(()=>f.repo.requestAgent({...f.auth,key:'x',family:'brief',context:{dom:'secret'}}),{code:'AGENT_INVALID_CONTEXT'});
 const result=f.repo.requestAgent({...f.auth,key:'x',family:'brief',context:{countries:['ES']}});
 const j={...f.repo.claim({owner:'one'}),owner:'one'},snapshot=f.repo.snapshot(j);
 assert.deepEqual(snapshot.coverage.requestContext.countries,['ES']);assert.equal(snapshot.asOf,result.context.capturedAt);assert.equal(snapshot.coverage.partial,true);
 const recovered=new AgentRepository(f.repo.runtime);assert.equal(recovered.run({jobId:j.jobId,deviceId:f.auth.deviceId}).input.context.capturedAt,result.context.capturedAt);
 assert.equal(f.repo.analysisSnapshotAccess({snapshotId:snapshot.snapshotId}).sessionId,f.auth.sessionId);
 }finally{f.close();}});
test('outlook instrument and missing targets validate before creating any work',()=>{const f=fixture();try{
 const request={...f.auth,key:'instrument',family:'outlook',scope:'us-equity-general-dynamics'};const result=f.repo.requestAgent(request);assert.equal(f.repo.job(result.jobId).task,'instrument_outlook');
 for(const family of ['assessment','situation_analysis'])assert.throws(()=>f.repo.requestAgent({...f.auth,key:family,family}),{code:'AGENT_INVALID_SCOPE'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM agent_jobs').get().n,1);
 }finally{f.close();}});
test('legacy automatic jobs are audibly cancelled and outbox never creates new work',()=>{const f=fixture();try{
 const old=f.repo.enqueue({task:'global_intelligence_brief',model:'llamacpp/fixture',key:'automatic',input:{outboxSequence:1},priority:10});
 assert.deepEqual(f.repo.consume({model:'llamacpp/fixture'}).jobs,[]);assert.equal(f.repo.claim({owner:'one'}),null);assert.equal(f.repo.job(old.jobId).error_code,'AGENT_AUTOMATION_DISABLED');
 assert.equal(f.db.prepare('SELECT count(*) n FROM agent_snapshots').get().n,0);
 }finally{f.close();}});
test('progress caching reduces full message reads at least eighty percent and terminal hints reconcile',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:1000});
 let reads=0;const client=new OpenCodeClient({password:'fixture',fetchImpl:async url=>{if(url.includes('/message')){reads++;return Response.json({data:[{id:'answer',type:'assistant',time:{created:2},content:[{type:'text',text:'progress'}]},{id:'target',type:'user',time:{created:1}}]});}return Response.json({data:{id:'s',time:{idle:0}}});}});
 for(let i=0;i<10;i++){await client.progress('s',undefined,'target',{cache:true});t.mock.timers.tick(2000);}assert.equal(reads,2);
 client.eventHints.add('s|target');await client.progress('s',undefined,'target',{cache:true});assert.equal(reads,3);
});
test('SSE accepts split encoded events, ignores malformed input and releases the reader on cancellation',async()=>{
 const enc=new TextEncoder(),controller=new AbortController(),events=[];
 const stream=new ReadableStream({start(c){for(const part of ['data: {"sessionID":','"one","type":"session.idle"}\n\n','data: invalid\n\n','data: "{\\"type\\":\\"message.updated\\"}"\n\n'])c.enqueue(enc.encode(part));c.close();}});
 await readEvents(stream,e=>events.push(e),controller.signal);assert.equal(events.length,2);assert.equal(events[0].sessionID,'one');assert.equal(events[1].type,'message.updated');
});

test('semantic gate fails closed without human reviews and rejects invented passing averages',async()=>{
 const {semanticGate}=await import('../services/agent/semanticGate.js');const {readFileSync}=await import('node:fs');const cases=JSON.parse(readFileSync(new URL('../evaluations/agent-semantic-cases.json',import.meta.url))).cases;
 assert.equal(cases.length,32);assert.equal(semanticGate(cases,[]).passed,false);
 const reviews=cases.map(c=>({caseId:c.id,reviewer:'fixture-reviewer',reviewedAt:new Date().toISOString(),jobId:'fixture',snapshotId:'fixture',model:'fixture',promptVersion:'fixture',evidenceReviewHash:'fixture',criticalErrors:0,supportedClaims:20,verifiableClaims:20,utility:3,correctAbstention:true}));
 assert.equal(semanticGate(cases,reviews).passed,true);reviews[0].criticalErrors=1;assert.equal(semanticGate(cases,reviews).passed,false);
});

test('assessment snapshots retain the exact alert revision selected before a correction',()=>{const f=fixture();try{
 const now=new Date().toISOString(),old={alertId:'one',revision:1,title:'Attributed report',updatedAt:now,evidenceIds:[]};
 f.db.prepare('INSERT INTO geopolitical_alerts VALUES(?,?,?,?,?)').run('one',1,'fixture',now,JSON.stringify(old));f.db.prepare('INSERT INTO geopolitical_alert_revisions VALUES(?,?,?)').run('one',1,JSON.stringify(old));
 const first=f.repo.requestAgent({...f.auth,key:'assessment',family:'assessment',scope:'one'});
 f.db.prepare('UPDATE geopolitical_alerts SET revision=2,payload_json=? WHERE alert_id=?').run(JSON.stringify({...old,revision:2,title:'Correction'}),'one');
 const auth={...f.repo.claim({owner:'owner'}),owner:'owner'};assert.equal(auth.jobId,first.jobId);const snapshot=f.repo.snapshot(auth),evidence=f.repo.evidence({snapshotId:snapshot.snapshotId,domain:'geopolitical-alert'}).items;
 assert.equal(evidence.length,1);assert.equal(evidence[0].data.title,old.title);assert.equal(evidence[0].data.revision,1);
 }finally{f.close();}});

test('structured evaluations do not replace the OpenCode conversation used by subsequent chat turns',()=>{const f=fixture();try{
 f.repo.send({...f.auth,key:'chat',text:'Coverage'});const chat={...f.repo.claim({owner:'owner'}),owner:'owner'};f.repo.link({...chat,opencodeId:'ses-chat'});f.repo.cancel({...chat,internal:true});const ticket=f.repo.interruptClaim(chat);if(ticket)f.repo.cancelAcknowledged({...chat,...ticket});
 f.repo.requestAgent({...f.auth,key:'evaluation',family:'brief'});const evaluation={...f.repo.claim({owner:'owner'}),owner:'owner'};assert.ok(evaluation.jobId);f.repo.link({...evaluation,opencodeId:'ses-evaluation'});
 assert.equal(f.db.prepare('SELECT opencode_id FROM agent_sessions WHERE session_id=?').get(f.auth.sessionId).opencode_id,'ses-chat');
 }finally{f.close();}});

test('private evaluations cannot be attached as chat context by another enrolled device',()=>{const f=fixture();try{
 const first=f.repo.requestAgent({...f.auth,key:'private',family:'brief'}),auth={...f.repo.claim({owner:'one'}),owner:'one'},snapshot=f.repo.snapshot(auth);
 const now=new Date().toISOString(),payload=JSON.stringify({proposal:{task:'global_intelligence_brief',summary:'private'}});
 f.db.prepare('INSERT INTO agent_publications VALUES(?,?,?,?,?,?,?,?,?)').run('private-publication',first.jobId,snapshot.snapshotId,'global_intelligence_brief','global',now,now,'shadow',payload);
 const other=f.repo.deviceCreate({label:'other'}),session=f.repo.sessionCreate({deviceId:other.deviceId,model:'llamacpp/fixture'});
 assert.throws(()=>f.repo.send({deviceId:other.deviceId,sessionId:session.sessionId,key:'attempt',text:'Read this',context:['private-publication']}),{code:'AGENT_INVALID_CONTEXT'});
 assert.equal(f.repo.messages({deviceId:other.deviceId,sessionId:session.sessionId}).items.length,0);
 assert.equal(f.repo.resolveContext(['private-publication'],f.auth.deviceId)[0].data.proposal.summary,'private');
 }finally{f.close();}});

test('missing remote sessions release only interruption control and preserve the unknown historical outcome',async()=>{
 let calls=0;const client=new OpenCodeClient({password:'fixture',fetchImpl:async()=>{calls++;return Response.json({}, {status:404});}});
 assert.equal((await client.cancel('missing')).state,'absent');assert.equal(calls,2);
 const forbidden=new OpenCodeClient({password:'fixture',fetchImpl:async()=>Response.json({}, {status:403})});await assert.rejects(forbidden.cancel('missing'),{code:'OPENCODE_HTTP_403'});
 const exists=new OpenCodeClient({password:'fixture',fetchImpl:async(_url,options)=>Response.json(options.method==='GET'?{data:{id:'exists'}}:{},{status:options.method==='GET'?200:404})});await assert.rejects(exists.cancel('exists'),{code:'OPENCODE_HTTP_404'});
 const f=fixture();try{
  f.repo.send({...f.auth,key:'old',text:'old'});const old={...f.repo.claim({owner:'owner'}),owner:'owner'};f.repo.link({...old,opencodeId:'missing'});f.repo.state({...old,status:'incomplete',errorCode:'AGENT_EXECUTION_UNCERTAIN'});
  const ticket=f.repo.interruptClaim(old);f.repo.cancelAcknowledged({...old,...ticket,resolution:{state:'absent'}});
  const preserved=f.repo.job(old.jobId);assert.equal(preserved.status,'incomplete');assert.equal(preserved.error_code,'AGENT_EXECUTION_UNCERTAIN');assert.equal(JSON.parse(preserved.input_json).interruptionResolution.originalOutcome,'unknown');
  f.repo.requestAgent({...f.auth,key:'new',family:'brief'});assert.ok(f.repo.claim({owner:'new'}));
 }finally{f.close();}
});

test('a frozen automatic waiting-model job is retired and never reclaimed after legacy cancellation gates clear',()=>{const f=fixture();try{
 const old=f.repo.enqueue({task:'instrument_outlook',model:'llamacpp/fixture',scope:'us-equity-general-dynamics',key:'old-frozen',input:{outboxSequence:1},priority:10});
 f.db.prepare("UPDATE agent_jobs SET status='waiting-model',attempts=1,snapshot_id=NULL,lease_owner=NULL,prompt_version='ogid-analyst-v1.9' WHERE job_id=?").run(old.jobId);
 const current=f.repo.requestAgent({...f.auth,key:'new',family:'brief'});assert.equal(f.repo.claim({owner:'new'}).jobId,current.jobId);assert.equal(f.repo.job(old.jobId).status,'cancelled');assert.equal(f.repo.job(old.jobId).attempts,1);
 }finally{f.close();}});

test('worker reconciles interruption of retired automatic work without resuming inference',async()=>{
 const {IntelligenceWorker}=await import('../services/agent/worker.js');const calls=[];
 const worker=new IntelligenceWorker({model:'llamacpp/fixture',opencode:{verify:async()=>({}),cancel:async()=>({state:'absent'})},call:async(method,args)=>{calls.push(method);if(method==='reconcileCandidates')return [{jobId:'legacy',fence:1,opencodeId:'missing',input:{outboxSequence:1}}];if(method==='interruptClaim')return {interruptId:'ticket'};if(method==='pendingCancellations')return [];if(method==='claim')return null;return {};}});
 await worker.tick();assert.ok(calls.includes('cancelAcknowledged'));assert.ok(!calls.includes('resume'));worker.stop();
});

test('exhausted historical attempts still reconcile remote interruption without reopening generation retries',()=>{const f=fixture();try{
 const old=f.repo.enqueue({task:'global_intelligence_brief',model:'llamacpp/fixture',key:'exhausted',input:{outboxSequence:1},priority:10});f.db.prepare("UPDATE agent_jobs SET status='incomplete',attempts=3,opencode_id='remote-exhausted' WHERE job_id=?").run(old.jobId);
 assert.ok(f.repo.pendingCancellations().some(j=>j.jobId===old.jobId));assert.ok(!f.repo.reconcileCandidates().some(j=>j.jobId===old.jobId));
 }finally{f.close();}});

test('resource pressure during evidence reads defers the run without consuming its contract repair',async()=>{const f=fixture();try{
 const {IntelligenceWorker}=await import('../services/agent/worker.js');f.repo.requestAgent({...f.auth,key:'pressure',family:'brief'});const job=f.repo.claim({owner:'owner'});let prompts=0;
 const worker=new IntelligenceWorker({model:'llamacpp/fixture',call:async(method,args)=>f.repo.call(method,args),opencode:{session:async id=>({id}),messages:async()=>({data:[]}),prompt:async()=>{prompts++;},cancel:async()=>({}),progress:async()=>({text:'',tools:[{name:'ogid_agent_evidence',callId:'pressure',status:'completed',applicationCode:'STORAGE_RESOURCE_PRESSURE',applicationOk:false}],idle:false})}});worker.owner='owner';await worker.execute(job);
 const preserved=f.repo.job(job.jobId),metadata=JSON.parse(f.db.prepare('SELECT metadata_json FROM agent_runs WHERE job_id=?').get(job.jobId).metadata_json);
 assert.equal(prompts,1);assert.equal(preserved.status,'incomplete');assert.equal(preserved.error_code,'AGENT_RESOURCE_DEFERRED');assert.equal(metadata.validation.repairAttempted,false);assert.equal(f.db.prepare('SELECT count(*) n FROM agent_publications').get().n,0);
 }finally{f.close();}});

test('MCP preserves the typed host-pressure cause across its existing bounded read retry',async()=>{
 const {createReadClient}=await import('../../integrations/ogid-mcp/src/client.js');const {loadConfig}=await import('../../integrations/ogid-mcp/src/config.js');let calls=0;
 const client=createReadClient(loadConfig({OGID_RESEARCH_SCOPE:'agent-evidence'}),async()=>{calls++;return Response.json({error:{code:'STORAGE_RESOURCE_PRESSURE'}},{status:503});});
 await assert.rejects(client.operation('agent.evidence',{snapshotId:'frozen'}),{code:'STORAGE_RESOURCE_PRESSURE'});assert.equal(calls,2);
});

test('a coverage index with omitted body requires a real chunk read before the single repair can publish',async()=>{const f=fixture();try{
 const {IntelligenceWorker}=await import('../services/agent/worker.js');f.repo.requestAgent({...f.auth,key:'large-coverage',family:'brief'});const job=f.repo.claim({owner:'owner'}),auth={...job,owner:'owner'},snapshot=f.repo.snapshot(auth),id='coverage:'+snapshot.snapshotId;
 // Large permitted fixture metadata, arranged before the generation begins.
 f.db.prepare('UPDATE agent_evidence SET payload_json=? WHERE snapshot_id=? AND evidence_id=?').run(JSON.stringify({limitations:['fixture'],sourceStatus:'x'.repeat(24000)}),snapshot.snapshotId,id);
 const index=f.repo.evidence({snapshotId:snapshot.snapshotId,domain:'coverage',limit:1});assert.equal(index.items[0].data,undefined);let prompts=0,chunkRead=false;
 const proposal={schemaVersion:'ogid-agent-publication-v1',task:'global_intelligence_brief',summary:'Cobertura parcial; faltan lecturas de fuentes.',direction:'unavailable',sentiment:'unavailable',stability:'unavailable',horizonHours:24,probability:null,confidenceKind:'qualitative-uncalibrated',evidenceIds:[id],contradictions:[],invalidation:[],limitations:['Cobertura parcial'],technicalFacts:[],intradayScenarios:[]};
 const worker=new IntelligenceWorker({model:'llamacpp/fixture',call:async(method,args)=>f.repo.call(method,args),opencode:{session:async id=>({id}),messages:async()=>({data:[]}),cancel:async()=>({}),prompt:async(_session,input)=>{prompts++;if(prompts===2){assert.ok(input.text.includes('ogid_agent_evidence_chunk'));assert.ok(input.text.includes(id));const chunk=f.repo.evidenceChunk({snapshotId:snapshot.snapshotId,evidenceId:id,offset:0,format:'utf8'});chunkRead=chunk.chunk.length>0;}},progress:async()=>({idle:true,messageId:'answer',finish:'stop',outcome:'succeeded',text:JSON.stringify(proposal),tools:chunkRead?[{name:'ogid_agent_evidence_chunk',status:'completed',callId:'chunk',applicationOk:true,contentRead:true,operationId:'agent.evidence.chunk',snapshotId:snapshot.snapshotId,returnedSnapshotId:snapshot.snapshotId}]:[],usage:[]})}});worker.owner='owner';await worker.execute(job);
 assert.equal(prompts,2);assert.equal(f.repo.job(job.jobId).status,'completed');assert.equal(f.repo.job(job.jobId).snapshot_id,snapshot.snapshotId);
 }finally{f.close();}});
