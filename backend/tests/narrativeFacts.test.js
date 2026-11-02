import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPublication, publicationExample, PROMPT_VERSION, validatePublicationForJob,safeValidationDetails} from '../services/agent/contracts.js';
import {narrativeCoverageExample,narrativeProblem} from '../services/agent/narrativeFacts.js';
import {assertAnalysis} from '../services/situations/analysisSchema.js';

const asOf = '2026-10-31T12:56:13.017Z';
const snapshot = {snapshotId:'22b097be-1ce0-4c7d-9caa-c9d618b7dff5', asOf, coverage:{selectedInstrumentIds:['instrument-fixture']}};
const item = (domain, data) => ({domain,data,availableAt:asOf,quality:{},publicationEligibility:{eligible:true}});
function fixture() {
  const items = new Map([
    ['coverage:fixture',item('coverage',{domains:{news:{count:100}}})],
    ['alert:fixture:1',item('geopolitical-alert',{title:'Workers strike at 113 ports',alertId:'fixture',revision:1,publishedAt:asOf})],
    ['situation-source:20457',item('situation-source',{title:'Marathon bars him from 2026 edition',publishedAt:asOf})],
    ['technical:fixture',item('technical.get',{instrumentId:'instrument-fixture',interval:'1day',lastClosedCandleAt:asOf,quality:{currency:'USD'},observed:{close:123},warmup:{relativeStrength:21},indicators:{rsi:{value:50,reason:null}}})],
  ]);
  const p=publicationExample({task:'global_intelligence_brief'},'coverage:fixture');
  const check = value => assertPublication(value,{job:{task:value.task,promptVersion:PROMPT_VERSION},snapshot,lookup:id=>items.get(id),now:Date.parse(asOf)});
  return {p,items,check};
}
const sourceFact=(kind,field,literal,evidenceId,quote)=>({kind,field,literal,evidenceId,path:'title',quote});

test('known snapshot IDs and exact citations are opaque; unknown citations still fail',()=>{
  const {p,check}=fixture();p.summary=`Snapshot ${snapshot.snapshotId} [evidence:coverage:fixture]`;check(p);p.summary=`Snapshot ${snapshot.snapshotId}.`;check(p);
  p.summary='Referencia [evidence:foreign:1]';assert.throws(()=>check(p),{code:'AGENT_UNKNOWN_EVIDENCE'});
  p.summary='Snapshot 22b097be-1ce0-4c7d-9caa-c9d618b7dff6';assert.throws(()=>check(p),{code:'AGENT_UNVERIFIED_NUMBER'});
});
test('historical quantity and edition require frozen exact quotes with explicit attribution',()=>{
  for(const [id,quote,literal,kind] of [['alert:fixture:1','Workers strike at 113 ports','113','reported-quantity'],['situation-source:20457','Marathon bars him from 2026 edition','2026','edition']]){
    const {p,check}=fixture();p.evidenceIds.push(id);p.summary=`Según la fuente [evidence:${id}]: «${quote}»`;
    p.narrativeFacts=[sourceFact(kind,'/summary',literal,id,quote)];check(p);
    p.summary=quote;assert.throws(()=>check(p),e=>e.details.reason==='explicit-source-attribution-required');
    p.summary=`Según la fuente [evidence:${id}]: «${quote.replace(literal,'999')}»`;
    p.narrativeFacts[0].literal='999';p.narrativeFacts[0].quote=quote.replace(literal,'999');assert.throws(()=>check(p),e=>e.details.reason==='exact-source-quote-required');
  }
});
test('coverage is validated only in context and one field cannot borrow another field citation',()=>{
  const {p,check}=fixture();p.limitations=['Cobertura de 100 artículos.'];
  p.narrativeFacts=[{kind:'coverage',field:'/limitations/0',literal:'100',evidenceId:'coverage:fixture',path:'domains.news.count'}];check(p);
  p.summary=p.limitations[0];p.narrativeFacts[0].field='/summary';assert.throws(()=>check(p),e=>e.details.reason==='coverage-context-only');
  p.summary='Cobertura parcial';p.narrativeFacts[0].field='/limitations/0';p.drivers=[{domain:'macro',description:'Según la fuente [evidence:alert:fixture:1]: «Workers strike at 113 ports»',evidenceIds:['coverage:fixture']}];
  p.evidenceIds.push('alert:fixture:1');p.narrativeFacts.push(sourceFact('reported-quantity','/drivers/0/description','113','alert:fixture:1','Workers strike at 113 ports'));
  assert.throws(()=>check(p),e=>e.details.reason==='field-evidence-required');
});
test('snapshot coverage counts stay separate from the historical source-status array',()=>{
 const {p,items,check}=fixture();items.get('coverage:fixture').data=[{eventCount:7}];snapshot.coverage.domains={news:{count:100}};
 p.limitations=['Se seleccionaron 100 artículos.'];p.narrativeFacts=[{kind:'coverage',field:'/limitations/0',literal:'100',evidenceId:'coverage:fixture',path:'$snapshot.coverage.domains.news.count'}];check(p);
 p.narrativeFacts[0].path='domains.news.count';assert.throws(()=>check(p),{code:'AGENT_UNVERIFIED_NUMBER'});
});
test('coverage guidance binds the output field to the frozen manifest and numeric errors offer exact facts',()=>{
 const {p,items,check}=fixture();snapshot.coverage.domains={news:{count:100}};const coverageId='coverage:'+snapshot.snapshotId;items.set(coverageId,items.get('coverage:fixture'));p.evidenceIds.push(coverageId);Object.assign(p,narrativeCoverageExample(snapshot));check(p);
 p.summary='Precio 123.01 USD.';p.evidenceIds.push('technical:fixture');p.technicalFacts=[{evidenceId:'technical:fixture',path:'observed.close',value:123,unit:'USD'}];
 assert.throws(()=>check(p),error=>{const details=safeValidationDetails(error.details);assert.equal(details.field,'/summary');assert.deepEqual(details.technicalOptions,[p.technicalFacts[0]]);return error.code==='AGENT_UNVERIFIED_NUMBER';});
});
test('technical prose keeps exact values, units and eligibility, including multiple metrics',()=>{
  const {p,items,check}=fixture();p.evidenceIds.push('technical:fixture');p.summary='Precio 123; RSI 50.';
  p.technicalFacts=[{evidenceId:'technical:fixture',path:'observed.close',value:123,unit:'USD'},{evidenceId:'technical:fixture',path:'indicators.rsi.value',value:50,unit:'index-points'}];
  p.narrativeFacts=p.technicalFacts.map(f=>({kind:'technical',field:'/summary',literal:String(f.value),evidenceId:f.evidenceId,path:f.path}));check(p);
  items.get('technical:fixture').data.indicators.rsi.value=null;assert.throws(()=>check(p),{code:'AGENT_UNVERIFIED_NUMBER'});
  items.get('technical:fixture').data.indicators.rsi.value=50;p.technicalFacts[0].unit='EUR';assert.throws(()=>check(p),{code:'AGENT_INVALID_TECHNICAL_FACT'});
});
test('one measured value cannot impersonate another metric or currency',()=>{
 const {p,check}=fixture();p.evidenceIds.push('technical:fixture');p.technicalFacts=[{evidenceId:'technical:fixture',path:'observed.close',value:123,unit:'USD'}];p.narrativeFacts=[{kind:'technical',field:'/summary',literal:'123',evidenceId:'technical:fixture',path:'observed.close'}];
 for(const text of ['RSI 123.','Precio 123 EUR.','Precio 123%.']){p.summary=text;assert.throws(()=>check(p),{code:'AGENT_UNVERIFIED_NUMBER'});}
 p.summary='Precio 123 USD.';check(p);
});
test('equal values of distinct metrics remain independently bound in one sentence',()=>{
 const {p,items,check}=fixture();items.get('technical:fixture').data.observed.close=50;p.evidenceIds.push('technical:fixture');p.summary='Precio 50 USD; RSI 50.';
 p.technicalFacts=[{evidenceId:'technical:fixture',path:'observed.close',value:50,unit:'USD'},{evidenceId:'technical:fixture',path:'indicators.rsi.value',value:50,unit:'index-points'}];p.narrativeFacts=p.technicalFacts.map(f=>({kind:'technical',field:'/summary',literal:'50',evidenceId:f.evidenceId,path:f.path}));check(p);
 p.narrativeFacts.pop();assert.throws(()=>check(p),{code:'AGENT_UNVERIFIED_NUMBER'});
});
test('all narrative sections are guarded, with local horizons and no orphan facts',()=>{
  const {p,check}=fixture();
  for(const field of ['contradictions','invalidation','alternatives','limitations','missingEvidence']){const v=structuredClone(p);v[field]=['Dato 999'];assert.throws(()=>check(v),e=>e.details.field===`/${field}/0`);}
  p.summary='Horizonte de 24 horas';check(p);p.summary='Horizonte de 60 minutos';assert.throws(()=>check(p),{code:'AGENT_UNVERIFIED_NUMBER'});
  p.summary='Sin cifras';p.narrativeFacts=[{kind:'coverage',field:'/summary',literal:'100',evidenceId:'coverage:fixture',path:'domains.news.count'}];assert.throws(()=>check(p),e=>e.details.reason==='invalid-narrative-reference');
});
test('future, synthetic and stale sources cannot become attributed facts; dates keep their meaning',()=>{
  const {p,items,check}=fixture(),id='alert:fixture:1';p.evidenceIds.push(id);p.summary=`Según la fuente [evidence:${id}]: «${asOf}»`;
  p.narrativeFacts=[{kind:'date',field:'/summary',literal:asOf,evidenceId:id,path:'publishedAt',quote:asOf}];check(p);
  p.narrativeFacts[0].path='occurredAt';assert.throws(()=>check(p),{code:'AGENT_UNVERIFIED_NUMBER'});p.narrativeFacts[0].path='publishedAt';
  for(const [edit,code]of [[e=>e.availableAt='2026-11-01T00:00:00Z','AGENT_FUTURE_EVIDENCE'],[e=>e.quality={synthetic:true},'AGENT_SYNTHETIC_EVIDENCE'],[e=>e.quality={stale:true},'AGENT_STALE_EVIDENCE']]){const before=structuredClone(items.get(id));edit(items.get(id));assert.throws(()=>check(p),{code});items.set(id,before);}
});
test('new generation requires both arrays while historical v1.11 stays structurally compatible',()=>{
  const {p}=fixture(),job={task:p.task,promptVersion:PROMPT_VERSION};assert.equal(validatePublicationForJob(p,job),true);
  delete p.narrativeFacts;assert.equal(validatePublicationForJob(p,job),false);assert.equal(validatePublicationForJob(p,{...job,promptVersion:'ogid-analyst-v1.11'}),true);
  assert.equal(validatePublicationForJob(p,{...job,promptVersion:'ogid-analyst-v1.12'}),false);
  delete p.technicalFacts;assert.equal(validatePublicationForJob(p,job),false);
});
test('situation analysis uses the shared validator and preserves attributed-report modality',()=>{
  const {items}=fixture(),id='situation-source:20457',quote=items.get(id).data.title;
  const p={schemaVersion:'ogid-situation-analysis-v1',task:'situation_analysis',situationId:'situation-fixture',summary:'Relato atribuido.',probability:null,evidenceIds:[id],synthesis:[{text:`Según la fuente [evidence:${id}]: «${quote}»`,kind:'attributed-report',evidenceIds:[id]}],timeline:[],changes:[],impacts:[],contradictions:[],limitations:[],missingEvidence:[],technicalFacts:[],narrativeFacts:[sourceFact('edition','/synthesis/0/text','2026',id,quote)]};
  const context={job:{task:p.task,scope:p.situationId,promptVersion:PROMPT_VERSION},snapshot,lookup:id=>items.get(id),now:Date.parse(asOf)};
  assertAnalysis(p,context);p.synthesis[0].kind='observation';assert.throws(()=>assertAnalysis(p,context),e=>e.details.reason==='explicit-source-attribution-required');
});
test('directional global outlook needs eligible watchlist technique, not only an attributed quantity',()=>{
 const {p,items}=fixture();Object.assign(p,publicationExample({task:'market_outlook_global'},'alert:fixture:1'),{direction:'up',invalidation:['Cambio contrario documentado.'],drivers:[{domain:'geopolitical',description:'Relato atribuido a la fuente.',evidenceIds:['alert:fixture:1']}],scenarios:['base','bull','bear'].map(name=>({name,description:'Hipótesis condicionada.'}))});
 const job={task:p.task,promptVersion:PROMPT_VERSION},context={job,snapshot,lookup:id=>items.get(id),now:Date.parse(asOf)};
 assert.throws(()=>assertPublication(p,context),{code:'AGENT_TECHNICAL_DATA_REQUIRED'});
 p.evidenceIds.push('technical:fixture');p.technicalFacts=[{evidenceId:'technical:fixture',path:'observed.close',value:123,unit:'USD'}];assertPublication(p,context);
 assert.throws(()=>assertPublication(p,{...context,snapshot:{...snapshot,coverage:{selectedInstrumentIds:[]}}}),{code:'AGENT_TECHNICAL_DATA_REQUIRED'});
});
test('missing arrays in initial and repair candidates consume one repair and publish nothing',async()=>{
 const {IntelligenceWorker}=await import('../services/agent/worker.js');const {p}=fixture();let prompts=0,published=0,terminal;
 const initial=structuredClone(p);delete initial.technicalFacts;const repaired=structuredClone(p);delete repaired.narrativeFacts;
 const worker=new IntelligenceWorker({model:'llamacpp/fixture',call:async(method,args)=>{
  if(method==='snapshot')return snapshot;if(method==='evidence')return {items:[{evidenceId:'coverage:fixture',domain:'coverage',publicationEligibility:{eligible:true}}],hasMore:false};if(method==='memory')return {items:[]};if(method==='runControl')return {status:'running'};if(method==='publish')published++;if(method==='state')terminal=args.status;return {};
 },opencode:{session:async()=>({id:'session'}),messages:async()=>({data:[]}),cancel:async()=>{},prompt:async(_id,{text})=>{prompts++;assert.ok(text.includes('technicalFacts'));assert.ok(text.includes('narrativeFacts'));},progress:async()=>({text:JSON.stringify(prompts===1?initial:repaired),idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',usage:[],tools:[{name:'ogid_agent_evidence',status:'completed',applicationOk:true,contentRead:true,operationId:'agent.evidence',snapshotId:snapshot.snapshotId,returnedSnapshotId:snapshot.snapshotId}]})}});
 await worker.execute({jobId:'required-arrays',task:p.task,scope:'global',promptVersion:PROMPT_VERSION,fence:1,model:'llamacpp/fixture',createdAt:asOf});
 assert.equal(prompts,2);assert.equal(published,0);assert.equal(terminal,'failed');
});
test('a structural repair reuses the frozen index and does not depend on another heavy catalog read',async()=>{
 const {IntelligenceWorker}=await import('../services/agent/worker.js');const {p}=fixture();let prompts=0,reads=0,published=0;
 const initial=structuredClone(p);delete initial.technicalFacts;
 const worker=new IntelligenceWorker({model:'llamacpp/fixture',call:async(method,args)=>{
  if(method==='snapshot')return snapshot;if(method==='evidence'){reads++;if(reads>1)throw Object.assign(Error('pressure'),{code:'AGENT_RESOURCE_DEFERRED',statusCode:503});return {items:[{evidenceId:'coverage:fixture',domain:'coverage',publicationEligibility:{eligible:true}}],hasMore:false};}if(method==='memory')return {items:[]};if(method==='runControl')return {status:'running'};if(method==='publish'){published++;assert.deepEqual(args.proposal.narrativeFacts,[]);}return {};
 },opencode:{session:async()=>({id:'session'}),messages:async()=>({data:[]}),cancel:async()=>{},prompt:async()=>{prompts++;},progress:async()=>({text:JSON.stringify(prompts===1?initial:p),idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',usage:[],tools:[{name:'ogid_agent_evidence',status:'completed',applicationOk:true,contentRead:true,operationId:'agent.evidence',snapshotId:snapshot.snapshotId,returnedSnapshotId:snapshot.snapshotId}]})}});
 await worker.execute({jobId:'cached-repair',task:p.task,scope:'global',promptVersion:PROMPT_VERSION,fence:1,model:'llamacpp/fixture',createdAt:asOf});assert.equal(prompts,2);assert.equal(reads,1);assert.equal(published,1);
});

test('the single repair receives invalid references and every uncovered numeric field together',()=>{
 const {p,items}=fixture();p.summary='On 2 Nov 2026 the snapshot contains 100 items and a source reports 450.';
 p.limitations=['Only 100 items; partial coverage.'];
 p.narrativeFacts=[{kind:'reported-quantity',field:'/title',literal:'Source headline',evidenceId:'coverage:fixture',path:'data'}];
 const issue=narrativeProblem(p,items,{snapshot,job:{task:p.task,promptVersion:PROMPT_VERSION}});
 assert.equal(issue.code,'AGENT_UNVERIFIED_NUMBER');assert.equal(issue.reason,'invalid-narrative-reference');
 assert.deepEqual(issue.problems.filter(x=>x.field==='/summary').map(x=>x.providedValue),[2,2026,100,450]);
 assert.ok(issue.problems.some(x=>x.field==='/limitations/0'&&x.providedValue===100));assert.equal(issue.truncated,false);
 const safe=safeValidationDetails(issue);assert.equal(safe.problems.length,6);
 // Deleting invalid references leaves the uncovered figures invalid.
 p.narrativeFacts=[];assert.equal(narrativeProblem(p,items,{snapshot}).code,'AGENT_UNVERIFIED_NUMBER');
 p.summary='Según las fuentes consultadas, persiste incertidumbre.';p.limitations=['Cobertura parcial.'];
 assert.equal(narrativeProblem(p,items,{snapshot}),null);
});

test('numeric diagnostics remain bounded and keep invalid references from masking citation errors',()=>{
 const {p,items}=fixture();p.summary=Array.from({length:40},(_,i)=>String(i+1000)).join(' ');
 const issue=narrativeProblem(p,items,{snapshot});assert.equal(issue.problems.length,16);assert.equal(issue.truncated,true);
 p.narrativeFacts=[{kind:'reported-quantity',field:'/title',literal:'Source headline',evidenceId:'coverage:fixture',path:'data'}];
 p.summary='Unknown [evidence:foreign:12345]';assert.ok(narrativeProblem(p,items,{snapshot}).problems.some(x=>x.code==='AGENT_UNKNOWN_EVIDENCE'));
 p.narrativeFacts=[];assert.equal(narrativeProblem(p,items,{snapshot}).code,'AGENT_UNKNOWN_EVIDENCE');
});
