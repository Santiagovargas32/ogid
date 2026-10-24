import test from 'node:test';
import assert from 'node:assert/strict';
import {numericPaths,numericFactProblem} from '../services/agent/evidencePaths.js';
import {numericNarrativeProblem} from '../services/agent/numericSemantics.js';
import {repairCatalog} from '../services/agent/repairCatalog.js';
import {IntelligenceWorker} from '../services/agent/worker.js';
import {publicationExample} from '../services/agent/contracts.js';
const data={methodVersion:'technical-context-v1',quality:{currency:'EUR',gapDetected:true},warmup:{relativeStrength:21,sma200:200},parameters:{rsiPeriod:14},sampleSize:500,observed:{close:123},indicators:{relativeStrength:{value:null,reason:'gaps_detected',sampleSize:500},rsi:{value:null,reason:'gaps_detected'}}};
test('EQQQ requirements cannot become market measurements, including prose after a fact is removed',()=>{
  const catalog=numericPaths(data);
  assert.deepEqual(catalog.paths.map(p=>p.path),['observed.close']);
  assert.ok(catalog.contextPaths.some(p=>p.path==='warmup.relativeStrength'&&p.role==='requirement'&&!p.eligible));
  assert.equal(numericFactProblem({evidenceId:'frozen',path:'warmup.relativeStrength',value:21},data).code,'AGENT_INVALID_TECHNICAL_FACT');
  const proposal={summary:'La fuerza relativa de 21 apunta al alza.',technicalFacts:[]};
  assert.equal(numericNarrativeProblem(proposal,new Map([['frozen',{data}]]))?.reason,'unverified-numeric-narrative');
});
test('typed scalar and structured indicator leaves require eligibility, exact numbers and coherent units',()=>{
  const d={quality:{currency:'EUR'},indicators:{sma:{value:123.456,reason:null,sampleSize:20},macd:{value:{macd:2,signal:1,histogram:1}},levels:{value:{support:100,resistance:130}},volatility:{value:0.2,annualizationFactor:252}}};
  for(const [path,value,unit] of [['indicators.sma.value',123.456,'EUR'],['indicators.macd.value.macd',2,'EUR'],['indicators.levels.value.support',100,'EUR']])assert.equal(numericFactProblem({evidenceId:'a',path,value,unit},d,{requireUnit:true}),null);
  for(const path of ['indicators.sma.sampleSize','indicators.volatility.annualizationFactor'])assert.ok(numericFactProblem({evidenceId:'a',path,value:path.endsWith('sampleSize')?20:252},d));
  assert.equal(numericFactProblem({evidenceId:'a',path:'indicators.sma.value',value:123.456,unit:'USD'},d).reason,'numeric-unit-mismatch');
  assert.equal(numericFactProblem({evidenceId:'a',path:'indicators.sma.value',value:123.46},d).code,'AGENT_UNVERIFIED_NUMBER');
  assert.ok(numericFactProblem({evidenceId:'a',path:'constructor.prototype',value:1},d));
  assert.ok(numericFactProblem({evidenceId:'a',path:'indicators.sma.value',value:123.456},{...d,numericSemantics:{version:'unknown'}}));
});
test('repair catalog finds the task instrument beyond the first twenty and preserves continuation',async()=>{
  const rows=Array.from({length:25},(_,i)=>({evidenceId:`canonical-${i}`,domain:'technical.get',data:{instrumentId:i===24?'asml':'other'}}));
  const call=async(_method,{domain,cursor=0,limit})=>domain==='coverage'?{items:[],hasMore:false}:{items:rows.slice(Number(cursor),Number(cursor)+limit),hasMore:Number(cursor)+limit<rows.length,nextCursor:String(Number(cursor)+limit)};
  const catalog=await repairCatalog(call,'sealed',{task:'instrument_outlook',scope:'asml'});
  assert.deepEqual(catalog.items.map(r=>r.evidenceId),['canonical-24']);assert.equal(catalog.snapshotId,'sealed');
  const partial=await repairCatalog(call,'sealed',{task:'global_intelligence_brief'},{maxBytes:300});assert.ok(partial.continuations.length);assert.ok(Buffer.byteLength(JSON.stringify(partial))<1024);
});
test('ASML invalid JSON followed by a one-character evidence error consumes one repair and publishes nothing',async()=>{
  const canonical='analysis-57c2ae8822e3dbba6f814d7c636bd937ce6a0114',altered='analysis-57c2ae8822e3dbba6f814d7c636bd937ce8a0114';
  let repairs=0,publications=0,publishAttempts=0,terminal;
  const worker=new IntelligenceWorker({model:'llamacpp/fixture',policy:{heartbeatMs:100000},call:async(method,input)=>{
    if(method==='snapshot')return {snapshotId:'sealed-asml'};
    if(method==='evidence')return {items:[{evidenceId:canonical,domain:'technical.get',data:{instrumentId:'asml'}}],hasMore:false};
    if(method==='memory')return {items:[]};if(method==='run')return {status:'running',fence:1};
    if(method==='publish'){publishAttempts++;if(input.proposal.evidenceIds.includes(altered))throw Object.assign(Error('AGENT_UNKNOWN_EVIDENCE'),{code:'AGENT_UNKNOWN_EVIDENCE',statusCode:400,details:{evidenceId:altered,reason:'not-in-snapshot'}});publications++;}
    if(method==='state')terminal=input.status;
    return {};
  },opencode:{session:async()=>({id:'fixture-session'}),messages:async()=>({data:[]}),cancel:async()=>{},prompt:async(_id,{messageId,text})=>{if(messageId.startsWith('msg_repair_')){repairs++;assert.ok(text.includes(canonical));}},progress:async(_session,_signal,id)=>({text:id.startsWith('msg_repair_')?JSON.stringify(publicationExample({task:'global_intelligence_brief'},altered)):'{} trailing',idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',usage:[],tools:[{name:'ogid_query',status:'completed',operationId:'agent.evidence',snapshotId:'sealed-asml',applicationOk:true,contentRead:true,returnedSnapshotId:'sealed-asml'}]})}});
  await worker.execute({jobId:'asml-sequence',task:'global_intelligence_brief',scope:'global',fence:1,model:'llamacpp/fixture',createdAt:new Date().toISOString()});
  assert.equal(repairs,1);assert.equal(publishAttempts,1);assert.equal(publications,0);assert.equal(terminal,'failed');
});
