import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {AgentRepository} from '../storage/agentRepository.js';
import {assertAnalysis,validateAnalysis} from '../services/situations/analysisSchema.js';
import {loadAgentConfig,taskMode} from '../services/agent/config.js';
const now=Date.now(),at=new Date(now).toISOString();
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ogid-analysis-')),db=new Database(join(dir,'fixture.sqlite'));db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');migrate(db);
 const archive=new SqlNewsArchive(db,{analysisOnly:true}),runtime={db,load:()=>[],save:()=>{}},repo=new AgentRepository(runtime,{now:()=>now,debounceMs:0});
 const article=(revision=1,title='Missile strike in Kyiv')=>({id:'one',revision,contentRevision:revision,title,url:'https://reuters.com/one',publishedAt:at,receivedAt:at,archiveLastSeenAt:at,usagePolicy:'headline-only-link-out',classification:{language:'en'}});
 archive.save(article());for(let n=0;n<100&&repo.situations.status().hasMore;n++)repo.situations.processPage({budgetMs:100});
 const situationId=repo.situations.list().items[0].id;
 return {db,repo,archive,article,situationId,close(){archive.close();db.close();rmSync(dir,{recursive:true,force:true});}};
}
function start(f,requestId='first',extra={}){
 const result=f.repo.analysisRequest({requestId,situationId:f.situationId,model:'llamacpp/fixture',...extra});
 const auth={...f.repo.claim({owner:'owner',enabledTasks:['situation_analysis']}),owner:'owner'};
 assert.equal(result.jobId,auth.jobId);const snapshot=f.repo.snapshot(auth);
 const evidence=f.repo.evidence({snapshotId:snapshot.snapshotId,domain:'situation-source'}).items;
 return {auth,snapshot,evidence};
}
function proposal(f,evidence){const id=evidence[0].evidenceId;return {schemaVersion:'ogid-situation-analysis-v1',task:'situation_analysis',situationId:f.situationId,summary:'Relato atribuido a una fuente.',probability:null,evidenceIds:[id],synthesis:[{text:'La fuente relata un ataque.',kind:'attributed-report',evidenceIds:[id]}],timeline:[{text:'Publicación del relato.',occurredAt:null,publishedAt:evidence[0].data.publishedAt,knownAt:evidence[0].data.knownAt,evidenceIds:[id]}],changes:[],impacts:[],contradictions:[],limitations:['Cobertura limitada.'],missingEvidence:[],technicalFacts:[]};}
test('analysis requests replay exact input and reject conflicting reuse and foreign baseline',()=>{const f=fixture();try{
 const input={requestId:'same',situationId:f.situationId,model:'llamacpp/fixture'};
 const first=f.repo.analysisRequest(input);assert.deepEqual(f.repo.analysisRequest(input),{jobId:first.jobId,replayed:true});
 assert.throws(()=>f.repo.analysisRequest({...input,baselineAnalysisId:'different'}),{code:'AGENT_IDEMPOTENCY_CONFLICT'});
 assert.throws(()=>f.repo.analysisRequest({...input,requestId:'other',baselineAnalysisId:'different'}),{code:'AGENT_INVALID_BASELINE'});
}finally{f.close();}});
test('frozen analysis survives correction and recovery without changing original citations',()=>{const f=fixture();try{
 const {auth,snapshot,evidence}=start(f),p=proposal(f,evidence);assert.equal(validateAnalysis(p),true);
 const result=f.repo.publish({...auth,proposal:p,mode:'shadow'});
 assert.equal(f.repo.analysisDetail({id:result.publicationId}).status,'ready');
 assert.equal(f.db.prepare('SELECT count(*) n FROM situation_analysis_dependencies').get().n,1);
 assert.deepEqual(f.repo.publish({...auth,proposal:p,mode:'shadow'}),{publicationId:result.publicationId,replayed:true});
 f.archive.save(f.article(2,'Correction: earlier report withdrawn'));
 const recovered=new AgentRepository({db:f.db,load:()=>[],save:()=>{}},{now:()=>now});
 assert.equal(recovered.analysisDetail({id:result.publicationId}).status,'needs-review');
 assert.deepEqual(recovered.evidence({snapshotId:snapshot.snapshotId,domain:'situation-source'}).items,evidence);
 assert.equal(f.repo.publications({includeShadow:true}).items.length,0);assert.equal(f.repo.memory({scope:f.situationId}).items.length,0);
 const rows=f.repo.analysisSections({id:result.publicationId,section:'timeline',limit:1});assert.equal(rows.items[0].occurredAt,null);
}finally{f.close();}});
test('validation rejects invented dates, citations, numbers, identities and probability',()=>{const f=fixture();try{
 const {snapshot,evidence}=start(f),p=proposal(f,evidence),context={job:{task:p.task,scope:f.situationId},snapshot,lookup:id=>evidence.find(e=>e.evidenceId===id),now};assertAnalysis(p,context);
 for(const [edit,code]of [[p=>p.timeline[0].occurredAt=at,'AGENT_INVALID_PUBLICATION'],[p=>p.synthesis[0].evidenceIds=['situation-source:missing'],'AGENT_UNKNOWN_EVIDENCE'],[p=>p.summary='Precio 123','AGENT_UNVERIFIED_NUMBER'],[p=>p.probability=0.7,'AGENT_INVALID_PUBLICATION'],[p=>p.situationId='other','AGENT_INVALID_PUBLICATION']]){const bad=structuredClone(p);edit(bad);assert.throws(()=>assertAnalysis(bad,context),{code});}
 const stale=structuredClone(evidence[0]);stale.quality.stale=true;assert.throws(()=>assertAnalysis(p,{...context,lookup:()=>stale}),{code:'AGENT_STALE_EVIDENCE'});
}finally{f.close();}});
test('lease fences, incomplete snapshots and shadow-only results remain enforced',()=>{const f=fixture();try{
 const {auth,evidence}=start(f),p=proposal(f,evidence);
 assert.throws(()=>f.repo.publish({...auth,fence:auth.fence-1,proposal:p,mode:'shadow'}),{code:'AGENT_LEASE_LOST'});
 assert.throws(()=>f.repo.publish({...auth,proposal:p,mode:'visible'}),{code:'AGENT_INVALID_MODE'});
 f.db.prepare("UPDATE agent_snapshots SET manifest_json=json_set(manifest_json,'$.sealed',0)").run();
 assert.throws(()=>f.repo.evidence({snapshotId:f.repo.job(auth.jobId).snapshot_id}),{code:'AGENT_SNAPSHOT_BUILD_INCOMPLETE'});
}finally{f.close();}});
test('spooling, baseline and section cursors preserve stable identities',()=>{const f=fixture();try{
 const {auth,evidence}=start(f),p=proposal(f,evidence);p.synthesis.push({...p.synthesis[0],text:'Segundo relato atribuido.'});const result=f.repo.publish({...auth,proposal:p,mode:'shadow'});
 const first=f.repo.analysisSections({id:result.publicationId,section:'synthesis',limit:1});assert.equal(first.hasMore,true);
 assert.equal(f.repo.analysisSections({id:result.publicationId,section:'synthesis',cursor:first.nextCursor,limit:1}).items.length,1);
 assert.throws(()=>f.repo.analysisSections({id:result.publicationId,section:'timeline',cursor:first.nextCursor}),{code:'AGENT_INVALID_CURSOR'});
 const request=f.repo.analysisRequest({requestId:'second',situationId:f.situationId,baselineAnalysisId:result.publicationId,model:'llamacpp/fixture'});
 const next={...f.repo.claim({owner:'next',enabledTasks:['situation_analysis']}),owner:'next'},rows=[];
 assert.equal(next.jobId,request.jobId);const prepared=f.repo.prepareSnapshot(next,{rowSink:(table,row)=>rows.push({table,row})});assert.equal(prepared.rows.evidence.length,rows.length);assert.ok(rows.some(r=>r.row[1]==='analysis-baseline'));
}finally{f.close();}});
test('new task requires explicit opt-in shadow',()=>{
 assert.equal(taskMode(loadAgentConfig({AGENT_MODE:'visible'}),'situation_analysis'),'off');
 assert.equal(taskMode(loadAgentConfig({AGENT_MODE:'shadow',AGENT_TASK_MODES:'{"situation_analysis":"shadow"}'}),'situation_analysis'),'shadow');
 assert.equal(taskMode(loadAgentConfig({AGENT_MODE:'visible',AGENT_TASK_MODES:'{"situation_analysis":"visible"}'}),'situation_analysis'),'off');
});
test('HTTP and operator MCP use real writer/query lanes, nested path authorization and private evidence',async()=>{
 const {createAppServer}=await import('../server.js');const {createReadClient}=await import('../../integrations/ogid-mcp/src/client.js');const {loadConfig}=await import('../../integrations/ogid-mcp/src/config.js');
 const f=fixture(),file=f.db.name,situationId=f.situationId,token='fixture_'+'a'.repeat(40);f.archive.close();f.db.close();
 const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:file},news:{providers:[],rssFeeds:[]},market:{enabled:false,provider:'',historyPersist:false,tickers:[]},security:{allowLocalAdmin:false},agent:{mode:'shadow',backgroundModel:'llamacpp/fixture',taskModes:{situation_analysis:'shadow'}},mcpOperatorCredentials:[{token,scopes:['analyst:read','analyst:write']}]});
 try{
  await runtime.start();const baseUrl='http://127.0.0.1:'+runtime.server.address().port;
  const client=createReadClient({...loadConfig({}),baseUrl,profile:'operator',operatorCredential:{token,scopes:['analyst:read','analyst:write']}});
  assert.equal((await fetch(baseUrl+'/api/admin/situation-analyses')).status,401);
  const created=await client.operation('analyst.request',{}, {requestId:'http',situationId});
  const auth={...await runtime.app.locals.agentCall('claim',{owner:'fixture-http',enabledTasks:['situation_analysis']}),owner:'fixture-http'};assert.equal(created.jobId,auth.jobId);
  const snapshot=await runtime.app.locals.agentCall('snapshot',auth),evidence=(await runtime.app.locals.agentCall('evidence',{snapshotId:snapshot.snapshotId,domain:'situation-source'})).items;
  const result=await runtime.app.locals.agentCall('publish',{...auth,proposal:proposal({situationId},evidence),mode:'shadow'});
  const detail=await client.operation('analyst.detail',{},undefined,{id:result.publicationId});assert.equal(detail.status,'ready');
  const section=await client.operation('analyst.sections',{section:'synthesis'},undefined,{id:result.publicationId});assert.equal(section.items[0].kind,'attributed-report');
  const forbidden=await fetch(baseUrl+'/api/agent/v1/evidence?snapshotId='+snapshot.snapshotId);assert.equal(forbidden.status,401);
  const forged=await fetch(baseUrl+`/api/admin/situation-analyses/${result.publicationId}/sections?section=synthesis`,{headers:{Authorization:'Bearer '+token,'x-ogid-mcp-operation':'analyst.detail'}});assert.equal(forged.status,403);
  const list=await client.operation('analyst.list',{situationId});assert.equal(list.items.length,1);assert.equal(list.jobs[0].status,'completed');
 }finally{await runtime.stop();rmSync(join(file,'..'),{recursive:true,force:true});}
});
test('numeric impacts require exact eligible values and matching citations; series corrections invalidate frozen inputs',()=>{const f=fixture();try{
 const instrumentId='us-equity-general-dynamics';
 f.db.prepare("UPDATE situation_evidence SET payload_json=json_set(payload_json,'$.instrumentIds',json(?))").run(JSON.stringify([instrumentId]));
 const technical={instrumentId,interval:'1day',methodVersion:'technical-context-v1',seriesRevision:'series-one',observed:{close:123},quality:{currency:'USD'}};
 f.db.prepare('INSERT INTO analysis_runs VALUES(?,?,?,?,?,?,?,?)').run('technical-one','technical.get','technical-context-v1',at,at,'hash','observed',JSON.stringify(technical));
 const {auth,snapshot,evidence}=start(f),item=f.repo.evidence({snapshotId:snapshot.snapshotId,domain:'technical.get'}).items[0];assert.equal(item.data.observed.close,123);
 const p=proposal(f,evidence);p.evidenceIds.push(item.evidenceId);p.technicalFacts=[{evidenceId:item.evidenceId,path:'observed.close',value:123,unit:'USD'}];p.impacts=[{text:'Precio observado 123.',evidenceIds:[evidence[0].evidenceId,item.evidenceId],channel:'instrument',instrumentId,mechanism:'Canal propuesto sujeto a evidencia.',confirmation:'Observar evolución posterior.',invalidation:'Ausencia de transmisión.',kind:'hypothesis'}];
 const context={job:{task:p.task,scope:f.situationId},snapshot,lookup:id=>id===item.evidenceId?item:evidence.find(e=>e.evidenceId===id),now};assertAnalysis(p,context);
 const wrong=structuredClone(p);wrong.technicalFacts[0].value=124;assert.throws(()=>assertAnalysis(wrong,context),{code:'AGENT_UNVERIFIED_NUMBER'});
 const result=f.repo.publish({...auth,proposal:p,mode:'shadow'});assert.equal(f.repo.analysisDetail({id:result.publicationId}).status,'ready');
 f.db.prepare("UPDATE analysis_runs SET payload_json=json_set(payload_json,'$.seriesRevision','series-two')").run();assert.equal(f.repo.analysisDetail({id:result.publicationId}).status,'needs-review');
}finally{f.close();}});

test('coverage citations are rejected structurally before generation repair',()=>{const f=fixture();try{
 const {evidence,snapshot}=start(f),p=proposal(f,evidence);p.synthesis[0].evidenceIds=[`coverage:${snapshot.snapshotId}`];
 assert.equal(validateAnalysis(p),false);assert.ok(validateAnalysis.errors.some(e=>e.keyword==='pattern'));
 assert.equal(f.repo.evidence({snapshotId:snapshot.snapshotId,domain:'coverage'}).items[0].data.citationRole,'coverage-only; never claim evidence');
}finally{f.close();}});
