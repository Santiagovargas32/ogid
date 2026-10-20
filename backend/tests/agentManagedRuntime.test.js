import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync,statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { spawn } from "node:child_process";
import { loadAgentConfig } from "../services/agent/config.js";
import { prepareManagedAgentConfig,ManagedAgentRuntime } from "../services/agent/managedRuntime.js";
import { createAppServer } from "../server.js";
import { StorageManager } from "../storage/StorageManager.js";
import Database from "better-sqlite3";
import { migrate } from "../storage/migrate.js";
import { BusinessRuntime } from "../storage/businessRuntime.js";
import { listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { ingestNewsBatches } from "../storage/newsIngestion.js";
import { operationContext,committedOperationItems,shareOperation } from "../services/shared/operationContext.js";

test("shared acquisition forwards real commit progress to every waiting workflow",async()=>{
 const controller=new AbortController(),updates=[[],[]];let finish,owner;
 const task=new Promise(resolve=>{finish=resolve;});
 const first={signal:controller.signal,committed:n=>updates[0].push(n)},second={signal:controller.signal,committed:n=>updates[1].push(n)};
 operationContext.run(first,()=>{owner=()=>committedOperationItems(10);shareOperation(task);});
 operationContext.run(second,()=>shareOperation(task));operationContext.run(first,owner);
 assert.deepEqual(updates,[[10],[10]]);finish();await task;
});

test("RSS watchdog cancellation aborts a slow provider and leaves SQLite and the feed retry usable",async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-rss-cancel-'));let arrived,release,slow=true;
 const entered=new Promise(r=>{arrived=r;}),gate=new Promise(r=>{release=r;});
 const feed=createHttpServer(async(_req,res)=>{if(slow){arrived();await gate;}res.end('<rss><channel><title>Fixture</title><item><title>Retry report</title><link>https://fixture.invalid/workflow-retry</link></item></channel></rss>');});
 const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite')});let pending;
 try{
  feed.listen(0,'127.0.0.1');await once(feed,'listening');await manager.start();await manager.request('domain.configure',{rootDir:directory,news:{providers:[]},rss:{rssFeeds:[]}});
  const input={feeds:[{url:`http://127.0.0.1:${feed.address().port}/feed`,label:'Fixture'}],timeoutMs:9000};
  pending=manager.request('rss.fetch',input);const rejected=assert.rejects(pending,{code:'STORAGE_WORKFLOW_STALLED'});await entered;
  const entry=[...manager.active.values()].find(e=>e.diagnostic.operation==='rss.fetch');clearTimeout(entry.timer);manager.expire(entry);await rejected;
  assert.equal(manager.state,'ready');await manager.request('runtime.save',{kind:'after-rss-cancel',payload:{saved:true}});
  slow=false;release();const retried=await manager.request('rss.fetch',input);assert.equal(retried.articles.length,1);
  assert.equal((await manager.request('domain.call',{service:'news',method:'coverage',args:[]})).totalStored,1);
 }finally{release();await pending?.catch(()=>{});await manager.close();feed.closeAllConnections();await new Promise(r=>feed.close(r));rmSync(directory,{recursive:true,force:true});}
});

const model={alias:"fixture",state:"ready",context:8192,tools:true,structuredOutput:true,serverContextVerified:true,probe:{verifiedAt:new Date().toISOString(),wireNoFixedCap:true,streaming:true,cancellation:true}};
function fixture(switches={broker:true,opencode:false,worker:false}) {
  const directory=mkdtempSync(join(tmpdir(),"ogid-managed-test-"));
  const config=prepareManagedAgentConfig(loadAgentConfig({}, {mode:"shadow",backgroundModel:"llamacpp/fixture",manifest:{schemaVersion:"ogid-model-catalog-v1",models:[model]},managed:{...switches,directory}}));
  return {directory,config,close:()=>rmSync(directory,{force:true,recursive:true})};
}
async function freePort(){const s=createServer();s.listen(0,"127.0.0.1");await once(s,"listening");const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await wait(100);}assert.fail("El componente no alcanzó el estado esperado");}

test("off switches launch no children and credentials survive terminal restarts",async()=>{
  const f=fixture();try{
    const again=prepareManagedAgentConfig(f.config);
    assert.equal(again.internalToken,f.config.internalToken);
    assert.equal(statSync(join(f.directory,"credentials.json")).mode&0o777,0o600);
    const rt=new ManagedAgentRuntime({config:{...f.config,mode:"off"},spawnImpl:()=>assert.fail("off spawned a child")});
    await rt.start("http://127.0.0.1:3000");await rt.stop();
    assert.equal(Object.values(rt.status().components).every(c=>!c.enabled),true);
    assert.throws(()=>loadAgentConfig({AGENT_BROKER_ENABLED:"maybe"}),{code:"AGENT_INVALID_COMPONENT_SWITCH"});
  }finally{f.close();}
});
test("managed child environments do not inherit backend/admin/provider secrets or personal config",()=>{
  const f=fixture();try{
    const rt=new ManagedAgentRuntime({config:f.config,environment:{LLAMACPP_API_KEY:"llama-secret",ADMIN_API_TOKEN:"admin-secret",NEWS_API_KEY:"news-secret",NODE_OPTIONS:"--import private.js",OPENCODE_CONFIG:"personal",HOME:"/home/personal"}});
    rt.baseUrl="http://127.0.0.1:3000";rt.manifestPath=join(f.directory,"models.json");rt.configPath=join(f.directory,"opencode.json");
    const broker=rt.childEnvironment("broker"),worker=rt.childEnvironment("worker"),opencode=rt.childEnvironment("opencode");
    assert.equal(broker.LLAMACPP_API_KEY,"llama-secret");
    for(const env of [broker,worker,opencode]){assert.equal(env.ADMIN_API_TOKEN,undefined);assert.equal(env.NEWS_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.OGID_MANAGED_CHILD,"1");assert.notEqual(env.HOME,"/home/personal");}
    for(const env of [worker,opencode])assert.equal(env.LLAMACPP_API_KEY,undefined);
    assert.equal(opencode.AGENT_WORKER_TOKEN,undefined);assert.equal(broker.OGID_OPENCODE_PASSWORD,undefined);
  }finally{f.close();}
});
test("a foreign listener is never killed or adopted and pending restarts stop cleanly",async()=>{
  const s=createServer();s.listen(0,"127.0.0.1");await once(s,"listening");const f=fixture();f.config.brokerUrl=`http://127.0.0.1:${s.address().port}`;
  const rt=new ManagedAgentRuntime({config:f.config,environment:{LLAMACPP_API_KEY:"fixture"},spawnImpl:()=>assert.fail("port is owned by someone else")});
  try{await rt.start("http://127.0.0.1:3000");assert.equal(rt.status().components.broker.errorCode,"AGENT_COMPONENT_PORT_IN_USE");await rt.stop();assert.equal(s.listening,true);assert.equal(rt.timers.size,0);}finally{await rt.stop();await new Promise(r=>s.close(r));f.close();}
});
test("npm-owned broker authenticates, recovers after a crash and releases its port on shutdown",async()=>{
  const f=fixture();f.config.brokerUrl=`http://127.0.0.1:${await freePort()}`;
  const rt=new ManagedAgentRuntime({config:f.config,environment:{LLAMACPP_API_KEY:"fixture"}});
  try{
    await rt.start("http://127.0.0.1:3000");assert.equal(rt.status().components.broker.state,"running");
    const anonymous=await fetch(f.config.brokerUrl+"/health");assert.equal(anonymous.status,401);await anonymous.body.cancel();
    const original=rt.status().components.broker.pid;process.kill(original,"SIGKILL");
    await until(()=>rt.status().components.broker.state==="running" && rt.status().components.broker.pid!==original);
    const authenticated=await fetch(f.config.brokerUrl+"/health",{headers:{Authorization:`Bearer ${f.config.brokerToken}`}});assert.equal(authenticated.status,200);await authenticated.body.cancel();
    await rt.stop();assert.equal(rt.children.size,0);
    const s=createServer();s.listen(Number(new URL(f.config.brokerUrl).port),"127.0.0.1");await once(s,"listening");await new Promise(r=>s.close(r));
  }finally{await rt.stop();f.close();}
});
test("shutdown during initial startup cannot leave a child behind",async()=>{
  const f=fixture();f.config.brokerUrl=`http://127.0.0.1:${await freePort()}`;const rt=new ManagedAgentRuntime({config:f.config,environment:{LLAMACPP_API_KEY:"fixture"}});
  try{const boot=rt.start("http://127.0.0.1:3000");await rt.stop();await boot;assert.equal(rt.children.size,0);assert.equal(rt.timers.size,0);}finally{await rt.stop();f.close();}
});

test("broker exits on IPC loss if the terminal owner is killed without cleanup",async()=>{
  const f=fixture();f.config.brokerUrl=`http://127.0.0.1:${await freePort()}`;
  const module=new URL("../services/agent/managedRuntime.js",import.meta.url).href;
  const code=`import {ManagedAgentRuntime} from ${JSON.stringify(module)}; const rt=new ManagedAgentRuntime({config:${JSON.stringify(f.config)},environment:{LLAMACPP_API_KEY:"fixture"}});await rt.start("http://127.0.0.1:3000");process.send(rt.status());setInterval(()=>{},1000);`;
  const owner=spawn(process.execPath,["--input-type=module","-e",code],{stdio:["ignore","ignore","ignore","ipc"]});
  try{
    const [status]=await once(owner,"message");assert.equal(status.components.broker.state,"running");
    const stopped=once(owner,"exit");owner.kill("SIGKILL");await stopped;
    let closed=false;for(let i=0;i<100;i++){try{const r=await fetch(f.config.brokerUrl+"/health",{signal:AbortSignal.timeout(300)});await r.body.cancel();}catch{closed=true;break;}await wait(100);}
    assert.equal(closed,true,"An orphan broker kept its listening port");
  }finally{if(owner.exitCode===null && owner.signalCode===null)owner.kill("SIGKILL");f.close();}
});

test("managed child loader never opens the backend .env",async()=>{
  const f=fixture();const rt=new ManagedAgentRuntime({config:f.config,environment:{LLAMACPP_API_KEY:"fixture"}});
  const loader=new URL("../config/loadEnvironment.js",import.meta.url).href;
  const code=`await import(${JSON.stringify(loader)});process.send({news:Boolean(process.env.NEWS_API_KEY),managed:process.env.OGID_MANAGED_CHILD});process.disconnect();`;
  const child=spawn(process.execPath,["--input-type=module","-e",code],{env:rt.childEnvironment("broker"),stdio:["ignore","ignore","ignore","ipc"]});
  try{const [result]=await once(child,"message");assert.deepEqual(result,{news:false,managed:"1"});await once(child,"exit");}finally{f.close();}
});

test("health listens during cold initialization while business APIs remain unavailable",async()=>{
  const storage=new StorageManager({enabled:false,businessEnabled:false});let release;
  const gate=new Promise(r=>{release=r;});const start=storage.start.bind(storage);storage.start=async()=>{await gate;return start();};
  const runtime=createAppServer({port:0,host:"127.0.0.1",disableBackgroundRefresh:true,storageManager:storage,market:{provider:"",historyPersist:false},news:{providers:[],rssFeeds:[]},agent:{mode:"off"}});
  const listening=once(runtime.server,"listening"),boot=runtime.start();
  try{
    await listening;const base=`http://127.0.0.1:${runtime.server.address().port}`;
    assert.equal((await fetch(base+"/api/health/live")).status,200);
    assert.equal((await fetch(base+"/api/health/ready")).status,503);
    const pending=await fetch(base+"/api/agent/v1/capabilities");assert.equal(pending.status,503);assert.equal((await pending.json()).error.code,"BACKEND_INITIALIZING");
    release();await boot;assert.equal((await fetch(base+"/api/health/ready")).status,200);
  }finally{release();await boot;await runtime.stop();}
});

test("registry rebuild processes all event pages once and retains stable instrument impacts",()=>{
  const db=new Database(":memory:");migrate(db);const runtime=new BusinessRuntime(db,()=>{});
  const instrument=listVerifiedInstruments()[0];
  try{
    const insert=db.prepare("INSERT INTO events(event_id,identity_version,revision,observed_at,status,payload_json) VALUES(?,?,?,?,?,?)");
    for(let n=0;n<530;n++){const id=`page-${String(n).padStart(4,"0")}`;const event={eventId:id,identityVersion:"source-publication-v2",quality:{identityVerified:true,official:false},evidence:[],title:instrument.displayName,symbols:[instrument.canonicalSymbol],instrumentIds:[instrument.instrumentId]};insert.run(id,"source-publication-v2",1,new Date().toISOString(),"observed",JSON.stringify(event));}
    runtime.registry(listVerifiedInstruments());
    while(runtime.indexPage({}).state!=="ready"){}
    assert.equal(db.prepare("SELECT count(DISTINCT event_id) AS n FROM event_index_links").get().n,530);
    const before=db.prepare("SELECT * FROM event_index_links ORDER BY event_id,instrument_id").all();
    runtime.registry(listVerifiedInstruments());
    assert.deepEqual(db.prepare("SELECT * FROM event_index_links ORDER BY event_id,instrument_id").all(),before);
  }finally{db.close();}
});

test("acquisition yields to control messages after durable partial progress and never advances failed batches",async()=>{
  const values=Array.from({length:55},(_,id)=>({id}));let committed=[],observed;
  const control=new Promise(resolve=>setImmediate(()=>{observed=committed.length;resolve();}));
  const archive={ingest:items=>{committed.push(...items);return {accepted:items.length};}};
  assert.equal(await ingestNewsBatches(archive,values,{}),55);await control;
  assert.ok(observed>0 && observed<55);assert.deepEqual(committed,values);
  const checkpoints=[];committed=[];
  const failed={ingest:items=>{if(items.some(i=>i.id>=20))throw Error("fixture-write-failed");committed.push(...items);return {accepted:items.length};}};
  await assert.rejects(ingestNewsBatches(failed,values,{},count=>checkpoints.push(count)),/fixture-write-failed/);
  assert.equal(checkpoints.at(-1),committed.length);assert.ok(committed.length<55);
});

test("a pending RSS response does not hold SQLite reads, writes or analysis commits",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"ogid-slow-rss-"));
  let release,received;
  const gate=new Promise(r=>{release=r;}),arrived=new Promise(r=>{received=r;});
  const feed=createHttpServer(async(_req,res)=>{received();await gate;res.writeHead(200,{"content-type":"application/rss+xml"});res.end('<rss><channel><title>Fixture</title><item><title>Russia fixture report</title><link>https://fixture.invalid/pending-rss</link><pubDate>Sun, 18 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>');});
  const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,"db.sqlite")});
  let pending;
  try{
    feed.listen(0,"127.0.0.1");await once(feed,"listening");
    await manager.start();await manager.request("domain.configure",{rootDir:directory,news:{providers:[]},rss:{rssFeeds:[]}});
    pending=manager.request("rss.fetch",{feeds:[{url:`http://127.0.0.1:${feed.address().port}/rss`,label:"Delayed fixture"}],timeoutMs:9000});
    await Promise.race([arrived,wait(5000).then(()=>assert.fail("RSS request did not reach fixture"))]);
    const before=performance.now();
    await manager.request("runtime.save",{kind:"slow-feed-control",payload:{saved:true}});
    assert.deepEqual(await manager.request("runtime.load",{kind:"slow-feed-control"}),{saved:true});
    assert.equal((await manager.request("analysis.persist",{type:"analysis",record:{kind:"technical.get",input:{},result:{generatedAt:new Date().toISOString(),quality:{reason:"fixture"}}}})).persisted,true);
    assert.equal((await manager.request("storage.status")).businessStorage,"sqlite");
    assert.ok(performance.now()-before<2000,"SQLite control operations waited for the pending network response");
    release();await pending;
    const db=new Database(join(directory,"db.sqlite"),{readonly:true});
    try{assert.equal(db.prepare("SELECT count(*) AS n FROM articles").get().n,1);}finally{db.close();}
  }finally{release();await pending?.catch(()=>{});await manager.close();feed.closeAllConnections();await new Promise(r=>feed.close(r));rmSync(directory,{recursive:true,force:true});}
});

test("scenario preparation leaves the writer available and only publishes after read-only work succeeds",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"ogid-scenario-isolation-"));
 const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,"db.sqlite")});
 let release,entered;const gate=new Promise(r=>{release=r;}),preparing=new Promise(r=>{entered=r;});let pending;
 try{
  await manager.start();await manager.request('domain.configure',{rootDir:directory,instruments:listVerifiedInstruments(),news:{providers:[]},rss:{rssFeeds:[]}});
  const original=manager.analysisManager.localRequest.bind(manager.analysisManager);
  manager.analysisManager.localRequest=async(op,...rest)=>{if(op==='scenarios.prepare'){entered();await gate;}return original(op,...rest);};
  const instrumentId=listVerifiedInstruments()[0].instrumentId;
  pending=manager.request('domain.call',{service:'scenarios',method:'refresh',args:[{instrumentIds:[instrumentId]}]});await preparing;
  await manager.request('runtime.save',{kind:'scenario-control',payload:{saved:true}});
  assert.deepEqual(await manager.request('runtime.load',{kind:'scenario-control'}),{saved:true});
  let db=new Database(join(directory,'db.sqlite'),{readonly:true});assert.equal(db.prepare("SELECT count(*) AS n FROM alert_rows WHERE collection='scenarios'").get().n,0);db.close();
  release();const published=await pending;assert.equal(published.changes,3);
  await assert.rejects(manager.request('domain.call',{service:'scenarios',method:'refresh',args:[{instrumentIds:['unverified-fixture']}]}),{code:'UNRESOLVED_INSTRUMENT'});
  await manager.close();db=new Database(join(directory,'db.sqlite'),{readonly:true});
  try{assert.equal(db.prepare("SELECT count(*) AS n FROM alert_rows WHERE collection='scenarios'").get().n,3);}finally{db.close();}
 }finally{release();await pending?.catch(()=>{});await manager.close();rmSync(directory,{recursive:true,force:true});}
});

test("a failed reader recovers its configuration while the same writer and committed state remain available",async()=>{
 const directory=mkdtempSync(join(tmpdir(),"ogid-reader-recovery-")),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,"db.sqlite")});
 const runtime=createAppServer({port:0,host:'127.0.0.1',storageManager:manager,disableBackgroundRefresh:true,news:{providers:[],rssFeeds:[]},market:{provider:'',historyPersist:false,historyDir:directory,initialTickers:[],tickers:[]},agent:{mode:'off'}});
 let release,entered;const gate=new Promise(r=>{release=r;}),restoring=new Promise(r=>{entered=r;});let recovery;
 try{
  await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const writer=manager.worker,reader=manager.analysisManager;const failures=[];manager.on('failed',error=>failures.push(error));
  await reader.worker.terminate();assert.equal(failures[0].diagnostic.worker,'analysis');
  const create=manager.createAnalysisManager.bind(manager);
  manager.createAnalysisManager=()=>{const next=create(),request=next.localRequest.bind(next);next.localRequest=async(op,...args)=>{if(op==='domain.configure'){entered();await gate;}return request(op,...args);};return next;};
  recovery=manager.recoverAnalysis();await restoring;
  assert.equal((await fetch(base+'/api/health/live')).status,200);
  assert.equal((await fetch(base+'/api/health/ready')).status,503);
  await manager.request('runtime.save',{kind:'reader-recovery',payload:{persisted:true}});
  release();await Promise.all([recovery,manager.recoverAnalysis()]);
  assert.equal((await fetch(base+'/api/health/ready')).status,200);
  assert.equal(manager.worker,writer);assert.notEqual(manager.analysisManager,reader);assert.equal(manager.getStatus().analysisRecovery.recoveries,1);
  assert.equal(manager.analysisManager.getStatus().queryOnly,true);
  assert.deepEqual(await manager.request('runtime.load',{kind:'reader-recovery'}),{persisted:true});
  const technical=await manager.request('domain.call',{service:'technical',method:'get',args:[{instrumentId:listVerifiedInstruments()[0].instrumentId}]});
  assert.equal(technical.instrumentId,listVerifiedInstruments()[0].instrumentId);
 }finally{release();await recovery?.catch(()=>{});await runtime.stop();rmSync(directory,{recursive:true,force:true});}
});
