import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationExample,PROMPT_VERSION,assertPublication} from '../services/agent/contracts.js';
import {generationSchemaForJob,validateGeneratedPublication,materializeGeneratedPublication} from '../services/agent/briefReports.js';
import {renderBriefVerificationPlan} from '../services/agent/briefVerificationPlans.js';

const job={task:'global_intelligence_brief',scope:'global',promptVersion:PROMPT_VERSION};
const asOf='2026-11-09T14:08:16.826Z',snapshot={asOf,coverage:{selectedInstrumentIds:[]}};
const report=(evidenceId,quote,verificationFocus='policy_scope')=>({evidenceId,path:'title',quote,verificationFocus});
const us=report('news:us-iran:2','US Sanctions Eight Canadian Money Services Businesses Tied to Iran and IRGC - Israel Defense');
const canada=report('news:canada-russia:3','Canada hits Russia with fresh sanctions targeting missile tech, cyber networks - The Times of India');
function selection(sourceReports,evidenceIds=[]){
 const {summary,limitations,contradictions,invalidation,...base}=publicationExample(job,'coverage:fixture');
 return {...base,evidenceIds,sourceReports};
}
const validate=value=>validateGeneratedPublication(value,job);

test('each selected report receives its own method without combining actors from the rejected real brief',()=>{
 const selected=selection([us,canada]);assert.equal(validate(selected),true);
 const p=materializeGeneratedPublication(selected,job);
 assert.deepEqual(p.drivers.map(d=>d.evidenceIds),[[us.evidenceId],[canada.evidenceId]]);
 assert.ok(p.drivers.every(d=>d.kind==='verification-plan'&&d.confirmation.includes('instrumento oficial')));
 assert.doesNotMatch(JSON.stringify(p.drivers),/Rusia|Rusia|Iran|Canadá|EE\. UU\./);
 assert.equal(p.sentiment,'unavailable');assert.equal(p.stability,'unavailable');assert.equal(p.probability,null);
 const evidence=new Map([us,canada].map(r=>[r.evidenceId,{evidenceId:r.evidenceId,domain:'news',availableAt:asOf,quality:{},publicationEligibility:{eligible:true},data:{title:r.quote}}]));
 assertPublication(p,{job,snapshot,lookup:id=>evidence.get(id),now:Date.parse(asOf)});
 assert.ok(p.summary.includes(us.quote)&&p.summary.includes(canada.quote));
 assert.equal(p.narrativeFacts.length,2);assert.ok(p.narrativeFacts.every(f=>!Object.hasOwn(f,'verificationFocus')));
});

test('free mixed plans, invented facts, unknown focuses and financial state are refused rather than silently repaired',()=>{
 const selected=selection([us]);
 for(const change of [{drivers:[{description:'EE. UU. y Canadá sancionan a Rusia',evidenceIds:[us.evidenceId,canada.evidenceId]}]},{summary:'A cause invented from a title'},{limitations:['coverage']},{sentiment:'neutral'},{stability:'stable'},{narrativeFacts:[{kind:'reported-claim',field:'/title',literal:us.quote,evidenceId:us.evidenceId,path:'title',quote:us.quote}]}])assert.equal(validate({...selected,...change}),false);
 const wrong={...us,verificationFocus:'invented-policy'};assert.equal(validate(selection([wrong])),false);
 assert.throws(()=>materializeGeneratedPublication(selection([wrong]),job),{code:'AGENT_INVALID_PUBLICATION'});
 assert.throws(()=>renderBriefVerificationPlan({...us,verificationFocus:'__proto__'}),RangeError);
 const falseQuote={...us,quote:'A different policy was enacted'};const p=materializeGeneratedPublication(selection([falseQuote]),job);
 assert.ok(p.summary.includes(falseQuote.quote));
 assert.throws(()=>assertPublication(p,{job,snapshot,lookup:()=>({domain:'news',availableAt:asOf,data:{title:us.quote},quality:{},publicationEligibility:{eligible:true}}),now:Date.parse(asOf)}),{code:'AGENT_UNVERIFIED_SOURCE_REPORT'});
});

test('the repeated Canadian headline lead is rejected alongside structural errors; historical schemas remain unchanged',()=>{
 const duplicate=report('news:another-canada:4','Canada hits Russia with fresh sanctions targeting 38 entities, 24 individuals - Firstpost');
 const bad=selection([canada,duplicate,us,us,us]);assert.equal(validate(bad),false);
 assert.ok(validateGeneratedPublication.errors.some(e=>e.keyword==='maxItems'));
 assert.ok(validateGeneratedPublication.errors.some(e=>e.keyword==='repeatedLead'&&e.instancePath==='/sourceReports/1/quote'&&e.params.otherIndex===0));
 const oldJob={...job,promptVersion:'ogid-analyst-v1.24'},schema=generationSchemaForJob(oldJob);
 assert.ok(schema.properties.drivers);assert.ok(schema.properties.limitations);assert.equal(schema.properties.sourceReports.items.properties.verificationFocus,undefined);
 assert.equal(validate(selection([canada,duplicate])),false);
});

test('abstention still requires the frozen coverage anchor and makes no claim that news does not exist',()=>{
 assert.equal(validate(selection([])),false);const value=selection([],['coverage:fixture']);assert.equal(validate(value),true);
 const p=materializeGeneratedPublication(value,job);assert.deepEqual(p.drivers,[]);assert.deepEqual(p.narrativeFacts,[]);
 assert.equal(p.summary,'La evidencia consultada no permite una síntesis comprobable.');
 assert.ok(p.limitations.some(t=>t.includes('no demuestra que no existan noticias')));
 assertPublication(p,{job,snapshot,lookup:id=>({evidenceId:id,domain:'coverage',availableAt:asOf,data:{},quality:{},publicationEligibility:{eligible:true}}),now:Date.parse(asOf)});
});
