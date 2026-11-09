import {generatedBrief as generatedHistoricalBrief,returnedProposal} from './fixtures/generatedBrief.js';
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
const job={task:'global_intelligence_brief',promptVersion:'ogid-analyst-v1.24'};
const generatedBrief=value=>generatedHistoricalBrief(value,job);
const proposal=()=>({...publicationExample(job,id),summary:'Resumen de relatos atribuidos:\n'+attributed(title),narrativeFacts:[fact()],drivers:[{domain:'geopolitical',kind:'verification-plan',description:'¿Qué obligaciones contempla el posible pacto?',mechanism:'Si se confirma el relato citado, nuevas obligaciones podrían modificar la cooperación entre sus firmantes.',confirmation:'Comprobar la publicación del texto y sus obligaciones efectivas.',invalidation:'Que el texto no imponga nuevas obligaciones ni modifique la cooperación.',evidenceIds:[id]}],limitations:['Sólo se dispone del titular; no acredita aprobación ni sus efectos.']});
const check=(value,version=job.promptVersion)=>assertPublication(value,{job:{...job,promptVersion:version},snapshot,lookup:key=>key===id?source:null,now:Date.parse(asOf)});

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
test('v1.22 derives selected source references but still requires coverage for abstention and preserves historical validation',()=>{
 const selected={...generatedBrief(proposal()),evidenceIds:[]},legacy={...job,promptVersion:'ogid-analyst-v1.21'};
 for(let i=0;i<2;i++){
  assert.equal(validateGeneratedPublication(selected,job),true);
  const rendered=materializeGeneratedPublication(selected,job);assert.deepEqual(rendered.evidenceIds,[id]);check(rendered);
  assert.equal(validateGeneratedPublication(selected,legacy),false);
 }
 const absent={...generatedBrief(publicationExample(job,'coverage:fixture')),evidenceIds:[]};
 assert.equal(validateGeneratedPublication(absent,job),false);
 absent.evidenceIds=['coverage:fixture'];assert.equal(validateGeneratedPublication(absent,job),true);
 const invalid=materializeGeneratedPublication({...selected,sourceReports:[{evidenceId:id,path:'title',quote:'An unsupported claim'}]},job);
 assert.throws(()=>check(invalid),{code:'AGENT_UNVERIFIED_SOURCE_REPORT'});
});

test('source quotations remain reports and cannot turn reported prices into eligible financial observations',()=>{
 const prior=source.data.title;source.data.title='A source reports price 50';
 try{
  const p=proposal();p.summary=attributed(source.data.title);p.narrativeFacts=[fact(source.data.title)];check(p);
  const outlook={...publicationExample({task:'market_outlook_global'},id),summary:p.summary,narrativeFacts:p.narrativeFacts,direction:'up',drivers:p.drivers,scenarios:['base','bull','bear'].map(name=>({name,description:'Conditional scenario.'})),invalidation:['A contrary observation.']};
  assert.throws(()=>assertPublication(outlook,{job:{task:outlook.task,promptVersion:PROMPT_VERSION},snapshot,lookup:()=>source,now:Date.parse(asOf)}),{code:'AGENT_TECHNICAL_DATA_REQUIRED'});
 }finally{source.data.title=prior;}
});

test('v1.23+ reports missing limitations and invalid driver criteria together without changing historical wire schemas',()=>{
 const bad=generatedBrief(proposal());bad.limitations=[];bad.drivers[0].invalidation='';
 for(const version of [job.promptVersion,'ogid-analyst-v1.23','ogid-analyst-v1.22',job.promptVersion]){
  assert.equal(validateGeneratedPublication(bad,{...job,promptVersion:version}),false);
  const issues=validateGeneratedPublication.errors;
  assert.ok(issues.some(e=>e.instancePath==='/drivers/0/invalidation'&&e.keyword==='minLength'));
  assert.equal(issues.some(e=>e.instancePath==='/limitations'&&e.keyword==='minItems'),version!=='ogid-analyst-v1.22');
 }
 bad.drivers[0].invalidation=proposal().drivers[0].invalidation;
 assert.equal(validateGeneratedPublication(bad,job),false);
 assert.equal(validateGeneratedPublication(bad,{...job,promptVersion:'ogid-analyst-v1.22'}),true);
 bad.limitations=proposal().limitations;assert.equal(validateGeneratedPublication(bad,job),true);
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
 },opencode:{session:async()=>({id:'session'}),messages:async()=>({data:[]}),cancel:async()=>({interrupted:true}),prompt:async()=>{prompts++;},progress:async()=>({proposalReturns:returnedProposal(prompts===1?bad:generatedBrief(proposal()),snapshot.snapshotId),text:'',idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',usage:[],tools:[{name:'ogid_agent_evidence',status:'completed',applicationOk:true,contentRead:true,operationId:'agent.evidence',snapshotId:snapshot.snapshotId,returnedSnapshotId:snapshot.snapshotId,evidenceIds:[id]}]})}});
 await worker.execute({...job,jobId:'source-repair',scope:'global',origin:'user',fence:1,model:'llamacpp/fixture',createdAt:asOf});
 assert.deepEqual(errors,['AGENT_UNVERIFIED_SOURCE_REPORT']);assert.equal(prompts,2);assert.equal(published,1);assert.notEqual(terminal,'failed');
});

test('two unsupported source candidates consume one repair, publish nothing and finish failed after confirmed closure',async()=>{
 const bad={...generatedBrief(proposal()),sourceReports:[{evidenceId:id,path:'title',quote:'A meeting was confirmed in an invented location'}]};
 let prompts=0,published=0,cancelled=0,terminal;const attempts=[];
 const worker=new IntelligenceWorker({model:'llamacpp/fixture',call:async(method,args)=>{
  if(method==='snapshot')return snapshot;if(method==='evidence')return {items:[source],hasMore:false};if(method==='runControl')return {status:'running'};
  if(method==='publish'){try{check(args.proposal);}catch(e){attempts.push(e.code);throw e;}published++;}
  if(method==='state')terminal=args;return {};
 },opencode:{session:async()=>({id:'session'}),messages:async()=>({data:[]}),cancel:async()=>{cancelled++;return {interrupted:true};},prompt:async()=>{prompts++;},progress:async()=>({proposalReturns:returnedProposal(bad,snapshot.snapshotId),text:'',idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',usage:[],tools:[{name:'ogid_agent_evidence',status:'completed',applicationOk:true,contentRead:true,operationId:'agent.evidence',snapshotId:snapshot.snapshotId,returnedSnapshotId:snapshot.snapshotId,evidenceIds:[id]}]})}});
 await worker.execute({...job,jobId:'source-twice-rejected',scope:'global',origin:'user',fence:1,model:'llamacpp/fixture',createdAt:asOf});
 assert.deepEqual(attempts,['AGENT_UNVERIFIED_SOURCE_REPORT','AGENT_UNVERIFIED_SOURCE_REPORT']);assert.equal(prompts,2);assert.equal(cancelled,2);assert.equal(published,0);
 assert.equal(terminal.status,'failed');assert.equal(terminal.errorCode,'AGENT_UNVERIFIED_SOURCE_REPORT');assert.equal(terminal.metadata.validation.repairAttempted,true);
});

test('brief selections require actual content receipts and retain those receipts during the same single repair',async()=>{
 for(const initialRead of [false,true]){
  let prompts=0,published=0,terminal;const good=generatedBrief(proposal());
  const first=initialRead?{...good,sourceReports:[{evidenceId:id,path:'title',quote:'An unsupported source quotation'}]}:good;
  const worker=new IntelligenceWorker({model:'llamacpp/fixture',call:async(method,args)=>{
   if(method==='snapshot')return snapshot;if(method==='evidence')return {items:[source],hasMore:false};if(method==='runControl')return {status:'running'};
   if(method==='publish'){check(args.proposal);published++;}if(method==='state')terminal=args.status;return {};
  },opencode:{session:async()=>({id:'session'}),messages:async()=>({data:[]}),cancel:async()=>({interrupted:true}),prompt:async()=>{prompts++;},progress:async()=>({proposalReturns:returnedProposal(prompts===1?first:good,snapshot.snapshotId),text:'',idle:true,outcome:'succeeded',finish:'stop',messageId:'answer',usage:[],tools:[{name:'ogid_agent_evidence',status:'completed',applicationOk:true,contentRead:true,operationId:'agent.evidence',snapshotId:snapshot.snapshotId,returnedSnapshotId:snapshot.snapshotId,evidenceIds:(initialRead?prompts===1:prompts===2)?[id]:[]}]})}});
  await worker.execute({...job,jobId:'content-receipt-'+initialRead,scope:'global',origin:'user',fence:1,model:'llamacpp/fixture',createdAt:asOf});
  assert.equal(prompts,2);assert.equal(published,1);assert.notEqual(terminal,'failed');
 }
});
