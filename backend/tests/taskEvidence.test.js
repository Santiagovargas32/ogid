import test from 'node:test';
import assert from 'node:assert/strict';
import {taskEvidencePlan} from '../services/agent/taskEvidence.js';
import {IntelligenceWorker} from '../services/agent/worker.js';
import {PROMPT_VERSION,publicationExample,validatePublicationForJob} from '../services/agent/contracts.js';

test('each family starts with its pertinent frozen domain and preserves bounded continuations without source bodies', async()=>{
  for(const [task,context,domain] of [
    ['global_intelligence_brief',{},'news'],['global_intelligence_brief',{alertId:'selected'},'geopolitical-alert'],
    ['geopolitical_alert_assessment',{},'geopolitical-alert'],['market_outlook_global',{},'technical.get'],
    ['instrument_outlook',{},'technical.get'],['situation_analysis',{},'situation-source'],
  ]) {
    const calls=[];
    const plan=await taskEvidencePlan(async(_method,args)=>{calls.push(args);return {items:[{evidenceId:'source',domain,data:{text:'untrusted corpus'},publicationEligibility:{eligible:true}}],hasMore:true,nextCursor:'next'};},'cut',{task,input:{context}});
    assert.deepEqual(calls,[{snapshotId:'cut',domain,limit:20}]);assert.equal(plan.hasSources,true);
    assert.equal(plan.readParameters.domain,domain);assert.equal(plan.index.items[0].data,undefined);
    assert.equal(plan.index.nextCursor,'next');assert.equal(plan.index.hasMore,true);
  }
});

test('coverage fallback requires an empty final domain page; deferred reads never become an apparent absence', async()=>{
  const calls=[];
  const plan=await taskEvidencePlan(async(_method,args)=>{calls.push(args.domain);return {items:args.domain==='coverage'?[{evidenceId:'coverage:cut',domain:'coverage'}]:[],hasMore:false};},'cut',{task:'global_intelligence_brief'});
  assert.deepEqual(calls,['news','coverage']);assert.equal(plan.hasSources,false);assert.equal(plan.readParameters.domain,'coverage');
  const pending=await taskEvidencePlan(async()=>({items:[],hasMore:true,nextCursor:'next'}),'cut',{task:'global_intelligence_brief'});
  assert.equal(pending.hasSources,true);assert.equal(pending.readParameters.domain,'news');
  await assert.rejects(taskEvidencePlan(async()=>{throw Object.assign(Error('pressure'),{code:'AGENT_RESOURCE_DEFERRED'});},'cut',{task:'global_intelligence_brief'}),{code:'AGENT_RESOURCE_DEFERRED'});
});

test('brief repair requests source contents rather than coverage and keeps its synthesis purpose', async()=>{
  const prompts=[],states=[];
  const worker=new IntelligenceWorker({model:'fixture',call:async(method,args)=>{
    if(method==='snapshot')return {snapshotId:'cut',asOf:new Date().toISOString(),coverage:{domains:{news:{count:100}}}};
    if(method==='evidence')return {items:[{evidenceId:'news:real',domain:'news',publicationEligibility:{eligible:true}}],hasMore:false};
    if(method==='runControl')return {status:'running'};if(method==='state')states.push(args.status);return {};
  },opencode:{session:async()=>({id:'session'}),messages:async()=>({data:[]}),cancel:async()=>{},prompt:async(_id,{text})=>prompts.push(text),progress:async()=>({idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',text:'{}',tools:[],usage:[]})}});
  await worker.execute({jobId:'brief',fence:1,task:'global_intelligence_brief',scope:'global',model:'fixture',promptVersion:PROMPT_VERSION,input:{origin:'user'},createdAt:new Date().toISOString()});
  assert.equal(prompts.length,2);assert.ok(states.includes('failed'));
  for(const text of prompts){
    assert.ok(text.includes('"domain":"news"'));assert.ok(text.includes('síntesis geopolítica atribuida'));
    assert.ok(!text.includes('Ejemplo de estructura de abstención'));assert.ok(!text.includes('Ejemplo parcial de cobertura'));
    assert.ok(!text.includes('"evidenceId":"coverage:cut","offset":0'));
  }
  assert.ok(prompts[1].includes('"evidenceId":"news:real","offset":0'));
});

test('contextual chat receives no publication contract or JSON example', async()=>{
  let prompt;
  const worker=new IntelligenceWorker({model:'fixture',call:async(method)=>{
    if(method==='snapshot')return {snapshotId:'cut',coverage:{domains:{news:{count:100}}}};
    if(method==='evidence')return {items:[{evidenceId:'coverage:cut',domain:'coverage',publicationEligibility:{eligible:true}}]};
    if(method==='runControl')return {status:'running'};return {};
  },opencode:{session:async()=>({id:'session'}),messages:async()=>({data:[]}),prompt:async(_id,{text})=>{prompt=text;},progress:async()=>({idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',text:'Cobertura limitada [evidence:coverage:cut]',tools:[{name:'ogid_agent_evidence',operationId:'agent.evidence',status:'completed',applicationOk:true,contentRead:true,snapshotId:'cut',returnedSnapshotId:'cut'}],usage:[]})}});
  await worker.execute({jobId:'chat',fence:1,task:'contextual_chat',model:'fixture',input:{text:'¿Qué falta?'},createdAt:new Date().toISOString()});
  assert.ok(prompt.includes('Responde a la pregunta del usuario en texto'));
  for(const token of ['technicalFacts','narrativeFacts','Contrato de salida:','Ejemplo parcial de cobertura'])assert.ok(!prompt.includes(token),token);
});

test('previous typed prompt versions retain their required narrative references',()=>{
  const value=publicationExample({task:'global_intelligence_brief'},'coverage:cut');delete value.narrativeFacts;
  for(const promptVersion of ['ogid-analyst-v1.12','ogid-analyst-v1.13',PROMPT_VERSION])assert.equal(validatePublicationForJob(value,{task:value.task,promptVersion}),false);
});
