import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDirectGeneration,validateDirectCandidate,runDirectGeneration,directBrokerCompletion} from '../services/agent/directGeneration.js';
import {generationExample} from '../services/agent/briefReports.js';
import {PROMPT_VERSION} from '../services/agent/contracts.js';
const asOf='2026-11-15T17:00:00.000Z',now=Date.parse(asOf);
const snapshot={snapshotId:'snapshot:direct',asOf,coverage:{selectedInstrumentIds:[]}};
const coverage={evidenceId:'coverage:direct',domain:'coverage',availableAt:asOf,quality:{},publicationEligibility:{eligible:true},data:{}};
const job=task=>({task,scope:task==='instrument_outlook'?'NVDA':task==='situation_analysis'?'situation:fixture':'global',model:'llamacpp/gpt-oss-20b',promptVersion:PROMPT_VERSION});
const prepare=(task='global_intelligence_brief',evidence=[coverage])=>prepareDirectGeneration({job:job(task),snapshot,evidence});
const example=p=>JSON.stringify(generationExample(p.input.job,coverage.evidenceId));
test('four families and instrument outlook retain canonical schema and abstention validation',()=>{
 for(const task of ['global_intelligence_brief','market_outlook_global','instrument_outlook','geopolitical_alert_assessment','situation_analysis']){
  const p=prepare(task),candidate=validateDirectCandidate(example(p),p,{now});
  assert.equal(candidate.proposal.task,task);assert.equal(candidate.proposal.probability,null);
  assert.equal(p.request.tools,undefined);assert.equal(p.request.model,'gpt-oss-20b');
 }
});
test('packages detach and freeze content; reject incomplete, foreign, duplicate and oversized evidence',()=>{
 const evidence=[structuredClone(coverage)],p=prepare('global_intelligence_brief',evidence);
 evidence[0].data.injected=true;assert.equal(p.input.evidence[0].data.injected,undefined);
 assert.throws(()=>{p.input.evidence[0].data.injected=true;},TypeError);
 assert.notEqual(p.key,prepare('global_intelligence_brief',[{...coverage,data:{changed:true}}]).key);
 for(const item of [{...coverage,data:null},{...coverage,representation:'chunked'},{...coverage,dataRef:{}},{...coverage,snapshotId:'foreign'}])assert.throws(()=>prepare('global_intelligence_brief',[item]),{code:'AGENT_DIRECT_EVIDENCE_INVALID'});
 assert.throws(()=>prepare('global_intelligence_brief',[coverage,coverage]),{code:'AGENT_DIRECT_EVIDENCE_INVALID'});
 assert.throws(()=>prepare('global_intelligence_brief',[{...coverage,data:{text:'x'.repeat(2097152)}}]),{code:'AGENT_DIRECT_EVIDENCE_TOO_LARGE'});
 assert.throws(()=>prepare('contextual_chat'),{code:'AGENT_DIRECT_TASK_UNSUPPORTED'});
});
test('canonical validators reject stale evidence, fabricated quotes and unknown references',()=>{
 const p=prepare();assert.throws(()=>validateDirectCandidate(example(p),p,{now:now+86400001}),{code:'AGENT_EVIDENCE_STALE'});
 const candidate=JSON.parse(example(p));candidate.sourceReports=[{evidenceId:coverage.evidenceId,path:'title',quote:'A fabricated reported claim',verificationFocus:'source_verification'}];
 assert.throws(()=>validateDirectCandidate(JSON.stringify(candidate),p,{now}),{code:'AGENT_UNVERIFIED_SOURCE_REPORT'});
 candidate.sourceReports=[];candidate.evidenceIds=['unknown'];assert.throws(()=>validateDirectCandidate(JSON.stringify(candidate),p,{now}),{code:'AGENT_UNKNOWN_EVIDENCE'});
});
test('exclusive intent precedes inference; transport uncertainty and journal failure never replay',async()=>{
 const p=prepare(),events=[];let calls=0;
 const complete=async()=>{calls++;assert.equal(events[0].state,'admitted');throw Object.assign(Error('lost ACK'),{code:'LOST_ACK'});};
 await assert.rejects(runDirectGeneration({prepared:p,complete,record:async e=>{events.push(e);},now:()=>now}),{code:'LOST_ACK'});
 assert.equal(calls,1);assert.equal(events[1].state,'incomplete');
 await assert.rejects(runDirectGeneration({prepared:p,complete,record:async()=>{throw Error('intent exists');}}),/intent exists/);assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(runDirectGeneration({prepared:p,complete,record:async()=>{},signal:controller.signal}));assert.equal(calls,1);
});
test('receipts bind delivered evidence, request and output without fabricating MCP reads',async()=>{
 const p=prepare(),events=[];
 const result=await runDirectGeneration({prepared:p,complete:async()=>({text:example(p),usage:{completion_tokens:20}}),record:async e=>{events.push(e);},now:()=>now});
 assert.equal(result.state,'validated');assert.equal(events.length,2);assert.equal(result.receipt.requestHash,p.identity.requestHash);
 assert.equal(result.receipt.evidence[0].evidenceId,coverage.evidenceId);assert.equal(result.receipt.transport,'broker-schema-json');
});
const frame=value=>'data: '+JSON.stringify(value)+'\r\n\r\n';
const content=text=>frame({choices:[{index:0,delta:{content:text},finish_reason:null}]});
const stop=frame({choices:[{index:0,delta:{},finish_reason:'stop'}]});
function transport(wire,onRequest=()=>{}){return directBrokerCompletion({baseUrl:'http://127.0.0.1:8081',token:'private',fetchImpl:async(url,options)=>{onRequest(url,options);return new Response(new ReadableStream({start(controller){const bytes=new TextEncoder().encode(wire);for(let n=0;n<bytes.length;n+=3)controller.enqueue(bytes.slice(n,n+3));controller.close();}}),{headers:{'content-type':'text/event-stream'}});}});}
test('stream handles fragmented Unicode, retaining content and discarding private reasoning',async()=>{
 const wire=frame({choices:[{index:0,delta:{reasoning_content:'private'},finish_reason:null}]})+content('España')+stop+'data: [DONE]\r\n\r\n';
 const result=await transport(wire,(url,options)=>{assert.equal(url,'http://127.0.0.1:8081/v1/chat/completions');assert.equal(options.headers['x-ogid-work-class'],'background');assert.equal(options.redirect,'error');})(prepare().request);
 assert.equal(result.text,'España');assert.equal(JSON.stringify(result).includes('private'),false);
});
test('incomplete streams, tools and truncated generations fail without retries',async()=>{
 for(const wire of [content('{}'),content('{}')+stop,content('{}')+frame({choices:[{index:0,finish_reason:'length'}]})+'data: [DONE]\n\n',frame({choices:[{index:0,delta:{tool_calls:[{}]}}]})])await assert.rejects(transport(wire)(prepare().request));
 assert.throws(()=>directBrokerCompletion({baseUrl:'https://external.example',token:'x'}));
});
