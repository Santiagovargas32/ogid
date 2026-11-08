import {test} from 'node:test';
import assert from 'node:assert/strict';
import {proposalReturns,proposalText,usesProposalTransport} from '../services/agent/proposalTransport.js';
import {AGENT_PROPOSAL_TRANSPORT} from '../contracts/agentProposalTransport.js';
import {OPERATIONS_HASH} from '../contracts/ogidOperations.js';
import {OpenCodeClient} from '../services/agent/opencodeClient.js';
import {toolReceipt} from '../services/agent/toolReceipt.js';
import {generationSchemaForJob} from '../services/agent/briefReports.js';

const snapshotId='snapshot-fixture',proposal={task:'global_intelligence_brief',sourceReports:[{quote:'Un texto «exacto», sin corregir.',evidenceId:'news:one:1',path:'title'}]};
const payload=()=>({ok:true,origin:'OGID',identity:{hash:OPERATIONS_HASH,profile:'agent-evidence'},data:{transport:AGENT_PROPOSAL_TRANSPORT.version,snapshotId,proposal:structuredClone(proposal)}});
const message=()=>({id:'assistant',type:'assistant',content:[{type:'tool',id:'return-one',name:'ogid_read_ogid_agent_proposal',executed:false,state:{status:'completed',input:{snapshotId,proposal:structuredClone(proposal)},content:[{type:'text',text:JSON.stringify(payload())}]}}]});

test('completed local proposal retains exact values and never supplies an evidence receipt',()=>{
 const returns=proposalReturns([message()]);assert.equal(returns.length,1);assert.equal(returns[0].valid,true);
 assert.deepEqual(JSON.parse(proposalText({proposalReturns:returns},snapshotId,OPERATIONS_HASH)),proposal);
 assert.equal(toolReceipt(JSON.stringify(payload())).contentRead,false);
});
test('source tools, incomplete calls and prior-turn returns cannot masquerade as current output',async()=>{
 for(const change of [p=>p.name='ogid_read_ogid_agent_evidence',p=>p.state.status='running',p=>p.state.status='error']){
  const m=message();change(m.content[0]);assert.deepEqual(proposalReturns([m]),[]);
 }
 const past=message(),latest={id:'current',type:'user',time:{created:2}};
 const client=new OpenCodeClient({password:'fixture',fetchImpl:async url=>Response.json(new URL(url).pathname.endsWith('/message')?{}:{data:{id:'session',time:{idle:3}}})});
 client.messages=async()=>({data:[{id:'new-answer',type:'assistant',content:[],finish:'stop',time:{completed:3}},latest,past]});
 const result=await client.progress('session',undefined,'current');assert.deepEqual(result.proposalReturns,[]);
});
test('tampered, truncated and error envelopes fail closed without fixing the proposal',()=>{
 for(const mutate of [v=>v.data.proposal.sourceReports[0].quote='Changed',v=>v.truncated=true,v=>v.ok=false,v=>v.identity.hash='invalid',v=>v.identity.profile='all']){
  const m=message(),v=payload();mutate(v);m.content[0].state.content=[{type:'text',text:JSON.stringify(v)}];
  const returns=proposalReturns([m]);assert.equal(returns[0].valid,false);
  assert.throws(()=>proposalText({proposalReturns:returns},snapshotId,OPERATIONS_HASH),e=>e.code==='AGENT_INVALID_PROPOSAL_RETURN');
 }
});
test('worker boundary requires one proposal and exact snapshot/contract',()=>{
 const rows=proposalReturns([message()]);
 for(const [returns,snapshot,hash,reason]of [[[],snapshotId,OPERATIONS_HASH,'proposal-tool-required'],[[...rows,...rows],snapshotId,OPERATIONS_HASH,'multiple-proposals'],[rows,'another-snapshot',OPERATIONS_HASH,'wrong-snapshot'],[rows,snapshotId,'f'.repeat(64),'wrong-contract']])
  assert.throws(()=>proposalText({proposalReturns:returns},snapshot,hash),e=>e.code==='AGENT_INVALID_PROPOSAL_RETURN'&&e.details.reason===reason);
});
test('a terminal structural rejection returns bound input for the existing worker repair without a read receipt',async()=>{
 const m=message(),part=m.content[0],error={ok:false,identity:{hash:OPERATIONS_HASH,profile:'agent-evidence'},error:{code:'INVALID_ARGUMENTS'}};
 part.state={status:'error',input:{snapshotId,proposal},error:{type:'tool.execution',message:JSON.stringify(error)}};
 const rows=proposalReturns([m]);assert.equal(rows.length,1);assert.equal(rows[0].rejected,true);
 assert.deepEqual(JSON.parse(proposalText({proposalReturns:rows},snapshotId,OPERATIONS_HASH)),proposal);
 assert.notEqual(toolReceipt(JSON.stringify(error)).contentRead,true);
 const client=new OpenCodeClient({password:'fixture'});client.session=async()=>({time:{}});client.messages=async()=>({data:[m,{id:'input',type:'user',time:{created:1}}]});
 const progress=await client.progress('session',undefined,'input');assert.equal(progress.proposalReturns[0].rejected,true);
 assert.notEqual(progress.tools[0].contentRead,true);assert.equal(Object.hasOwn(progress.tools[0],'proposal'),false);
 for(const mutate of [p=>p.name='ogid_read_ogid_agent_evidence',p=>p.state.status='running',p=>p.state.error.type='provider.error',p=>p.state.error.message='Untrusted error',p=>p.state.input.snapshotId='',p=>p.state.input.snapshotId='x'.repeat(129),p=>p.state.input.proposal=[],p=>p.state.input.proposal={large:'x'.repeat(2097152)}]){
  const bad=structuredClone(m);mutate(bad.content[0]);assert.deepEqual(proposalReturns([bad]),[]);
 }
 for(const mutate of [e=>e.identity.hash='invalid',e=>e.identity.profile='research',e=>e.error.code='NOT_FOUND',e=>e.truncated=true]){
  const bad=structuredClone(m),v=structuredClone(error);mutate(v);bad.content[0].state.error.message=JSON.stringify(v);assert.deepEqual(proposalReturns([bad]),[]);
 }
 for(const [snapshot,hash,reason]of [['another',OPERATIONS_HASH,'wrong-snapshot'],[snapshotId,'f'.repeat(64),'wrong-contract']])assert.throws(()=>proposalText({proposalReturns:rows},snapshot,hash),e=>e.details.reason===reason);
 assert.throws(()=>proposalText({proposalReturns:[...rows,...proposalReturns([message()])]},snapshotId,OPERATIONS_HASH),e=>e.details.reason==='multiple-proposals');
});
test('OpenCode exposes the typed return separately from text and ordinary evidence tools',async()=>{
 const m=message();const client=new OpenCodeClient({password:'fixture'});
 client.session=async()=>({time:{}});client.messages=async()=>({data:[m,{id:'input',type:'user',time:{created:1}}]});
 const result=await client.progress('session',undefined,'input');assert.equal(result.text,'');assert.equal(result.proposalReturns[0].valid,true);
 assert.equal(result.tools[0].operationId,'agent.proposal.return');assert.equal(result.tools[0].contentRead,false);
 assert.equal(Object.hasOwn(result.tools[0],'proposal'),false);
});
test('typed transport covers v1.21 and v1.22 structured jobs and preserves historical brief schemas',()=>{
 assert.equal(usesProposalTransport({task:'global_intelligence_brief',promptVersion:'ogid-analyst-v1.21'}),true);
 assert.equal(usesProposalTransport({task:'global_intelligence_brief',promptVersion:'ogid-analyst-v1.22'}),true);
 for(const [task,promptVersion]of [['contextual_chat','ogid-analyst-v1.21'],['global_intelligence_brief','ogid-analyst-v1.20']])assert.equal(usesProposalTransport({task,promptVersion}),false);
 const old=generationSchemaForJob({task:'global_intelligence_brief',promptVersion:'ogid-analyst-v1.20'}),current=generationSchemaForJob({task:'global_intelligence_brief',promptVersion:'ogid-analyst-v1.21'});
 assert.deepEqual(current,old);assert.ok(old.required.includes('sourceReports'));assert.equal(old.required.includes('summary'),false);
});
