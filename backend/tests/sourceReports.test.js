import {generatedBrief} from './fixtures/generatedBrief.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPublication,publicationExample,PROMPT_VERSION,validatePublicationForJob} from '../services/agent/contracts.js';
import {IntelligenceWorker} from '../services/agent/worker.js';
import {validateGeneratedPublication,materializeGeneratedPublication} from '../services/agent/briefReports.js';

const asOf='2026-11-06T20:25:12.994Z',snapshot={snapshotId:'snapshot-source-reports',asOf,coverage:{selectedInstrumentIds:[]}};
const id='news:source:1',title='Will the parliament approve the defence pact with B?';
const source={evidenceId:id,domain:'news',availableAt:asOf,data:{title},quality:{},publicationEligibility:{eligible:true}};
const attributed=quote=>`Según la fuente [evidence:${id}]: «${quote}»`;
const fact=(quote=title)=>({kind:'reported-claim',field:'/summary',literal:quote,evidenceId:id,path:'title',quote});
const job={task:'global_intelligence_brief',promptVersion:PROMPT_VERSION};
const proposal=()=>({...publicationExample(job,id),summary:'Resumen de relatos atribuidos:\n'+attributed(title),narrativeFacts:[fact()],drivers:[{domain:'geopolitical',kind:'verification-plan',description:'¿Qué obligaciones contempla el posible pacto?',mechanism:'Si se confirma el relato citado, nuevas obligaciones podrían modificar la cooperación entre sus firmantes.',confirmation:'Comprobar la publicación del texto y sus obligaciones efectivas.',invalidation:'Que el texto no imponga nuevas obligaciones ni modifique la cooperación.',evidenceIds:[id]}],limitations:['Sólo se dispone del titular; no acredita aprobación ni sus efectos.']});
const check=(value,version=PROMPT_VERSION)=>assertPublication(value,{job:{...job,promptVersion:version},snapshot,lookup:key=>key===id?source:null,now:Date.parse(asOf)});

test('a source-backed brief preserves the full supplied question and separates interpretation',()=>{
 const p=proposal();check(p);
 p.summary='The parliament approved a pact with C in the capital [evidence:'+id+']';p.narrativeFacts=[];
 assert.throws(()=>check(p),e=>e.code==='AGENT_UNVERIFIED_SOURCE_REPORT'&&e.details.reason==='brief-reports-only');
 // Reading a historical result does not silently impose the new contract.
 check(p,'ogid-analyst-v1.17');
});

test('brief source selection renders exact reports and refuses free factual summaries or silent quote correction',()=>{
 const selected=generatedBrief(proposal());assert.equal(validateGeneratedPublication(selected,job),true);
 const rendered=materializeGeneratedPublication(selected,job);check(rendered);
 assert.equal(rendered.summary,'Resumen de relatos atribuidos:\n'+attributed(title));
 assert.equal('sourceReports'in rendered,false);assert.equal('summary'in selected,false);
 assert.equal(validateGeneratedPublication({...selected,summary:'An invented cause'},job),false);
 const wrong={...selected,sourceReports:[{evidenceId:id,path:'title',quote:'A different pact was signed'}]};
 const bad=materializeGeneratedPublication(wrong,job);assert.ok(bad.summary.includes(wrong.sourceReports[0].quote));
 assert.throws(()=>check(bad),e=>e.code==='AGENT_UNVERIFIED_SOURCE_REPORT'&&e.details.reason==='complete-source-field-required');
});

test('dropping questions or appending unsupported actors cannot be repaired by a plausible citation or duplicated reference',()=>{
 const p=proposal(),short='the parliament approve the defence pact with B';
 p.summary=attributed(short);p.narrativeFacts=[fact(short)];
 assert.throws(()=>check(p),e=>e.details.reason==='complete-source-field-required');
 Object.assign(p,proposal());p.summary+=' The other party is C.';p.narrativeFacts.push(fact());
 assert.throws(()=>check(p),e=>e.details.reason==='brief-reports-only');
 Object.assign(p,proposal());delete p.drivers[0].kind;
 assert.throws(()=>check(p),e=>e.details.reason==='brief-interpretation-must-be-labelled');
});

test('source quotations remain reports and cannot turn reported prices into eligible financial observations',()=>{
 const prior=source.data.title;source.data.title='A source reports price 50';
 try{
  const p=proposal();p.summary=attributed(source.data.title);p.narrativeFacts=[fact(source.data.title)];check(p);
  const outlook={...publicationExample({task:'market_outlook_global'},id),summary:p.summary,narrativeFacts:p.narrativeFacts,direction:'up',drivers:p.drivers,scenarios:['base','bull','bear'].map(name=>({name,description:'Conditional scenario.'})),invalidation:['A contrary observation.']};
  assert.throws(()=>assertPublication(outlook,{job:{task:outlook.task,promptVersion:PROMPT_VERSION},snapshot,lookup:()=>source,now:Date.parse(asOf)}),{code:'AGENT_TECHNICAL_DATA_REQUIRED'});
 }finally{source.data.title=prior;}
});

test('a source report outside its field references or using stale evidence is rejected',()=>{
 const p=proposal();p.evidenceIds=['coverage:only'];
 assert.throws(()=>check(p),{code:'AGENT_UNKNOWN_EVIDENCE'});
 p.evidenceIds=[id];source.quality.stale=true;
 try{assert.throws(()=>check(p),{code:'AGENT_STALE_EVIDENCE'});}finally{delete source.quality.stale;}
});

test('brief interpretation requires concrete criteria without changing the cached historical schema',()=>{
 const p=proposal();assert.equal(validatePublicationForJob(p,job),true);
 delete p.drivers[0].confirmation;
 assert.equal(validatePublicationForJob(p,{...job,promptVersion:'ogid-analyst-v1.18'}),true);
 assert.equal(validatePublicationForJob(p,job),false);
 assert.equal(validatePublicationForJob(p,{...job,promptVersion:'ogid-analyst-v1.18'}),true);
 assert.equal(validatePublicationForJob({...proposal(),drivers:[]},job),false);
 const absent=publicationExample(job,id);assert.equal(validatePublicationForJob(absent,job),true);
});

test('the existing single repair can correct an unsupported qualitative report without publishing the rejected draft',async()=>{
 const bad={...generatedBrief(proposal()),sourceReports:[{evidenceId:id,path:'title',quote:'A meeting is scheduled in a new location'}]};
 let prompts=0,published=0,terminal;const errors=[];
 const worker=new IntelligenceWorker({model:'llamacpp/fixture',call:async(method,args)=>{
  if(method==='snapshot')return snapshot;if(method==='evidence')return {items:[source],hasMore:false};if(method==='runControl')return {status:'running'};
  if(method==='publish'){try{check(args.proposal);}catch(e){errors.push(e.code);throw e;}published++;}
  if(method==='state')terminal=args.status;return {};
 },opencode:{session:async()=>({id:'session'}),messages:async()=>({data:[]}),cancel:async()=>{},prompt:async()=>{prompts++;},progress:async()=>({text:JSON.stringify(prompts===1?bad:generatedBrief(proposal())),idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',usage:[],tools:[{name:'ogid_agent_evidence',status:'completed',applicationOk:true,contentRead:true,operationId:'agent.evidence',snapshotId:snapshot.snapshotId,returnedSnapshotId:snapshot.snapshotId,evidenceIds:[id]}]})}});
 await worker.execute({...job,jobId:'source-repair',scope:'global',origin:'user',fence:1,model:'llamacpp/fixture',createdAt:asOf});
 assert.deepEqual(errors,['AGENT_UNVERIFIED_SOURCE_REPORT']);assert.equal(prompts,2);assert.equal(published,1);assert.notEqual(terminal,'failed');
});

test('brief selections require actual content receipts and retain those receipts during the same single repair',async()=>{
 for(const initialRead of [false,true]){
  let prompts=0,published=0,terminal;const good=generatedBrief(proposal());
  const first=initialRead?{...good,sourceReports:[{evidenceId:id,path:'title',quote:'An unsupported source quotation'}]}:good;
  const worker=new IntelligenceWorker({model:'llamacpp/fixture',call:async(method,args)=>{
   if(method==='snapshot')return snapshot;if(method==='evidence')return {items:[source],hasMore:false};if(method==='runControl')return {status:'running'};
   if(method==='publish'){check(args.proposal);published++;}if(method==='state')terminal=args.status;return {};
  },opencode:{session:async()=>({id:'session'}),messages:async()=>({data:[]}),cancel:async()=>{},prompt:async()=>{prompts++;},progress:async()=>({text:JSON.stringify(prompts===1?first:good),idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',usage:[],tools:[{name:'ogid_agent_evidence',status:'completed',applicationOk:true,contentRead:true,operationId:'agent.evidence',snapshotId:snapshot.snapshotId,returnedSnapshotId:snapshot.snapshotId,evidenceIds:(initialRead?prompts===1:prompts===2)?[id]:[]}]})}});
  await worker.execute({...job,jobId:'content-receipt-'+initialRead,scope:'global',origin:'user',fence:1,model:'llamacpp/fixture',createdAt:asOf});
  assert.equal(prompts,2);assert.equal(published,1);assert.notEqual(terminal,'failed');
 }
});
