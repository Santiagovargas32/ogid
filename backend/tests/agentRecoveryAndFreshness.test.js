import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {AgentRepository} from '../storage/agentRepository.js';
import {recoveryAfter} from '../services/agent/recovery.js';
import {newsFreshness,currentNewsCorpus,NEWS_FRESHNESS_POLICY} from '../services/news/newsFreshness.js';
import {healthDiagnostics} from '../services/healthDiagnostics.js';
import {StreamDiagnostics} from '../services/agent/streamDiagnostics.js';
import {terminalFailure,transportFailure} from '../services/agent/failures.js';
import {AgentModelSelection} from '../services/agent/modelSelection.js';
import {agentToolCall,OPERATIONS_HASH} from '../contracts/ogidOperations.js';
import {runtimeTelemetry} from '../services/agent/runtimeTelemetry.js';
import {toolReceipt} from '../services/agent/toolReceipt.js';
import {newerNews} from '../../frontend/js/newsQualityView.js';

test('news clocks enforce 30/10 minutes separately; new failed attempts and projections do not reset them',()=>{
 const now=Date.parse('2026-10-24T17:04:07Z');
 const corpus={eligibleCount:8,latestGeopoliticalPublishedAt:'2026-10-24T16:43:13Z',lastSuccessfulCheckAt:'2026-10-24T17:03:33Z',freshnessPolicy:NEWS_FRESHNESS_POLICY,lastAttemptAt:new Date(now).toISOString()};
 assert.equal(newsFreshness(corpus,now).sourceMode,'live');
 const time=Date.parse(corpus.latestGeopoliticalPublishedAt);
 assert.equal(newsFreshness({...corpus,lastSuccessfulCheckAt:new Date(time+1800000).toISOString()},time+1800000).contentStatus,'recent');
 assert.equal(newsFreshness(corpus,time+1800001).contentStatus,'stale');
 const checked=Date.parse(corpus.lastSuccessfulCheckAt);
 assert.equal(newsFreshness(corpus,checked+600000).acquisitionStatus,'current');
 assert.equal(newsFreshness(corpus,checked+600001).acquisitionStatus,'stale');
 const noNews={...corpus,lastSuccessfulCheckAt:new Date(now+1800000).toISOString(),projectionGeneratedAt:new Date(now+1800000).toISOString()};
 assert.deepEqual(newsFreshness(noNews,now+1800000).staleReasons,['content-publication-expired']);
 assert.equal(currentNewsCorpus(corpus,now+3600000).sourceMode,'stale');
 assert.equal(corpus.freshness,undefined,'frozen source metadata is not rewritten');
 assert.equal(currentNewsCorpus({...corpus,freshnessPolicy:{version:'future'}}).freshness,undefined);
 assert.equal(newsFreshness({...corpus,latestGeopoliticalPublishedAt:null},now).sourceMode,'unavailable');
 assert.equal(newsFreshness({...corpus,latestGeopoliticalPublishedAt:new Date(now+1).toISOString()},now).contentStatus,'unknown');
});

test('health keeps simultaneous clock failures but deduplicates their pipeline/provider aliases',()=>{
 const now=Date.parse('2026-10-24T17:00:00Z'),corpus={eligibleCount:1,freshnessPolicy:NEWS_FRESHNESS_POLICY,latestGeopoliticalPublishedAt:'2026-10-24T16:00:00Z',lastSuccessfulCheckAt:'2026-10-24T16:00:00Z',staleReasons:['content-publication-expired']};
 const d=healthDiagnostics({pipelineMonitor:{snapshot:()=>({news:{status:'running',quality:{status:'stale'}}})}}, {sourceMeta:{corpus},dataQuality:{news:{mode:'stale',reason:'provider-data-stale'}}},now);
 assert.equal(d.operational.status,'ok');assert.equal(d.quality.status,'degraded');
 assert.deepEqual(d.causes.map(c=>c.code),['content-publication-expired','acquisition-check-expired']);
});

test('newer WS/admin clocks cannot replace a newer corpus revision with an older response',()=>{
 const recent={revision:4,projectionGeneratedAt:'2026-10-24T17:00:00Z',freshness:{evaluatedAt:'2026-10-24T17:05:00Z'}};
 assert.equal(newerNews(recent,{revision:3,freshness:{evaluatedAt:'2026-10-24T17:06:00Z'}}),recent);
 assert.equal(newerNews(recent,{...recent,freshness:{evaluatedAt:'2026-10-24T17:04:00Z'}}),recent);
});

test('SSE parser distinguishes HTTP 200 error, incomplete stream and successful fragmented tool turns without keeping bodies',()=>{
 const encode=new TextEncoder(),s=new StreamDiagnostics();
 const body='data: {"choices":[{"delta":{"content":"private"},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
 for(const byte of encode.encode(body))s.push(Uint8Array.of(byte));
 assert.equal(s.result(),null);assert.ok(!JSON.stringify(s).includes('private'));
 const error=new StreamDiagnostics();error.push(encode.encode('data: {"error":{"message":"The model produced output that does not match the expected peg-native format","type":"server_error"}}\n\n'));
 assert.equal(error.result().causeCode,'LLAMACPP_OUTPUT_FORMAT');
 const cut=new StreamDiagnostics();cut.push(encode.encode('data: {"choices":[{"finish_reason":"stop"}]}\n\n'));assert.equal(cut.result().causeCode,'BROKER_INCOMPLETE_STREAM');
 assert.equal(terminalFailure({message:'private token timeout'}).causeCode,'INFERENCE_TIMEOUT');
 assert.ok(!JSON.stringify(terminalFailure({message:'private token timeout'})).includes('private'));
});

test('typed tool identity and sanitized component telemetry preserve correlation without argument content',()=>{
 assert.deepEqual(agentToolCall('ogid_read_ogid_agent_evidence_chunk',{snapshotId:'s',evidenceId:'e'}),{operationId:'agent.evidence.chunk',snapshotId:'s'});
 assert.deepEqual(agentToolCall('ogid_read_ogid_query',{operationId:'agent.evidence',parameters:{snapshotId:'s'}}),{operationId:'agent.evidence',snapshotId:'s'});
 assert.equal(agentToolCall('ogid_read_ogid_agent_evidence',null).operationId,'agent.evidence');assert.equal(agentToolCall('ogid_read_ogid_query',{operationId:'PRIVATE'}).operationId,undefined);
 assert.equal(JSON.stringify(runtimeTelemetry({model:'fixture',requestId:'request',body:'PRIVATE',reasoning:'PRIVATE',lastFailure:{causeCode:'LLAMACPP_OUTPUT_FORMAT',message:'PRIVATE'}})).includes('PRIVATE'),false);
 const receipt={ok:true,origin:'OGID',identity:{hash:OPERATIONS_HASH},readReceipt:{contractHash:OPERATIONS_HASH,snapshotId:'s',contentRead:true,evidenceIds:['e']}};
 assert.equal(toolReceipt(receipt).contentRead,true);
 assert.equal(toolReceipt({...receipt,readReceipt:{...receipt.readReceipt,contractHash:'0'.repeat(64)}}).applicationOk,false);
 assert.equal(toolReceipt({...receipt,readReceipt:{...receipt.readReceipt,contractHash:undefined}}).contentRead,false);
 assert.equal(toolReceipt({isError:true,structuredContent:receipt}).applicationOk,false);
});

test('transport failure types and unobserved model catalogs stay explicit without querying providers',()=>{
 for(const [code,expected]of [['ENOTFOUND','DNS'],['EAI_AGAIN','DNS'],['CERT_HAS_EXPIRED','TLS'],['ECONNREFUSED','CONNECTION']])assert.equal(transportFailure({cause:{code}}).causeCode,'OPENCODE_'+expected);
 assert.equal(transportFailure({name:'AbortError'}).causeCode,'OPENCODE_CANCELLED');assert.equal(transportFailure({name:'TimeoutError'}).causeCode,'OPENCODE_TIMEOUT');
 let calls=0,now=100000;
 const selection=new AgentModelSelection({config:{backgroundModel:'llamacpp/fixture',manifest:{models:[{alias:'fixture'}]}},now:()=>now,opencode:{models(){calls++;}}});
 assert.equal(selection.peek().models[0].available,null);assert.equal(selection.peek().availabilityKnown,false);
 selection.cached={models:[{id:'llamacpp/fixture',ready:true,selectable:true}]};selection.cachedAt=now;assert.equal(selection.peek().models[0].ready,true);
 now+=90001;assert.equal(selection.peek().models[0].ready,false);assert.equal(selection.peek().availabilityKnown,false);assert.equal(calls,0);
});

test('recovery jitter is bounded, uncertain outcomes stay fenced and success resets the streak',()=>{
 let state={};for(let i=0;i<3;i++)state=recoveryAfter(state,{status:'failed',causeCode:'LLAMACPP_OUTPUT_FORMAT',jobId:'job',fence:i,now:0,random:()=>0});
 assert.equal(Date.parse(state.nextEligibleAt),48000);
 assert.equal(recoveryAfter(state,{status:'incomplete'}),state);
 state=recoveryAfter(state,{status:'completed',now:100});assert.equal(state.consecutiveFailures,0);assert.equal(state.nextEligibleAt,null);assert.ok(state.lastFailure);
});

test('durable circuit survives a repository restart, admits one probe and resets only on accepted publication',()=>{
 const root=mkdtempSync(join(tmpdir(),'ogid-recovery-')),file=join(root,'fixture.sqlite');let now=Date.now(),db,runtime,repo;
 const open=()=>{db=new Database(file);db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');migrate(db);runtime=new BusinessRuntime(db,()=>{});runtime.configure({rootDir:root,news:{},rss:{rssFeeds:[]}});repo=new AgentRepository(runtime,{now:()=>now,random:()=>.5,debounceMs:0});};
 const close=()=>{runtime.close();db.close();};
 const enqueue=key=>repo.enqueue({task:'global_intelligence_brief',model:'llamacpp/fixture',key,priority:10});
 open();try{
  const since=new Date(now).toISOString();
  for(let i=0;i<3;i++){enqueue('failure-'+i);const j=repo.claim({owner:'worker'});repo.state({jobId:j.jobId,owner:'worker',fence:j.fence,status:'failed',errorCode:'AGENT_NO_PROGRESS',metadata:{lastToolFailure:{code:'INVALID_ARGUMENTS'},evidenceReads:0}});now++;}
  const pending=enqueue('probe');enqueue('after-probe');assert.equal(repo.claim({owner:'worker'}),null);
  const until=repo.recovery('llamacpp/fixture').nextEligibleAt;close();open();
  assert.equal(repo.recovery('llamacpp/fixture').nextEligibleAt,until);now=Date.parse(until);
  const probe=repo.claim({owner:'worker'});assert.equal(probe.jobId,pending.jobId);assert.equal(repo.claim({owner:'second-worker'}),null);
  const auth={jobId:probe.jobId,fence:probe.fence,owner:'worker'},snapshot=repo.snapshot(auth),id=repo.evidence({snapshotId:snapshot.snapshotId,domain:'coverage',limit:1}).items[0].evidenceId;
  assert.deepEqual(snapshot.coverage.newsFreshnessPolicy,NEWS_FRESHNESS_POLICY);
  repo.publish({...auth,mode:'shadow',proposal:{schemaVersion:'ogid-agent-publication-v1',task:'global_intelligence_brief',summary:'Coverage is insufficient.',direction:'unavailable',sentiment:'unavailable',stability:'unavailable',horizonHours:24,probability:null,confidenceKind:'qualitative-uncalibrated',evidenceIds:[id],contradictions:[],invalidation:[],limitations:['Partial coverage'],technicalFacts:[]}});
  assert.equal(repo.recovery('llamacpp/fixture').consecutiveFailures,0);assert.equal(repo.recovery('llamacpp/fixture').contractHash,OPERATIONS_HASH);
  const s=repo.status({since});assert.equal(s.current.failed,3);assert.equal(s.current.publications,1);assert.ok(repo.claim({owner:'worker'}));
 }finally{close();rmSync(root,{recursive:true,force:true});}
});
