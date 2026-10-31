import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import Database from "better-sqlite3";
import Ajv from "ajv";
import { migrate } from "../storage/migrate.js";
import { BusinessRuntime } from "../storage/businessRuntime.js";
import { AgentRepository } from "../storage/agentRepository.js";
import { StorageManager } from "../storage/StorageManager.js";
import {
  InferenceQueue,
  createInferenceBroker,
} from "../services/agent/broker.js";
import {
  generateOpenCodeConfig,
  validateOpenCodeConfig,
} from "../services/agent/opencodeConfig.js";
import { OpenCodeClient } from "../services/agent/opencodeClient.js";
import { IntelligenceWorker, publicationSchemaForJob } from "../services/agent/worker.js";
import { createAppServer } from "../server.js";
import { createAgentInternalClient } from "../services/agent/internalClient.js";
import { loadAgentConfig, readyModel } from "../services/agent/config.js";
import { AgentMaintenance } from "../services/agent/maintenance.js";
import { validateDeploymentEnvironment } from "../config/deploymentEnv.js";
import { projectOperation } from "../utils/researchProjection.js";
import { getOperation } from "../contracts/ogidOperations.js";
import { createHash, randomUUID } from "node:crypto";
import { AWARENESS_SOURCES } from "../services/awareness/awarenessCatalog.js";
import { assertPublication, normalizePublicationEvidence, PROMPT_VERSION } from "../services/agent/contracts.js";
test('admin observations separate historical runs and persist only bounded fenced progress',()=>{
 const f=fixture();try{
  const auth={...job(f),owner:'owner'};f.advance(2000);const since=new Date(f.clock()).toISOString();
  f.repo.heartbeat({...auth,progress:{phase:'inference',toolsCompleted:3,lastProgressAt:since,outputCharacters:200,privateText:'PRIVATE',prompt:'PRIVATE'}});
  const s=f.repo.status({since});assert.equal(s.sinceCounts.length,0);assert.equal(s.publicationCount,0);assert.equal(s.recentJobs[0].jobId,auth.jobId);
  assert.equal(s.runs[0].metadata.toolsCompleted,3);assert.equal(JSON.stringify(s).includes('PRIVATE'),false);
  assert.throws(()=>f.repo.heartbeat({...auth,fence:auth.fence-1,progress:{toolsCompleted:99}}),{code:'AGENT_LEASE_LOST'});
  assert.equal(f.repo.status({since}).runs[0].metadata.toolsCompleted,3);
 }finally{f.close();}
});
test('each job output schema pins the task and exact instrument identity without changing the shared contract',()=>{
 const ajv=new Ajv({strict:false}),instrument=ajv.compile(publicationSchemaForJob({task:'instrument_outlook',scope:'yahoo-msft-fixture'}));
 const p={...proposal(['coverage:fixture']),task:'instrument_outlook',instrumentId:'yahoo-msft-fixture',drivers:[],scenarios:[],alternatives:[],missingEvidence:['No prices'],target:'absolute-return-direction; first available daily close after 24h',methods:{sentiment:'qualitative-evidence-synthesis-v1',stability:'qualitative-watchlist-v1'},intradayScenarios:[{horizonMinutes:60,interval:'1h',direction:'unavailable',summary:'No candles',evidenceIds:[],invalidation:[],evaluation:'unavailable'}]};
 assert.equal(instrument(p),true);assert.equal(instrument({...p,instrumentId:'MSFT'}),false);
 const {instrumentId,...missingIdentity}=p;assert.equal(instrument(missingIdentity),false);
 const brief=ajv.compile(publicationSchemaForJob({task:'global_intelligence_brief',scope:'global'}));
 assert.equal(brief(proposal(['coverage:fixture'])),true);assert.equal(brief({...proposal(['coverage:fixture']),task:'geopolitical_alert_assessment'}),false);
});

test('slash fact paths normalize deterministically while exact values and unsafe paths remain rejected',()=>{
 const at=new Date().toISOString(),item={availableAt:at,quality:{},data:{indicators:{rsi:{value:57.32777039882956}},samples:[{close:123}]}};
 for(const path of ['data/indicators/rsi/value','/data/indicators/rsi/value','/indicators/rsi/value','indicators/rsi/value']){
  const original={...proposal(['technical-fixture']),technicalFacts:[{evidenceId:'technical-fixture',path,value:item.data.indicators.rsi.value}]};
  const normalized=normalizePublicationEvidence(original);assert.equal(normalized.technicalFacts[0].path,'indicators.rsi.value');assert.equal(original.technicalFacts[0].path,path);
  assert.deepEqual(normalizePublicationEvidence(normalized),normalized);
  assertPublication(normalized,{job:{task:normalized.task},snapshot:{asOf:at},lookup:()=>item});
  normalized.technicalFacts[0].value=57.33;assert.throws(()=>assertPublication(normalized,{job:{task:normalized.task},snapshot:{asOf:at},lookup:()=>item}),{code:'AGENT_UNVERIFIED_NUMBER'});
 }
 for(const [path,value,code]of [['data/samples/0/close',123,'AGENT_INVALID_TECHNICAL_FACT'],['data/constructor/prototype/value',1,'AGENT_INVALID_TECHNICAL_FACT'],['data/missing/value',1,'AGENT_UNVERIFIED_NUMBER']]){
  const normalized=normalizePublicationEvidence({...proposal(['technical-fixture']),technicalFacts:[{evidenceId:'technical-fixture',path,value}]});
  const check=()=>assertPublication(normalized,{job:{task:normalized.task},snapshot:{asOf:at},lookup:()=>item});if(code)assert.throws(check,{code});else check();
 }
});

test("numeric validation keeps exact equality and returns only the frozen correction for a wrong value or path",()=>{
 const at=new Date().toISOString(),item={availableAt:at,quality:{},data:{observed:{close:123.456789},private:'not-in-error'}};
 for(const [path,value,expected]of [['observed.close',123.46,123.456789],['data.observed.close',123.456789,null]]){
  const p={...proposal(['technical-fixture']),technicalFacts:[{evidenceId:'technical-fixture',path,value}]};
  assert.throws(()=>assertPublication(p,{job:{task:p.task},snapshot:{asOf:at},lookup:()=>item}),e=>e.code==='AGENT_UNVERIFIED_NUMBER' && e.details.expectedValue===expected && !JSON.stringify(e.details).includes('not-in-error'));
 }
 const p={...proposal(['technical-fixture']),technicalFacts:[{evidenceId:'technical-fixture',path:'observed.close',value:123.456789}]};
 assert.equal(assertPublication(p,{job:{task:p.task},snapshot:{asOf:at},lookup:()=>item}),p);
});

test("numeric repair details survive internal HTTP without reflecting unrelated server fields",async()=>{
 const client=createAgentInternalClient({baseUrl:'http://127.0.0.1:3000',token:'fixture',fetchImpl:async()=>Response.json({error:{code:'AGENT_UNVERIFIED_NUMBER',details:{evidenceId:'technical-fixture',path:'observed.close',expectedValue:123.456789,reason:'exact-value-required',apiKey:'PRIVATE'}}},{status:400})});
 await assert.rejects(client('publish'),e=>e.details.expectedValue===123.456789 && !JSON.stringify(e.details).includes('PRIVATE'));
});

test("unknown citations identify the missing snapshot ID through the internal client without accepting it",async()=>{
 const at=new Date().toISOString(),id='news:missing:1';
 assert.throws(()=>assertPublication(proposal([id]),{job:{task:'global_intelligence_brief'},snapshot:{asOf:at},lookup:()=>null}),e=>e.code==='AGENT_UNKNOWN_EVIDENCE' && e.details.evidenceId===id);
 const client=createAgentInternalClient({baseUrl:'http://127.0.0.1:3000',token:'fixture',fetchImpl:async()=>Response.json({error:{code:'AGENT_UNKNOWN_EVIDENCE',details:{evidenceId:id,reason:'not-in-snapshot',secret:'PRIVATE'}}},{status:400})});
 await assert.rejects(client('publish'),e=>e.code==='AGENT_UNKNOWN_EVIDENCE' && e.details.evidenceId===id && !JSON.stringify(e.details).includes('PRIVATE'));
});

test("queued old prompts are superseded without creating inference while active runs keep their identity",()=>{
 const f=fixture();try{
  const active=job(f),old=f.repo.enqueue({task:'instrument_outlook',scope:'fixture-scope',model:'llamacpp/fixture',key:'old-prompt',priority:10});
  f.db.prepare("UPDATE agent_jobs SET prompt_version='ogid-analyst-v1.1' WHERE job_id=?").run(old.jobId);
  const next=f.repo.claim({owner:'new-owner'});assert.equal(next,null);
  assert.equal(f.repo.run({jobId:old.jobId,internal:true}).status,'superseded');assert.equal(f.repo.run({jobId:active.jobId,internal:true}).fence,active.fence);
 }finally{f.close();}
});

test('an interrupted old generation requires its fenced cancellation ACK before a fresh contract job is admitted',()=>{
 const f=fixture();try{
  const old=job(f);f.repo.snapshot(old);f.repo.link({...old,opencodeId:'ses-old-contract'});
  f.db.prepare("UPDATE agent_jobs SET prompt_version='ogid-analyst-v1.8' WHERE job_id=?").run(old.jobId);
  f.repo.state({...old,status:'incomplete',errorCode:'AGENT_EXECUTION_UNCERTAIN'});
  assert.throws(()=>f.repo.resume({jobId:old.jobId}),{code:'AGENT_RECONCILIATION_DENIED'});
  const ticket=f.repo.interruptClaim(old);assert.ok(ticket);
  assert.throws(()=>f.repo.cancelAcknowledged({...old,fence:old.fence-1,...ticket}),{code:'AGENT_LEASE_LOST'});
  f.repo.cancelAcknowledged({...old,...ticket});
  const replacement=f.repo.resume({jobId:old.jobId});assert.equal(replacement.superseded,true);
  const next=f.repo.claim({owner:'new-owner'});assert.equal(next,null);
  assert.equal(f.repo.run({jobId:old.jobId,internal:true}).status,'superseded');assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_runs WHERE job_id=?').get(old.jobId).n,1);
  assert.throws(()=>f.repo.resume({jobId:old.jobId}),{code:'AGENT_RECONCILIATION_DENIED'});
 }finally{f.close();}
});

test('admin activity bounds payloads and joins the current fence for fifty recent jobs',()=>{
 const f=fixture();try{
  const active=job(f);f.repo.heartbeat({...active,progress:{phase:'inference',toolsCompleted:2,evidenceReads:1}});
  for(let i=0;i<55;i++){f.advance(1);f.repo.enqueue({task:'global_intelligence_brief',model:'llamacpp/fixture',key:'bounded-'+i});}
  const status=f.repo.status({since:new Date(f.clock()-10000).toISOString()});
  assert.equal(status.recentJobs.length,50);assert.equal(status.runs.length,1);assert.equal(status.runs[0].jobId,active.jobId);assert.equal(status.runs[0].fence,active.fence);assert.equal(status.runs[0].metadata.evidenceReads,1);assert.ok(Buffer.byteLength(JSON.stringify(status))<=1048576);
  f.db.prepare('UPDATE agent_jobs SET fence=fence+1 WHERE job_id=?').run(active.jobId);assert.equal(f.repo.status().runs.length,0,'an older fence must never describe the current attempt');
 }finally{f.close();}
});

test("reader recovery leaves admitted jobs queued and claims resume only when evidence is available",async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-claim-reader-')),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(dir,'test.sqlite')});
 try{
  await manager.start();const call=(method,args={})=>manager.request('agent.call',{method,args});
  const queued=await call('enqueue',{task:'global_intelligence_brief',scope:'global',model:'llamacpp/fixture',key:randomUUID(),priority:10});
  const reader=manager.analysisManager;reader.state='failed';
  for(let n=0;n<3;n++)await assert.rejects(call('claim',{owner:'waiting-worker'}),{code:'STORAGE_ANALYSIS_UNAVAILABLE'});
  const row=await manager.localRequest('agent.call',{method:'run',args:{jobId:queued.jobId,internal:true}});assert.equal(row.status,'queued');
  reader.state='ready';const claimed=await call('claim',{owner:'waiting-worker'});assert.equal(claimed.jobId,queued.jobId);
 }finally{manager.analysisManager.state='ready';await manager.close();rmSync(dir,{recursive:true,force:true});}
});

test("snapshot preparation uses a physical reader and fenced batches, preserving writes and hiding partial bundles",async t=>{
 for(const cancel of [false,true]){
  const dir=mkdtempSync(join(tmpdir(),'ogid-snapshot-reader-'));
  const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(dir,'test.sqlite')});
  let release,announce,pending;
  const barrier=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{announce=resolve;});
  try{
   await manager.start();await manager.request('domain.configure',{rootDir:dir,news:{},rss:{rssFeeds:[]}});
   const call=(method,args={})=>manager.request('agent.call',{method,args});
   const articles=Array.from({length:1000},(_,i)=>({id:`frozen-${i}`,title:`Frozen source ${i}`,url:`https://fixture.invalid/${i}`,publishedAt:new Date().toISOString(),provider:'rss'}));
   await manager.request('domain.call',{service:'news',method:'ingest',args:[articles]});
   const queued=await call('enqueue',{task:'global_intelligence_brief',scope:'global',model:'llamacpp/fixture',key:randomUUID(),priority:10});
   const claimed=await call('claim',{owner:'snapshot-owner'}),auth={jobId:queued.jobId,owner:'snapshot-owner',fence:claimed.fence};
   const local=manager.localRequest.bind(manager);let snapshotId,pages=0;
   t.mock.method(manager,'localRequest',(operation,input,options)=>{
    if(operation==='analysis.persist' && input.type==='agent-snapshot' && input.input.phase==='page'){
     pages++;assert.ok(input.input.rows.length<=100);
     if(pages===1){snapshotId=input.input.snapshotId;announce();return barrier.then(()=>local(operation,input,options));}
    }
    return local(operation,input,options);
   });
   pending=call('snapshot',auth);await entered;
   let timer;
   try{
    const feed=await Promise.race([manager.request('domain.call',{service:'news',method:'getFeed',args:[{limit:5}]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('interactive read blocked by snapshot')),5000);})]);
    assert.equal(feed.meta.scannedCount,1000);assert.equal(manager.queryManager.getStatus().queryOnly,true);
   }finally{clearTimeout(timer);}
   assert.equal((await manager.request('runtime.save',{kind:'snapshot-write-isolation',payload:{saved:true}})).persisted,true);
   await call('heartbeat',auth);
   await assert.rejects(local('agent.call',{method:'evidence',args:{snapshotId}}),{code:'AGENT_SNAPSHOT_BUILD_INCOMPLETE'});
   if(cancel)await call('cancel',{jobId:queued.jobId,internal:true});
   else await manager.request('domain.call',{service:'news',method:'ingest',args:[[{...articles[0],title:'Later revised source'}]]});
   release();
   if(cancel){await assert.rejects(pending,{code:'AGENT_LEASE_LOST'});await assert.rejects(call('evidence',{snapshotId}),{code:'AGENT_SNAPSHOT_BUILD_INCOMPLETE'});}
   else{
    const snapshot=await pending;assert.equal(snapshot.coverage.sealed,true);assert.equal(snapshot.coverage.domains.news.count,1000);assert.ok(pages>3);
    assert.ok(pages<=40,'distinct clusters and members must remain batched instead of creating one commit per row');
    const items=[];let cursor;
    for(;;){const evidence=await call('evidence',{snapshotId,domain:'news',limit:100,cursor});items.push(...evidence.items);if(!evidence.hasMore)break;cursor=evidence.nextCursor;}
    assert.ok(items.every(e=>e.revision===1));assert.equal(items.find(e=>e.data.url==='https://fixture.invalid/0')?.data.title,'Frozen source 0');
    const repeat=await call('snapshot',auth);assert.equal(repeat.snapshotId,snapshotId);assert.equal(repeat.coverage.sha256,snapshot.coverage.sha256);
   }
   assert.equal(manager.state,'ready');assert.equal(manager.analysisManager.getStatus().readOnlyConnection,true);assert.equal(manager.analysisManager.getStatus().queryOnly,true);
  }finally{release();await pending?.catch(()=>{});await manager.close();rmSync(dir,{recursive:true,force:true});}
 }
});

test("worker stops completed duplicate tool calls while allowing pagination and a pending call", async () => {
  for (const kind of ["repeated", "paginated", "pending"]) {
    const f = fixture();
    try {
      const j = job(f);
      let polls = 0,
        interrupted = false;
      const remote = {
        session: async (id) => ({ id }),
        messages: async () => ({ data: [] }),
        prompt: async () => {},
        cancel: async () => {
          interrupted = true;
        },
        progress: async () => {
          polls++;
          const row = f.repo.run({ jobId: j.jobId, internal: true });
          const item = f.repo.evidence({ snapshotId: row.snapshotId }).items[0];
          const done = kind !== "repeated" && polls === 5;
          return {
            idle: done,
            messageId: "answer",
            finish: "stop",
            outcome: "succeeded",
            text: done ? JSON.stringify(proposal([item.evidenceId])) : "",
            tools: [
              {
                callId: kind === "pending" ? "same-call" : `call-${polls}`,
                repeatKey:
                  kind === "paginated" ? `page-${polls}` : "same-input",
                name: "ogid_read_ogid_query",
                status: kind === "pending" && !done ? "running" : "completed",
                operationId: "agent.evidence",
                snapshotId: row.snapshotId,applicationOk:true,contentRead:true,returnedSnapshotId:row.snapshotId,
              },
            ],
            usage: [],
          };
        },
      };
      const worker = new IntelligenceWorker({
        call: async (m, a) => f.repo.call(m, a),
        opencode: remote,
        model: j.model,
        policy: { pollMs: 1, runDeadlineMs: 10000 },
      });
      worker.owner = j.owner;
      await worker.execute(j);
      const result = f.repo.run({ jobId: j.jobId, internal: true });
      assert.equal(
        result.status,
        kind === "repeated" ? "failed" : "completed",
        kind,
      );
      assert.equal(interrupted, kind === "repeated", kind);
      if (kind === "repeated") {
        assert.equal(result.errorCode, "AGENT_NO_PROGRESS");
        assert.equal(polls, 3);
      }
    } finally {
      f.close();
    }
  }
});
test("all tasks including chat execute serially without interrupting active work",async()=>{
 const queued=[{jobId:'background-one',task:'global_intelligence_brief'},{jobId:'background-two',task:'market_outlook_global'},{jobId:'chat',task:'contextual_chat'}],started=[],releases=[];
 const worker=new IntelligenceWorker({model:'llamacpp/fixture',opencode:{verify:async()=>{}},call:async(method,args)=>{
  if(['reconcileCandidates','pendingCancellations'].includes(method))return [];
  if(method==='claim'){const i=queued.findIndex(j=>!args.enabledTasks || args.enabledTasks.includes(j.task));return i<0?null:queued.splice(i,1)[0];}
  return {};
 }});
 worker.execute=async job=>{started.push(job.jobId);await new Promise(r=>releases.push(r));};
 try{await worker.tick();await worker.tick();await worker.tick();assert.deepEqual(started,['background-one']);assert.equal(queued[0].jobId,'background-two');}
 finally{for(const release of releases)release();await Promise.all(worker.tasks);}
});

test("outbox backpressure still permits queued work and remote cancellations to drain", async () => {
  const calls = [];
  const worker = new IntelligenceWorker({
    model: "llamacpp/fixture",
    call: async (method) => {
      calls.push(method);
      if (method === "consume")
        throw Object.assign(Error(), { code: "AGENT_BACKPRESSURE" });
      if (method === "reconcileCandidates") return [];
      if (method === "pendingCancellations")
        return [{ jobId: "cancelled", fence: 1, opencodeId: "remote" }];
      if (method === "interruptClaim") return { interruptId: "ticket" };
      if (method === "claim") return { jobId: "queued" };
      return {};
    },
    opencode: {
      verify: async () => {},
      cancel: async () => calls.push("remote-cancel"),
    },
  });
  worker.execute = async (job) => calls.push(`execute:${job.jobId}`);
  await worker.tick();
  await Promise.all(worker.tasks);
  assert.equal(worker.admissionError, null);
  assert.ok(!calls.includes("consume"));
  assert.ok(calls.includes("cancelAcknowledged"));
  assert.ok(calls.includes("remote-cancel"));
  assert.ok(calls.includes("execute:queued"));
});
const model = {
  alias: "fixture",
  state: "ready",
  context: 8192,
  tools: true,
  structuredOutput: true,
  serverContextVerified: true,
  probe: {
    verifiedAt: "2026-10-18T10:00:00Z",
    wireNoFixedCap: true,
    streaming: true,
    cancellation: true,
  },
};
const manifest = {
  schemaVersion: "ogid-model-catalog-v1",
  defaultModel: "llamacpp/fixture",
  models: [model],
};
test("invalid analyst configuration leaves the deterministic backend available", async () => {
  validateDeploymentEnvironment({ AGENT_MODE: "invalid" });
  const runtime = createAppServer({
    port: 0,
    host: "127.0.0.1",
    disableBackgroundRefresh: true,
    storage: { enabled: false },
    market: { provider: "", historyPersist: false },
    news: { providers: [], rssFeeds: [] },
    agent: { mode: "invalid" },
  });
  try {
    await runtime.start();
    const response = await fetch(
      `http://127.0.0.1:${runtime.server.address().port}/api/health`,
    );
    assert.equal(response.status, 200);
    assert.equal(runtime.app.locals.agentConfig.mode, "off");
    assert.equal(runtime.app.locals.agentConfig.health.state, "degraded");
  } finally {
    await runtime.stop();
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ogid-agent-")),
    db = new Database(join(dir, "test.sqlite"));
  db.pragma("journal_mode=WAL");
  db.pragma("foreign_keys=ON");
  migrate(db);
  const runtime = new BusinessRuntime(db, () => {});
  runtime.configure({ rootDir: dir, news: {}, rss: { rssFeeds: [] } });
  let now = Date.now();
  const repo = new AgentRepository(runtime, { now: () => now, debounceMs: 0 });
  return {
    dir,
    db,
    runtime,
    repo,
    clock: () => now,
    advance: (ms) => {
      now += ms;
    },
    close() {
      runtime.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const job = (f) => {
  const { jobId } = f.repo.enqueue({
    task: "global_intelligence_brief",
    model: "llamacpp/fixture",
    key: "one",
  });
  const claim = f.repo.claim({ owner: "owner" });
  assert.equal(claim.jobId, jobId);
  return { ...claim, owner: "owner" };
};
test('source corrections mark existing analyst publications for review without changing frozen citations',()=>{
 const f=fixture();try{
  const archive=f.runtime.services.news;
  archive.ingest([{title:'Missile strike in Kyiv',url:'https://reuters.com/revised-source',provider:'rss',publishedAt:new Date(f.clock()-1000).toISOString()}]);
  f.advance(1000);
  const article=archive.search({}).articles[0],auth=job(f),snapshot=f.repo.snapshot(auth),item=f.repo.evidence({snapshotId:snapshot.snapshotId,domain:'news'}).items.find(x=>x.data.id===article.id);
  assert.ok(item);f.repo.publish({...auth,proposal:proposal([item.evidenceId]),mode:'shadow'});
  const before=f.repo.publications({includeShadow:true}).items[0];assert.equal(before.sourceCurrentness.current,true);
  const frozen=f.db.prepare('SELECT payload_json FROM agent_publications').get().payload_json;
  archive.ingest([{title:'No missile strike in Kyiv',url:'https://reuters.com/revised-source',provider:'rss',publishedAt:new Date(f.clock()-1000).toISOString()}]);
  const after=f.repo.publications({includeShadow:true}).items[0];assert.equal(after.status,'needs-review');assert.equal(after.sourceCurrentness.current,false);assert.deepEqual(after.proposal.evidenceIds,before.proposal.evidenceIds);assert.equal(f.db.prepare('SELECT payload_json FROM agent_publications').get().payload_json,frozen);
 }finally{f.close();}
});
test("frozen technical lookup keeps instrument, timeframe and cutoff boundaries",()=>{
 const f=fixture();try{
  const asOf=f.clock(),at=offset=>new Date(asOf+offset).toISOString();
  for(const [instrumentId,interval,offset,marker] of [['one','1day',-600000,'old'],['one','1day',-60000,'latest-day'],['one','1day',3600000,'future'],['one','1h',-60000,'hour'],['two','1day',-60000,'second-instrument']])
   f.runtime.recordAnalysis('technical.get',{}, {instrumentId,interval,generatedAt:at(offset),marker});
  f.repo.enqueue({task:'global_intelligence_brief',model:'llamacpp/fixture',key:'scoped-technical',input:{selectedInstrumentIds:['one','two']}});
  const claim=f.repo.claim({owner:'owner'}),snapshot=f.repo.snapshot({...claim,owner:'owner'});
  const items=f.repo.evidence({snapshotId:snapshot.snapshotId,domain:'technical.get',limit:100}).items;
  assert.deepEqual(items.map(e=>e.data.marker).sort(),['hour','latest-day','second-instrument']);
 }finally{f.close();}
});

test("frozen alerts retain their exact historical sources without admitting missing or future revisions",()=>{
 const f=fixture();try{
  const at=hours=>new Date(f.clock()+hours*3600000).toISOString(),id='article-old-alert',oldId=`news:${id}:1`,futureId='news:article-future-alert:1',missingId='news:article-absent-alert:1';
  const data={id,title:'Historical source',url:'https://fixture.invalid/old',publishedAt:at(-48),receivedAt:at(-48),provider:'rss',usagePolicy:'headline-only-link-out',description:'PRIVATE BODY',fullText:'PRIVATE BODY'};
  const article=f.db.prepare("INSERT INTO articles VALUES(?,?,NULL,?,?,?, ?,1,'headline-only-link-out',?)"),revision=f.db.prepare('INSERT INTO article_revisions VALUES(?,?,?,?)');
  article.run(id,data.title,data.url,data.publishedAt,data.receivedAt,at(-48),JSON.stringify(data));
  revision.run(id,1,at(-48),JSON.stringify(data));revision.run(id,2,at(-2),JSON.stringify({...data,title:'Later corrected source',revision:2}));
  article.run('article-future-alert','Future',data.url,at(-48),at(-48),at(1),JSON.stringify({...data,id:'article-future-alert'}));
  revision.run('article-future-alert',1,at(1),JSON.stringify({...data,id:'article-future-alert'}));
  for(const alertId of ['first','duplicate-reference'])f.db.prepare('INSERT INTO geopolitical_alerts VALUES(?,1,?,?,?)').run(alertId,'fixture',at(-1),JSON.stringify({alertId,revision:1,evidenceIds:[oldId,futureId,missingId]}));
  f.repo.enqueue({task:'geopolitical_alert_assessment',model:'llamacpp/fixture',key:'alert-references',priority:10});
  const claimed={...f.repo.claim({owner:'owner'}),owner:'owner'},snap=f.repo.snapshot(claimed);assert.equal(snap.coverage.domains.news.count,0);assert.equal(snap.coverage.domains['news-reference'].count,1);
  assert.deepEqual(snap.coverage.domains['geopolitical-alert'].sourceReferences,{requested:3,resolved:1,unavailable:2});
  const historical=f.repo.evidence({snapshotId:snap.snapshotId,domain:'news-reference'}).items[0];
  assert.equal(historical.evidenceId,oldId);assert.equal(historical.revision,1);assert.equal(historical.data.title,'Historical source');assert.equal(historical.contextRole,'historical-alert-source');assert.ok(!JSON.stringify(historical).includes('PRIVATE BODY'));
  const alerts=f.repo.evidence({snapshotId:snap.snapshotId,domain:'geopolitical-alert'}).items;assert.equal(alerts.length,2);
  for(const alert of alerts){assert.deepEqual(alert.data.evidenceIds,[oldId]);assert.deepEqual(alert.data.sourceEvidenceReferences.filter(r=>!r.available).map(r=>r.evidenceId),[futureId,missingId]);}
  for(const evidenceId of [futureId,missingId])assert.throws(()=>f.repo.evidenceChunk({snapshotId:snap.snapshotId,evidenceId}),{code:'AGENT_EVIDENCE_NOT_FOUND'});
  const chunk=f.repo.evidenceChunk({snapshotId:snap.snapshotId,evidenceId:oldId,format:'utf8'});assert.equal(JSON.parse(chunk.chunk).evidenceId,oldId);
  const p={...proposal([alerts[0].evidenceId]),task:'geopolitical_alert_assessment',alertAssessments:[{alertId:alerts[0].data.alertId,revision:1,summary:'Historical alert context',evidenceIds:[oldId]}]};
  assert.throws(()=>f.repo.publish({...claimed,mode:'shadow',proposal:{...p,alertAssessments:[{...p.alertAssessments[0],evidenceIds:[missingId]}]}}),{code:'AGENT_UNKNOWN_EVIDENCE'});
  const published=f.repo.publish({...claimed,mode:'shadow',proposal:p});assert.ok(published.publicationId);
  assert.deepEqual(f.repo.publications({includeShadow:true}).items[0].proposal.evidenceIds,[alerts[0].evidenceId,oldId]);
  assert.equal(f.repo.publish({...claimed,mode:'shadow',proposal:p}).replayed,true);
  revision.run(id,3,at(-0.5),JSON.stringify({...data,title:'Third revision',revision:3}));
  assert.deepEqual(f.repo.evidence({snapshotId:snap.snapshotId,domain:'news-reference'}).items[0],historical);
 }finally{f.close();}
});

const proposal = (ids) => ({
  schemaVersion: "ogid-agent-publication-v1",
  task: "global_intelligence_brief",
  summary: "Observación atribuida, cobertura parcial.",
  direction: "unavailable",
  sentiment: "unavailable",
  stability: "unavailable",
  horizonHours: 24,
  probability: null,
  confidenceKind: "qualitative-uncalibrated",
  evidenceIds: ids,
  contradictions: [],
  invalidation: [],
  limitations: ["Cobertura parcial"],
  technicalFacts: [],
  intradayScenarios: [],
});
test("agent migration preserves old facts; snapshot keeps original revisions and recoverable long text", () => {
  const f = fixture();
  try {
    const text = "A".repeat(7000),
      url = "https://fixture.invalid/article";
    f.runtime.services.news.ingest([
      {
        id: "one",
        title: "Russia report",
        description: text,
        url,
        publishedAt: new Date().toISOString(),
        provider: "rss",
        usagePolicy: "standard-link-out",
      },
    ]);
    f.advance(1000);
    const j = job(f),
      snap = f.repo.snapshot(j),
      before = f.repo.evidence({ snapshotId: snap.snapshotId, limit: 100 });
    const original = before.items.find((i) => i.domain === "news");
    assert.ok(original);
    f.runtime.services.news.ingest([
      {
        id: "one",
        title: "Russia changed",
        description: "revision",
        url,
        publishedAt: new Date().toISOString(),
        provider: "rss",
      },
    ]);
    const after = f.repo
      .evidence({ snapshotId: snap.snapshotId, limit: 100 })
      .items.find((i) => i.domain === "news");
    assert.deepEqual(after, original);
    assert.equal(f.db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(f.db.pragma("foreign_key_check"), []);
  } finally {
    f.close();
  }
});
test("snapshot window preserves publication precedence, unknown dates and the latest revision known at cutoff", () => {
  const f = fixture();
  try {
    const at = (hours) => new Date(f.clock() + hours * 3600000).toISOString();
    const cases = [
      ["published", at(-1), at(-48)],
      ["received", null, at(-2)],
      ["old-unknown", null, at(-48)],
      ["future-publication", at(1), at(-2)],
      ["old-publication", at(-48), at(-1)],
      ["revised", at(-1), at(-2)],
      ["after-cut", at(-1), at(-2)],
    ];
    for (const [id, publishedAt, receivedAt] of cases) {
      const payload = {
        id,
        title: id,
        publishedAt,
        receivedAt,
        provider: "rss",
        usagePolicy: "standard-link-out",
      };
      f.db
        .prepare(
          "INSERT INTO articles VALUES(?,?,NULL,NULL,?,?,?,1,'standard-link-out',?)",
        )
        .run(id, id, publishedAt, receivedAt, at(-1), JSON.stringify(payload));
      f.db
        .prepare("INSERT INTO article_revisions VALUES(?,1,?,?)")
        .run(id, at(-1), JSON.stringify(payload));
      if (["revised", "after-cut"].includes(id))
        f.db
          .prepare("INSERT INTO article_revisions VALUES(?,2,?,?)")
          .run(
            id,
            id === "after-cut" ? at(1) : at(-0.5),
            JSON.stringify({ ...payload, publishedAt: at(2) }),
          );
    }
    const j=job(f),snap = f.repo.snapshot(j);
    const rows = f.repo.evidence({
      snapshotId: snap.snapshotId,
      domain: "news",
      limit: 100,
    }).items;
    assert.deepEqual(rows.map((r) => r.data.id).sort(), [
      "after-cut",
      "published",
      "received",
    ]);
    assert.ok(rows.every((r) => r.revision === 1));
    assert.equal(
      rows.find((r) => r.data.id === "received").data.publishedAt,
      null,
    );
    const instrumentId = "us-equity-general-dynamics";
    for (const id of ["published", "received"])
      f.db
        .prepare("INSERT INTO article_instruments VALUES(?,?,?)")
        .run(id, instrumentId, "{}");
    f.repo.enqueue({
      task: "instrument_outlook",
      scope: instrumentId,
      model: manifest.defaultModel,
      key: "scoped",
    });
    f.repo.cancel({...j,internal:true});
    const scoped = f.repo.claim({ owner: "scope-owner" });
    const cut = f.repo.snapshot({
      jobId: scoped.jobId,
      owner: "scope-owner",
      fence: scoped.fence,
    });
    assert.deepEqual(
      f.repo
        .evidence({ snapshotId: cut.snapshotId, domain: "news" })
        .items.map((r) => r.data.id)
        .sort(),
      ["published", "received"],
    );
  } finally {
    f.close();
  }
});
test("unlinked incomplete jobs are safely retried with a new fence and preserved audit",()=>{
 const f=fixture();try{
  const first=job(f);f.repo.state({...first,status:'incomplete',errorCode:'AGENT_INTERNAL_HTTP_503'});
  assert.ok(f.repo.reconcileCandidates().some(j=>j.jobId===first.jobId));
  f.repo.resume({jobId:first.jobId});const resumed=f.repo.claim({owner:'recovered-owner'});
  assert.equal(resumed.jobId,first.jobId);assert.equal(resumed.fence,first.fence+1);assert.equal(f.repo.reconcileCandidates().length,0);
  assert.throws(()=>f.repo.heartbeat(first),{code:'AGENT_LEASE_LOST'});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_runs WHERE job_id=?').get(first.jobId).n,2);
 }finally{f.close();}
});

test("leases fence stale owners, survive repository replacement and do not blindly replay expired inference", () => {
  const f = fixture();
  try {
    const j = job(f);
    assert.equal(
      new AgentRepository(f.runtime).claim({ owner: "other" }),
      null,
    );
    f.advance(91000);
    assert.throws(() => f.repo.heartbeat(j), { code: "AGENT_LEASE_LOST" });
    assert.equal(f.repo.claim({ owner: "other" }), null);
    assert.equal(
      f.repo.run({ jobId: j.jobId, internal: true }).status,
      "incomplete",
    );
    assert.throws(
      () => f.repo.state({ ...j, status: "completed", text: "fake" }),
      { code: "AGENT_LEASE_LOST" },
    );
  } finally {
    f.close();
  }
});
test('outbox changes do not enqueue inference or acknowledge business changes',()=>{
 const f=fixture();try{
 f.db.prepare("INSERT INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json) VALUES('one','article-revision','one',1,?,'{}')").run(new Date().toISOString());
 const before=f.db.prepare('SELECT * FROM consumer_checkpoints').all();
 for(let i=0;i<3;i++)assert.deepEqual(f.repo.consume({model:manifest.defaultModel}).jobs,[]);
 assert.equal(f.db.prepare('SELECT count(*) n FROM agent_jobs').get().n,0);assert.deepEqual(f.db.prepare('SELECT * FROM consumer_checkpoints').all(),before);
 }finally{f.close();}
});

test("publication rejects invented references and probability, commits atomically and replays once", () => {
  const f = fixture();
  try {
    const j = job(f),
      snapshot = f.repo.snapshot(j),
      page = f.repo.evidence({ snapshotId: snapshot.snapshotId }),
      p = proposal([page.items[0].evidenceId]);
    assert.throws(
      () =>
        f.repo.publish({
          ...j,
          proposal: { ...p, probability: 0.9 },
          mode: "shadow",
        }),
      { code: "AGENT_INVALID_PUBLICATION" },
    );
    assert.throws(
      () =>
        f.repo.publish({
          ...j,
          proposal: { ...p, evidenceIds: ["invented"] },
          mode: "shadow",
        }),
      { code: "AGENT_UNKNOWN_EVIDENCE" },
    );
    f.db.exec(
      "CREATE TRIGGER reject_agent_publish BEFORE INSERT ON agent_memory BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    assert.throws(
      () => f.repo.publish({ ...j, proposal: p, mode: "shadow" }),
      /injected/,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_publications").get().n,
      0,
    );
    assert.equal(
      f.repo.run({ jobId: j.jobId, internal: true }).status,
      "running",
    );
    f.db.exec("DROP TRIGGER reject_agent_publish");
    const saved = f.repo.publish({ ...j, proposal: p, mode: "shadow" });
    assert.equal(
      f.repo.publish({ ...j, proposal: p, mode: "shadow" }).replayed,
      true,
    );
    assert.equal(f.repo.publications({}).items.length, 0);
    assert.equal(
      f.repo.publications({ includeShadow: true }).items[0].publicationId,
      saved.publicationId,
    );
  } finally {
    f.close();
  }
});
test('a lease that expires during publication validation cannot commit or update memory',()=>{
 const f=fixture();try{
  const j=job(f),snapshot=f.repo.snapshot(j),id=f.repo.evidence({snapshotId:snapshot.snapshotId}).items[0].evidenceId;
  const item=f.repo.item.bind(f.repo);
  f.repo.item=row=>{const value=item(row);f.advance(90001);return value;};
  assert.throws(()=>f.repo.publish({...j,proposal:proposal([id]),mode:'shadow'}),{code:'AGENT_LEASE_LOST'});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_publications').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_memory').get().n,0);
 }finally{f.close();}
});
test('ephemeral progress requires ownership and an unexpired fence while terminal notices cannot change text',()=>{
 const f=fixture();try{
  const j=job(f);assert.equal(f.repo.progress(j).sessionId,null);
  assert.throws(()=>f.repo.progress({...j,owner:'other'}),{code:'AGENT_LEASE_LOST'});
  f.advance(90001);assert.throws(()=>f.repo.progress(j),{code:'AGENT_LEASE_LOST'});
 }finally{f.close();}
});

test("device ownership, revocation and send idempotency do not grant admin or disclose another chat", () => {
  const f = fixture();
  try {
    const a = f.repo.deviceCreate({ label: "A" }),
      b = f.repo.deviceCreate({ label: "B" }),
      s = f.repo.sessionCreate({
        deviceId: a.deviceId,
        model: "llamacpp/fixture",
      });
    const m = {
      deviceId: a.deviceId,
      sessionId: s.sessionId,
      key: "once",
      text: "Consulta",
      context: [],
    };
    const first = f.repo.send(m);
    assert.equal(f.repo.send(m).jobId, first.jobId);
    assert.throws(() => f.repo.send({ ...m, text: "different" }), {
      code: "AGENT_IDEMPOTENCY_CONFLICT",
    });
    assert.throws(() => f.repo.messages({ ...m, deviceId: b.deviceId }), {
      code: "AGENT_SESSION_NOT_FOUND",
    });
    f.repo.deviceRevoke({ deviceId: a.deviceId });
    assert.equal(f.repo.deviceAuth({ token: a.token }), null);
    assert.throws(() => f.repo.messages(m), {
      code: "AGENT_SESSION_NOT_FOUND",
    });
  } finally {
    f.close();
  }
});
test("OpenCode config validates actual v2 schema, restricts tools, rejects unknown context and old v1 fields", () => {
  const config = generateOpenCodeConfig({
    manifest,
    defaultModel: manifest.defaultModel,
    mcpCommand: ["/node", "/mcp.js"],
    toolNames: ["ogid_read_ogid_query"],
  });
  assert.equal(config.permissions[0].effect, "deny");
  assert.equal(config.mcp.servers.ogid_read.timeout.execution, 200000);
  assert.equal(config.providers.llamacpp.models.fixture.limit.context, 8192);
  assert.equal(
    validateOpenCodeConfig({ ...config, permission: { "*": "allow" } }),
    false,
  );
  assert.throws(
    () =>
      generateOpenCodeConfig({
        manifest: { models: [{ ...model, serverContextVerified: false }] },
        defaultModel: manifest.defaultModel,
        mcpCommand: ["x"],
        toolNames: ["ogid_read_ogid_query"],
      }),
    { code: "OPENCODE_MODEL_UNVERIFIED" },
  );
  assert.throws(
    () =>
      generateOpenCodeConfig({
        manifest,
        defaultModel: manifest.defaultModel,
        mcpCommand: ["x"],
        toolNames: ["ogid_read_ogid_operator"],
      }),
    { code: "OPENCODE_TOOL_ALLOWLIST_REQUIRED" },
  );
});
test("broker serializes actual HTTP streaming, strips SDK caps and preserves tools and upstream usage", async (t) => {
  let active = 0,
    max = 0;
  const bodies = [];
  const server = createInferenceBroker({
    apiKey: "upstream-fixture",
    token: "broker-fixture",
    manifest,
    contextInspector: async () => ({ tokens: 100, context: 8192 }),
    fetchImpl: async (_url, options) => {
      active++;
      max = Math.max(max, active);
      bodies.push(JSON.parse(options.body));
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"finish_reason":"stop"}],"usage":{"completion_tokens":20000}}\n\ndata: [DONE]\n\n',
              ),
            );
            await new Promise((r) => setTimeout(r, 30));
            active--;
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/health")).status, 401);
  const tool = {
    type: "function",
    function: { name: "ogid_query", parameters: { type: "object" } },
  };
  const send = async () => {
    const r = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer broker-fixture",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "A".repeat(10000) }],
        max_tokens: 1200,
        max_completion_tokens: 4096,
        tools: [tool],
        stream: true,
      }),
    });
    return r.text();
  };
  assert.ok(
    (await Promise.all([send(), send()])).every((s) => s.includes("20000")),
  );
  assert.equal(max, 1);
  assert.ok(
    bodies.every(
      (b) =>
        !("max_tokens" in b) &&
        !("max_completion_tokens" in b) &&
        b.messages[0].content.length === 10000,
    ),
  );
  assert.deepEqual(bodies[0].tools, [tool]);
});
test("queue cancellation removes waiting work and fairness ages background requests", async () => {
  const q = new InferenceQueue();
  let release;
  const first = q.run(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const c = new AbortController();
  let called = false;
  const aborted = q.run(
    () => {
      called = true;
    },
    { signal: c.signal },
  );
  c.abort();
  await assert.rejects(aborted);
  release();
  await first;
  assert.equal(called, false);
  assert.equal(q.pending.length, 0);
});
test("real StorageManager persists agent session through restart without a second business writer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogid-agent-worker-"));
  let manager;
  try {
    const opts = {
      databasePath: join(dir, "db.sqlite"),
      businessEnabled: true,
      enabled: true,
    };
    manager = new StorageManager(opts);
    await manager.start();
    await manager.request("domain.configure", {
      rootDir: dir,
      rss: { rssFeeds: [] },
    });
    const d = await manager.request("agent.call", {
      method: "deviceCreate",
      args: { label: "worker" },
    });
    await manager.close();
    manager = new StorageManager(opts);
    await manager.start();
    await manager.request("domain.configure", {
      rootDir: dir,
      rss: { rssFeeds: [] },
    });
    assert.equal(
      (
        await manager.request("agent.call", {
          method: "deviceAuth",
          args: { token: d.token },
        })
      ).deviceId,
      d.deviceId,
    );
    assert.equal(manager.analysisManager.getStatus().readOnlyConnection, true);
  } finally {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("chat HTTP uses device auth and CSRF independently of admin; retired media makes no acquisition", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ogid-agent-http-"));
  const runtime = createAppServer({
    host: "127.0.0.1",
    port: 0,
    disableBackgroundRefresh: true,
    storage: {
      enabled: true,
      businessEnabled: true,
      databasePath: join(dir, "db.sqlite"),
    },
    news: { providers: [], rssFeeds: [] },
    market: { provider: "", historyPersist: false },
    agent: { mode: "shadow", manifest, backgroundModel: manifest.defaultModel },
  });
  await runtime.start();
  t.after(async () => {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  assert.equal((await fetch(base + "/api/agent/v1/chat/sessions")).status, 401);
  const d = await fetch(base + "/api/agent/v1/access/device", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "HTTP" }),
  });
  assert.equal(d.status, 200);
  const cookie = d.headers.get("set-cookie").split(";")[0],
    auth = (await d.json()).data,
    headers = { Cookie: cookie, "Content-Type": "application/json" };
  assert.equal(
    (
      await fetch(base + "/api/agent/v1/chat/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: manifest.defaultModel }),
      })
    ).status,
    403,
  );
  headers["x-ogid-csrf"] = auth.csrf;
  const session = await fetch(base + "/api/agent/v1/chat/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: manifest.defaultModel }),
  });
  assert.equal(session.status, 201);
  assert.equal((await fetch(base + "/api/media/streams")).status, 410);
  assert.equal(runtime.mediaStreamService.getHealth().status, "retired");
  assert.ok(
    !(await fetch(base)).headers
      .get("content-security-policy")
      .includes("youtube"),
  );
});

test("OpenCode reconciles a turn across pages, ignores previous idle and never returns reasoning", async () => {
  const calls = [];
  let completed = false;
  const client = new OpenCodeClient({
    password: "fixture",
    fetchImpl: async (url) => {
      const u = new URL(url);
      calls.push(u);
      if (u.pathname.endsWith("/message"))
        return Response.json(
          u.searchParams.has("cursor")
            ? { data: [{ id: "target", type: "user" }], cursor: { next: null } }
            : {
                data: [
                  {
                    id: "answer",
                    type: "assistant",
                    time: {
                      created: 200,
                      ...(completed ? { completed: 400 } : {}),
                    },
                    finish: "stop",
                    content: [
                      { type: "reasoning", text: "PRIVATE_TRACE" },
                      { type: "text", text: "respuesta" },
                      {
                        type: "tool",
                        name: "ogid_query",
                        state: {
                          status: "completed",
                          input: {
                            operationId: "agent.evidence",
                            parameters: { snapshotId: "frozen" },
                          },
                        },
                      },
                    ],
                  },
                ],
                cursor: { next: "opaque-cursor" },
              },
        );
      return Response.json({
        data: {
          id: "session",
          time: { idle: completed ? 450 : 100 },
          outcome: "succeeded",
        },
      });
    },
  });
  const pending = await client.progress("session", undefined, "target");
  assert.equal(pending.idle, false);
  assert.equal(pending.text, "respuesta");
  assert.ok(!JSON.stringify(pending).includes("PRIVATE_TRACE"));
  completed = true;
  const done = await client.progress("session", undefined, "target");
  assert.equal(done.idle, true);
  assert.equal(done.tools[0].snapshotId, "frozen");
  assert.ok(
    calls.some(
      (u) =>
        u.searchParams.get("cursor") === "opaque-cursor" &&
        !u.searchParams.has("order"),
    ),
  );
});

test("OpenCode completed errors are terminal without session idle and expose no upstream error body",async()=>{
 const client=new OpenCodeClient({password:"fixture",fetchImpl:async url=>Response.json(new URL(url).pathname.endsWith('/message')?{data:[{id:'failed-answer',type:'assistant',time:{completed:400},finish:'error',error:{type:'tool',message:'PRIVATE_UPSTREAM_BODY'},content:[]},{id:'target',type:'user'}]}:{data:{id:'session',time:{updated:400}}})});
 const result=await client.progress('session',undefined,'target');
 assert.equal(result.idle,true);assert.equal(result.outcome,'failed');assert.equal(result.finish,'error');
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_UPSTREAM_BODY/);
});

test('OpenCode format and incomplete-stream errors in a pending native retry are terminal for the fenced owner',async()=>{
 for(const [message,cause]of [['The model produced output that does not match the expected peg-native format','LLAMACPP_OUTPUT_FORMAT'],['OGID upstream failure: BROKER_INCOMPLETE_STREAM','BROKER_INCOMPLETE_STREAM'],['Temporary connection failure',null]]){
  const client=new OpenCodeClient({password:'fixture',fetchImpl:async url=>Response.json(new URL(url).pathname.endsWith('/message')?{data:[{id:'answer',type:'assistant',retry:{attempt:1,at:200,error:{type:'provider.internal',status:200,message}},time:{created:100},content:[]},{id:'input',type:'user',time:{created:90}}]}:{data:{id:'session',time:{updated:100}}})});
  const result=await client.progress('session',undefined,'input');
  assert.equal(result.requiresInterruption,Boolean(cause));assert.equal(result.idle,Boolean(cause));
  if(cause){assert.equal(result.finish,'error');assert.equal(result.terminalError.causeCode,cause);}else assert.equal(result.terminalError,null);
  assert.ok(!JSON.stringify(result).includes('Temporary connection failure'));
 }
});

test("worker reconciles admitted IDs, repairs at most once and publishes no truncated answer", async () => {
  for (const kind of ["reconciled", "repair", "length", "invalid", "terminal-error", "terminal-uncertain", "contract-mismatch"]) {
    const f = fixture();
    try {
      const j = job(f),
        posted = [],
        admitted = new Set(
          kind === "reconciled"
            ? [`msg_ogid_${j.jobId.replaceAll("-", "")}`]
            : [],
        );
      const remote = {
        session: async (id) => ({ id }),
        messages: async () => ({
          data: [...admitted,...(kind==="reconciled"?[JSON.parse(f.db.prepare("SELECT metadata_json FROM agent_runs WHERE job_id=? AND fence=?").get(j.jobId,j.fence).metadata_json).generation.messageId]:[])].map((id) => ({ id, type: "user" })),
        }),
        cancel: async () => {if(kind==='terminal-uncertain')throw Object.assign(Error(),{code:'OPENCODE_CONNECTION'});},
        prompt: async (_, { messageId }) => {
          posted.push(messageId);
          admitted.add(messageId);
        },
        progress: async (_s, _signal, id) => {
          const row = f.repo.run({ jobId: j.jobId, internal: true }),
            page = f.repo.evidence({ snapshotId: row.snapshotId }),
            p = proposal([page.items[0].evidenceId]);
          return {
            idle: true,
            messageId: "assistant",
            finish: kind.startsWith('terminal-') ? "error" : kind === "length" ? "length" : "stop",
            terminalError:kind.startsWith('terminal-')?{causeCode:'LLAMACPP_OUTPUT_FORMAT',phase:'model-response',httpStatus:200}:null,
            requiresInterruption:kind==='terminal-uncertain',
            outcome: "succeeded",
            text:
              kind === "invalid" ||
              (kind === "repair" && !id.startsWith("msg_repair_"))
                ? "invalid-json"
                : JSON.stringify(p),
            tools: [
              {
                name: "ogid_read_ogid_query",
                status: kind.startsWith('terminal-')?'error':"completed",
                ...(kind.startsWith('terminal-')?{callId:'failed-tool',applicationCode:'INVALID_ARGUMENTS',validation:{stage:'tool-schema',issues:[]}}:{}),
                ...(kind==='contract-mismatch'?{returnedContractHash:'0'.repeat(64)}:{}),
                operationId: "agent.evidence",
                snapshotId: row.snapshotId,applicationOk:true,contentRead:true,returnedSnapshotId:row.snapshotId,
              },
            ],
            usage: [],
          };
        },
      };
      const worker = new IntelligenceWorker({
        call: async (m, a) => f.repo.call(m, a),
        opencode: remote,
        model: j.model,
        policy: { pollMs: 1, runDeadlineMs: 10000 },
      });
      worker.owner = j.owner;
      await worker.execute(j);
      const result = f.repo.run({ jobId: j.jobId, internal: true });
      if(kind.startsWith('terminal-')){
        const m=JSON.parse(f.db.prepare('SELECT metadata_json FROM agent_runs WHERE job_id=? AND fence=?').get(j.jobId,j.fence).metadata_json);
        assert.equal(m.terminalError.causeCode,'LLAMACPP_OUTPUT_FORMAT');assert.equal(m.lastToolFailure.code,'INVALID_ARGUMENTS');assert.equal(m.lastToolFailure.operationId,'agent.evidence');
      }
      if(kind==='contract-mismatch'){assert.equal(worker.mcpContractMismatch,true);assert.equal(result.errorCode,'AGENT_MCP_CONTRACT_MISMATCH');}
      if(kind==='terminal-uncertain')assert.ok(f.repo.pendingCancellations().some(r=>r.jobId===j.jobId),'unacknowledged interruption must remain durable');
      assert.equal(
        result.status,
        ['length','terminal-uncertain'].includes(kind)
          ? "incomplete"
          : ["invalid","terminal-error","contract-mismatch"].includes(kind)
            ? "failed"
            : "completed",
        kind,
      );
      assert.equal(
        posted.length,
        kind === "reconciled"
          ? 0
          : ["repair", "invalid"].includes(kind)
            ? 2
            : 1,
        kind,
      );
      assert.equal(
        f.repo.publications({ includeShadow: true }).items.length,
        ["reconciled", "repair"].includes(kind) ? 1 : 0,
      );
    } finally {
      f.close();
    }
  }
});

test("chat repairs unknown citations from frozen coverage once and never stores an invalid answer",async()=>{
 for(const repairSucceeds of [true,false]){
  const f=fixture();try{
   const device=f.repo.deviceCreate({label:'citation repair'}),session=f.repo.sessionCreate({deviceId:device.deviceId,model:manifest.defaultModel});
   const sent=f.repo.send({deviceId:device.deviceId,sessionId:session.sessionId,key:'repair-citations',text:'Describe la cobertura.'});
   const claim={...f.repo.claim({owner:'owner'}),owner:'owner'};let prompts=0,coverageReads=0;const texts=[];
   const worker=new IntelligenceWorker({model:manifest.defaultModel,call:async(method,args)=>{if(method==='evidence'){if(args.domain==='coverage')coverageReads++;else assert.equal(args.limit,20);assert.equal(args.snapshotId,f.repo.run({jobId:sent.jobId,internal:true}).snapshotId);}return f.repo.call(method,args);},opencode:{
    session:async id=>({id}),messages:async()=>({data:[]}),cancel:async()=>{},prompt:async(_id,input)=>{prompts++;texts.push(input.text);},
    progress:async(_session,_signal,id)=>{const row=f.repo.run({jobId:sent.jobId,internal:true}),item=f.repo.evidence({snapshotId:row.snapshotId,domain:'coverage'}).items[0];return {idle:true,messageId:'answer',finish:'stop',outcome:'succeeded',text:id.startsWith('msg_repair_')&&repairSucceeds?`Cobertura parcial [evidence:${item.evidenceId}]`:`Snapshot [evidence:${row.snapshotId}]. Cobertura [evidence:${item.evidenceId}].`,tools:[{name:'ogid_query',status:'completed',operationId:'agent.evidence',snapshotId:row.snapshotId,applicationOk:true,contentRead:true,returnedSnapshotId:row.snapshotId}],usage:[]};}
   },policy:{pollMs:1,runDeadlineMs:10000}});worker.owner='owner';await worker.execute(claim);
   assert.equal(prompts,2);assert.equal(coverageReads,2);
   const snapshotId=f.repo.run({jobId:sent.jobId,internal:true}).snapshotId;
   for(const text of texts)assert.ok(text.includes(`[evidence:coverage:${snapshotId}]`));
   assert.ok(texts[1].includes('snapshotId no es evidenceId'));assert.ok(!texts[1].includes('"schemaVersion":"ogid-evidence-v1"'));
   assert.equal(f.repo.run({jobId:sent.jobId,internal:true}).status,repairSucceeds?'completed':'failed');
   const answers=f.repo.messages({deviceId:device.deviceId,sessionId:session.sessionId}).items.filter(m=>m.role==='assistant');
   assert.equal(answers.length,repairSucceeds?1:0);assert.doesNotMatch(JSON.stringify(answers),/invented/);
  }finally{f.close();}
 }
});

test('a chat with no evidence tool call uses at most one contract repair and still requires frozen evidence',async()=>{
 for(const repairsEvidence of [true,false]){
  const f=fixture();try{
   const d=f.repo.deviceCreate({label:'tool repair'}),s=f.repo.sessionCreate({deviceId:d.deviceId,model:manifest.defaultModel});
   const sent=f.repo.send({deviceId:d.deviceId,sessionId:s.sessionId,key:'one',text:'Describe la cobertura.'});
   const j=f.repo.claim({owner:'owner'});let prompts=0;
   const worker=new IntelligenceWorker({model:manifest.defaultModel,call:async(m,a)=>f.repo.call(m,a),opencode:{
    session:async id=>({id}),messages:async()=>({data:[]}),cancel:async()=>{},
    prompt:async(_s,input)=>{prompts++;if(prompts===2){assert.match(input.text,/agent.evidence/);assert.match(input.text,/snapshotId/);}},
    progress:async(_s,_signal,id)=>{
     const row=f.repo.run({jobId:j.jobId,internal:true}),coverage=f.repo.evidence({snapshotId:row.snapshotId,domain:'coverage'}).items[0];
     return {idle:true,messageId:'answer',finish:'stop',outcome:'succeeded',text:`Cobertura parcial [evidence:${coverage.evidenceId}]`,tools:id.startsWith('msg_repair_')&&repairsEvidence?[{name:'ogid_query',status:'completed',operationId:'agent.evidence',snapshotId:row.snapshotId,applicationOk:true,contentRead:true,returnedSnapshotId:row.snapshotId}]:[],usage:[]};
    }
   },policy:{pollMs:1,runDeadlineMs:10000}});worker.owner='owner';await worker.execute(j);
   assert.equal(prompts,2);assert.equal(f.repo.run({jobId:sent.jobId,internal:true}).status,repairsEvidence?'completed':'failed');
   const answers=f.repo.messages({deviceId:d.deviceId,sessionId:s.sessionId}).items.filter(m=>m.role==='assistant');assert.equal(answers.length,repairsEvidence?1:0);
  }finally{f.close();}
 }
});

test("waiting model excludes a second turn of the same chat and cancellation closes its run", () => {
  const f = fixture();
  try {
    const d = f.repo.deviceCreate({ label: "owner" }),
      s = f.repo.sessionCreate({
        deviceId: d.deviceId,
        model: manifest.defaultModel,
      }),
      args = { deviceId: d.deviceId, sessionId: s.sessionId, text: "one" };
    const a = f.repo.send({ ...args, key: "first" }),
      b = f.repo.send({ ...args, text: "two", key: "second" }),
      claim = f.repo.claim({ owner: "worker" });
    f.repo.state({ ...claim, owner: "worker", status: "waiting-model" });
    assert.equal(
      f.repo.messages({ sessionId: s.sessionId, deviceId: d.deviceId })
        .activeRun.jobId,
      a.jobId,
    );
    assert.equal(f.repo.claim({ owner: "second-worker" }), null);
    f.repo.cancel({ jobId: a.jobId, deviceId: d.deviceId });
    assert.equal(f.repo.status().runs[0].status, "cancelled");
    assert.equal(f.repo.claim({ owner: "second-worker" }).jobId, b.jobId);
    assert.equal(
      f.repo.messages({ sessionId: s.sessionId, deviceId: d.deviceId })
        .activeRun.jobId,
      b.jobId,
    );
    f.repo.cancel({ jobId: b.jobId, deviceId: d.deviceId });
    assert.equal(
      f.repo.messages({ sessionId: s.sessionId, deviceId: d.deviceId })
        .activeRun,
      null,
    );
  } finally {
    f.close();
  }
});

test("outbox does not coalesce new evidence into a frozen waiting-model execution", () => {
  const f = fixture();
  try {
    const insert = (id) =>
      f.db
        .prepare(
          "INSERT INTO outbox(change_id,entity_kind,entity_id,revision,observed_at,payload_json) VALUES(?,?,?,?,?,?)",
        )
        .run(id, "article-revision", id, 1, new Date().toISOString(), "{}");
    insert("first");
    f.repo.enqueue({task:"global_intelligence_brief",model:manifest.defaultModel,key:"explicit",priority:10});
    const active = f.repo.claim({ owner: "a" });
    f.repo.snapshot({ ...active, owner: "a" });
    f.repo.state({ ...active, owner: "a", status: "waiting-model" });
    insert("second");
    const next = f.repo.consume({ model: manifest.defaultModel });
    assert.deepEqual(next.jobs,[]);
    assert.ok(f.repo.run({jobId:active.jobId,internal:true}).snapshotId);
  } finally {
    f.close();
  }
});

test("evidence chunks survive MCP projection with original hash and headline-only policy", () => {
  const f = fixture();
  try {
    f.runtime.services.news.ingest([
      {
        id: "long",
        title: "Ukraine report",
        description: "á".repeat(24000),
        url: "https://fixture.invalid/long",
        publishedAt: new Date().toISOString(),
        provider: "rss",
        usagePolicy: "standard-link-out",
      },
      {
        id: "restricted",
        title: "Russia security",
        description: "RESTRICTED_CONTENT",
        url: "https://fixture.invalid/restricted",
        publishedAt: new Date().toISOString(),
        provider: "rss",
        usagePolicy: { mode: "headline-only-link-out" },
      },
    ]);
    f.advance(1000);
    const j = job(f),
      snap = f.repo.snapshot(j),
      page = f.repo.evidence({
        snapshotId: snap.snapshotId,
        domain: "news",
        limit: 100,
      });
    assert.equal(snap.coverage.sealed, true);
    assert.match(snap.coverage.sha256, /^[a-f0-9]{64}$/);
    const long = page.items.find((x) => x.representation === 'chunked');
    assert.equal(long.representation, 'chunked');
    const parts = [];
    let offset = 0,
      last;
    do {
      last = projectOperation(
        getOperation("agent.evidence.chunk"),
        f.repo.evidenceChunk({
          snapshotId: snap.snapshotId,
          evidenceId: long.evidenceId,
          offset,
        }),
      );
      assert.ok(Buffer.byteLength(JSON.stringify(last)) < 24576);
      parts.push(Buffer.from(last.chunk, "base64"));
      offset = last.nextOffset;
    } while (last.hasMore);
    const bytes = Buffer.concat(parts);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), last.sha256);
    assert.equal(JSON.parse(bytes).data.excerpt.length, 24000);
    const utf8 = [];
    offset = 0;
    do {
      last = f.repo.evidenceChunk({
        snapshotId: snap.snapshotId,
        evidenceId: long.evidenceId,
        offset,
        format: "utf8",
      });
      utf8.push(last.chunk);
      assert.ok(Buffer.byteLength(JSON.stringify(last)) < 24576);
      offset = last.nextOffset;
    } while (last.hasMore);
    assert.equal(utf8.join(""), bytes.toString("utf8"));
    const continuation = bytes.indexOf(Buffer.from("á")) + 1;
    assert.throws(
      () =>
        f.repo.evidenceChunk({
          snapshotId: snap.snapshotId,
          evidenceId: long.evidenceId,
          offset: continuation,
          format: "utf8",
        }),
      { code: "AGENT_INVALID_CURSOR" },
    );
    assert.ok(
      !JSON.stringify(
        page.items.find((x) => x.data?.title === "Russia security"),
      ).includes("RESTRICTED_CONTENT"),
    );
    const catalogue = f.repo.clusters({
      snapshotId: snap.snapshotId,
      limit: 1,
    });
    assert.equal(catalogue.hasMore, true);
    const members = f.repo.clusters({
      snapshotId: snap.snapshotId,
      clusterId: catalogue.items[0].clusterId,
    });
    assert.equal(members.items.length, 1);
  } finally {
    f.close();
  }
});

test('tool-sized evidence and cluster pages retain every row through stable cursors',()=>{
 const f=fixture();try{
  f.runtime.services.news.ingest(Array.from({length:120},(_,n)=>({id:`page-${n}`,title:`Ukraine ${n} ${'context '.repeat(60)}`,description:'context '.repeat(300),url:`https://fixture.invalid/${n}`,publishedAt:new Date().toISOString(),provider:'rss'})));
  f.advance(1000);const snap=f.repo.snapshot(job(f));
  for(const method of ['evidence','clusters']){
   const seen=new Set();let cursor='0',pages=0;
   do{
    const page=f.repo[method]({snapshotId:snap.snapshotId,...(method==='evidence'?{domain:'news'}:{}),limit:100,cursor});
    assert.ok(Buffer.byteLength(JSON.stringify(page))<24576,`${method} exceeds tool frame`);
    for(const row of page.items){const id=row.evidenceId || row.clusterId;assert.ok(!seen.has(id));seen.add(id);}
    if(page.hasMore)assert.ok(Number(page.nextCursor)>Number(cursor));
    cursor=page.nextCursor;pages++;assert.ok(pages<121);
   }while(cursor);
   assert.equal(seen.size,120);assert.ok(pages>1);
  }
 }finally{f.close();}
});

test("chat history and session lists are paginated and device isolated", () => {
  const f = fixture();
  try {
    const d = f.repo.deviceCreate({ label: "a" }),
      s = f.repo.sessionCreate({
        deviceId: d.deviceId,
        model: manifest.defaultModel,
      }),
      args = { deviceId: d.deviceId, sessionId: s.sessionId };
    for (let i = 0; i < 6; i++)
      f.repo.send({ ...args, key: `m${i}`, text: `message ${i}` });
    const tail = f.repo.messages({ ...args, latest: true, limit: 2 });
    assert.equal(tail.items[0].text, "message 4");
    assert.ok(tail.olderCursor);
    const older = f.repo.messages({
      ...args,
      before: tail.olderCursor,
      limit: 2,
    });
    assert.equal(older.items[0].text, "message 2");
    assert.equal(
      f.repo.messages({ ...args, cursor: tail.nextCursor }).items.length,
      0,
    );
    f.repo.sessionCreate({
      deviceId: d.deviceId,
      model: manifest.defaultModel,
    });
    const list = f.repo.sessions({ deviceId: d.deviceId, limit: 1 });
    assert.equal(list.hasMore, true);
    assert.equal(
      f.repo.sessions({
        deviceId: d.deviceId,
        cursor: list.nextCursor,
        limit: 1,
      }).items[0].sessionId,
      s.sessionId,
    );
  } finally {
    f.close();
  }
});

test("internal HTTP client retains safe validation codes for the single structural repair", async () => {
  const client = createAgentInternalClient({
    baseUrl: "http://127.0.0.1:3000",
    token: "fixture",
    fetchImpl: async () =>
      Response.json(
        {
          ok: false,
          error: { code: "AGENT_INVALID_PUBLICATION", message: "PRIVATE" },
        },
        { status: 400 },
      ),
  });
  await assert.rejects(
    client("publish"),
    (e) =>
      e.code === "AGENT_INVALID_PUBLICATION" && !e.message.includes("PRIVATE"),
  );
});

test("internal transport retries only reads and fenced heartbeats, never publications or rejected leases",async()=>{
 for(const method of ['run','heartbeat','publish','state','snapshot']){
  let calls=0;const bodies=[];
  const client=createAgentInternalClient({baseUrl:'http://127.0.0.1:3000',token:'fixture',fetchImpl:async(_url,options)=>{calls++;bodies.push(options.body);if(calls===1)throw new DOMException('PRIVATE_TRANSPORT','TimeoutError');return Response.json({data:{accepted:true}});}});
  if(['run','heartbeat'].includes(method)){assert.deepEqual(await client(method,{jobId:'same',fence:1}),{accepted:true});assert.equal(calls,2);assert.equal(bodies[0],bodies[1]);}
  else{await assert.rejects(client(method),{code:'AGENT_INTERNAL_TRANSPORT_UNAVAILABLE'});assert.equal(calls,1);}
 }
 let calls=0;const rejected=createAgentInternalClient({baseUrl:'http://127.0.0.1:3000',token:'fixture',fetchImpl:async()=>{calls++;return Response.json({error:{code:'AGENT_LEASE_LOST'}},{status:409});}});
 await assert.rejects(rejected('heartbeat'),{code:'AGENT_LEASE_LOST'});assert.equal(calls,1);
});

test("capability modes and probes fail closed and prerequisite failure remains isolated", async () => {
  const cfg = loadAgentConfig(
    {},
    { mode: "shadow", manifest, taskModes: { contextual_chat: "off" } },
  );
  assert.equal(cfg.taskModes.contextual_chat, "off");
  assert.equal(cfg.taskModes.instrument_outlook, "shadow");
  assert.equal(
    readyModel({ ...model, probe: { ...model.probe, cancellation: false } }),
    false,
  );
  assert.throws(
    () => loadAgentConfig({}, { taskModes: { shell: "visible" } }),
    { code: "AGENT_INVALID_TASK_MODES" },
  );
  const completed = [],
    maintenance = new AgentMaintenance({
      enabled: true,
      instruments: () => ["a", "b"],
      call: async () => {},
      business: {
        advanced: {
          getSnapshot: async () => {
            throw Object.assign(Error(), { code: "FIXTURE_SOURCE_FAILED" });
          },
        },
        conditions: { getSnapshot: async () => completed.push("conditions") },
        forecasts: { evaluate: async () => completed.push("evaluation") },
        technical: {
          get: async ({ instrumentId, interval }) =>
            completed.push(`${instrumentId}:${interval}`),
        },
      },
    });
  await maintenance.tick();
  assert.deepEqual(completed, [
    "conditions",
    "evaluation",
    "a:1day",
    "a:1h",
    "a:15min",
    "b:1day",
    "b:1h",
    "b:15min",
  ]);
  assert.equal(maintenance.status.state, "degraded");
});

test("agent forecast registration is prospective, probability-free and rolls back with publication", () => {
  const f = fixture();
  try {
    const instrumentId = "crypto-bitcoin-us-dollar",
      day = 86400000,
      today = Math.floor(f.clock() / day) * day;
    const bars = Array.from({ length: 220 }, (_, i) => {
      const open = today - (220 - i) * day,
        price = 100 + i / 10;
      return {
        instrumentId,
        interval: "1day",
        openTime: new Date(open).toISOString(),
        closeTime: new Date(open + day).toISOString(),
        fetchedAt: new Date(open + day + 300000).toISOString(),
        open: price,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 100,
        currency: "USD",
        source: "fixture-offline",
        adjusted: true,
        dataMode: "observed",
        provenance: { adjustmentMode: "splits" },
        calendar: { partial: false },
      };
    });
    f.runtime.services.candles.append(bars);
    f.runtime.services.forecasts.now = f.clock;
    f.runtime.services.technical.now = () => new Date(f.clock());
    const technical = f.runtime.services.technical.get({ instrumentId });
    assert.equal(technical.quality.reason, null);
    assert.equal(technical.quality.stale, false);
    f.runtime.recordAnalysis("technical.get", { instrumentId }, technical);
    f.advance(Math.max(1000,Date.now()-f.clock()+1));
    const pending = f.repo.enqueue({
        task: "instrument_outlook",
        scope: instrumentId,
        model: manifest.defaultModel,
        key: "forecast",
      }),
      claimed = f.repo.claim({ owner: "forecast-owner" }),
      auth = { ...claimed, owner: "forecast-owner" },
      snap = f.repo.snapshot(auth),
      items = f.repo.evidence({
        snapshotId: snap.snapshotId,
        limit: 100,
      }).items,
      context = items.find((e) => e.domain === "technical.get");
    assert.ok(context,JSON.stringify({coverage:snap.coverage,domains:items.map(e=>e.domain)}));
    const p = {
      ...proposal([context.evidenceId]),
      task: "instrument_outlook",
      instrumentId,
      direction: "up",
      invalidation: ["Cierre por debajo del soporte observado"],
      technicalFacts: [
        {
          evidenceId: context.evidenceId,
          path: "observed.close",
          value: technical.observed.close,
          unit:technical.quality.currency,
        },
      ],
      drivers: [
        {
          domain: "technical",
          description: "Fixture de tendencia",
          evidenceIds: [context.evidenceId],
        },
      ],
      scenarios: ["base", "bull", "bear"].map((name) => ({
        name,
        description: "Escenario fixture",
      })),
      alternatives: ["Continuación lateral"],
      missingEvidence: ["Precio de ejecución"],
      intradayScenarios: [
        {
          horizonMinutes: 60,
          interval: "1h",
          direction: "unavailable",
          summary: "Sin velas intradía válidas",
          evidenceIds: [],
          invalidation: [],
          evaluation: "unavailable",
        },
      ],
      target:
        "absolute-return-direction; first available daily close after 24h",
      methods: {
        sentiment: "qualitative-evidence-synthesis-v1",
        stability: "qualitative-watchlist-v1",
      },
    };
    f.advance(60000);
    f.repo.heartbeat({ ...auth });
    f.advance(60000);
    f.repo.heartbeat({ ...auth });
    f.db.exec(
      "CREATE TRIGGER reject_forecast_publication BEFORE INSERT ON agent_publications BEGIN SELECT RAISE(ABORT,'injected publication failure'); END",
    );
    assert.throws(
      () => f.repo.publish({ ...auth, proposal: p, mode: "shadow" }),
      /injected publication failure/,
    );
    assert.equal(
      Object.keys(f.runtime.services.store.state.forecasts).length,
      0,
    );
    f.db.exec("DROP TRIGGER reject_forecast_publication");
    f.repo.publish({ ...auth, proposal: p, mode: "shadow" });
    const forecast =
      f.runtime.services.store.state.forecasts[`agent:${pending.jobId}`];
    assert.equal(Date.parse(forecast.issuedAt), f.clock());
    assert.ok(Date.parse(forecast.issuedAt) > Date.parse(snap.asOf));
    assert.equal(forecast.probability, null);
    assert.equal(
      f.runtime.services.forecasts.evaluate().results[0].status,
      "pending-outcome",
    );
  } finally {
    f.close();
  }
});

test("official alerts preserve admission and source revisions when an agent adds a visible assessment", () => {
  const f = fixture();
  try {
    const active = AWARENESS_SOURCES.find(
        (s) => s.admissionState === "active",
      ).sourceId,
      blocked = AWARENESS_SOURCES.find(
        (s) => s.admissionState === "blocked",
      ).sourceId,
      at = new Date(f.clock()).toISOString();
    const insert = (id, source) => {
      f.db
        .prepare("INSERT OR IGNORE INTO sources VALUES(?,?,?,?)")
        .run(source, source, "active", "{}");
      const e = {
        eventId: id,
        sourceId: source,
        kind: "official_security_release",
        status: "released",
        title: "Fixture official claim",
        importance: "high",
        publishedAt: at,
        revision: 1,
      };
      f.db
        .prepare("INSERT INTO awareness_events VALUES(?,?,?,?,?)")
        .run(id, source, at, 1, JSON.stringify(e));
    };
    insert("fixture-official", active);
    insert("fixture-blocked", blocked);
    assert.equal(f.repo.alertSync().updated, 1);
    const d = f.repo.deviceCreate({ label: "reader" });
    f.repo.alertState({
      deviceId: d.deviceId,
      alertId: "fixture-official",
      read: true,
      archived: false,
    });
    f.repo.enqueue({
      task: "geopolitical_alert_assessment",
      model: manifest.defaultModel,
      key: "assessment",
    });
    const claimed = f.repo.claim({ owner: "assessor" }),
      auth = { ...claimed, owner: "assessor" },
      snap = f.repo.snapshot(auth),
      item = f.repo.evidence({
        snapshotId: snap.snapshotId,
        domain: "geopolitical-alert",
      }).items[0];
    const p = {
      ...proposal([item.evidenceId]),
      task: "geopolitical_alert_assessment",
      alertAssessments: [
        {
          alertId: "fixture-official",
          revision: 1,
          summary: "Valoración atribuida, sin verificar la afirmación",
          evidenceIds: [item.evidenceId],
        },
      ],
    };
    f.repo.publish({ ...auth, proposal: p, mode: "visible" });
    assert.equal(f.repo.alertSync().updated, 0);
    let alert = f.repo.alerts({ deviceId: d.deviceId, state: "all" }).items[0];
    assert.equal(alert.revision, 2);
    assert.equal(alert.verification, "official-claim");
    assert.equal(alert.read, false);
    const updated = {
      ...alert,
      title: "Fixture correction",
      status: "cancelled",
      kind: "official_security_release",
    };
    f.db
      .prepare(
        "UPDATE awareness_events SET revision=2,payload_json=? WHERE event_id=?",
      )
      .run(JSON.stringify(updated), "fixture-official");
    assert.equal(f.repo.alertSync().updated, 1);
    alert = f.repo.alerts({ deviceId: d.deviceId, state: "all" }).items[0];
    assert.equal(alert.revision, 3);
    assert.equal(alert.verification, "corrected");
    assert.equal(
      f.repo.alertRevisions({ alertId: alert.alertId }).items.length,
      3,
    );
  } finally {
    f.close();
  }
});

test("remote cancellation is leased across workers and gates a new conversation turn", () => {
  const f = fixture();
  try {
    const d = f.repo.deviceCreate({ label: "a" }),
      s = f.repo.sessionCreate({
        deviceId: d.deviceId,
        model: manifest.defaultModel,
      }),
      args = { deviceId: d.deviceId, sessionId: s.sessionId };
    const first = f.repo.send({ ...args, key: "one", text: "one" });
    f.repo.send({ ...args, key: "two", text: "two" });
    const claimed = f.repo.claim({ owner: "owner" }),
      auth = { ...claimed, owner: "owner" };
    f.repo.link({ ...auth, opencodeId: "ses_fixture" });
    f.repo.cancel({ jobId: first.jobId, deviceId: d.deviceId });
    assert.equal(f.repo.claim({ owner: "other" }), null);
    const a = f.repo.interruptClaim({ ...auth });
    assert.ok(a);
    assert.equal(f.repo.interruptClaim({ ...auth, owner: "other" }), null);
    f.advance(31000);
    const b = f.repo.interruptClaim({ ...auth, owner: "other" });
    assert.ok(b);
    assert.throws(
      () => f.repo.cancelAcknowledged({ ...auth, interruptId: a.interruptId }),
      { code: "AGENT_LEASE_LOST" },
    );
    assert.equal(f.repo.claim({ owner: "third" }), null);
    f.repo.cancelAcknowledged({ ...auth, interruptId: b.interruptId });
    assert.ok(f.repo.claim({ owner: "third" }));
  } finally {
    f.close();
  }
});

test("a completed chat message retains only citations belonging to its frozen snapshot", () => {
  const f = fixture();
  try {
    const d = f.repo.deviceCreate({ label: "a" }),
      s = f.repo.sessionCreate({
        deviceId: d.deviceId,
        model: manifest.defaultModel,
      });
    f.repo.send({
      deviceId: d.deviceId,
      sessionId: s.sessionId,
      key: "one",
      text: "consulta",
    });
    const claimed = f.repo.claim({ owner: "owner" }),
      auth = { ...claimed, owner: "owner" },
      snapshot = f.repo.snapshot(auth),
      id = f.repo.evidence({ snapshotId: snapshot.snapshotId }).items[0]
        .evidenceId;
    assert.throws(
      () => f.repo.state({ ...auth, status: "completed", text: "Sin citas" }),
      { code: "AGENT_CHAT_CITATION_REQUIRED" },
    );
    assert.throws(
      () =>
        f.repo.state({
          ...auth,
          status: "completed",
          text: "[evidence:inventada]",
        }),
      { code: "AGENT_UNKNOWN_EVIDENCE" },
    );
    assert.throws(()=>f.repo.state({...auth,status:'completed',text:`Snapshot [evidence:${snapshot.snapshotId}] y cobertura [evidence:${id}]`}),e=>e.code==='AGENT_UNKNOWN_EVIDENCE' && e.details.evidenceId===snapshot.snapshotId);
    f.repo.state({
      ...auth,
      status: "completed",
      text: `Cobertura parcial [evidence:${id}]`,
    });
    const answer = f.repo.messages({
      deviceId: d.deviceId,
      sessionId: s.sessionId,
    }).items[1];
    assert.deepEqual(answer.evidenceIds, [id]);
    assert.equal(answer.snapshotId, snapshot.snapshotId);
  } finally {
    f.close();
  }
});
