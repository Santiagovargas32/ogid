import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AgentModelSelection} from "../services/agent/modelSelection.js";
import {createAppServer} from "../server.js";
import {OpenCodeClient} from "../services/agent/opencodeClient.js";
import {IntelligenceWorker} from "../services/agent/worker.js";

const model=alias=>({alias,state:"ready",context:8192,tools:true,structuredOutput:true,serverContextVerified:true,probe:{verifiedAt:"2026-10-18",wireNoFixedCap:true,streaming:true,cancellation:true}});
const manifest={schemaVersion:"ogid-model-catalog-v1",defaultModel:"llamacpp/first",models:[model("first"),model("second"),{alias:"unchecked",state:"context-unverified"}]};
const remote=alias=>({id:`llamacpp/${alias}`,modelID:alias,providerID:"llamacpp",name:alias,enabled:true,limit:{context:8192,output:4096},capabilities:{tools:true},settings:{apiKey:"private-provider-setting"}});

test("OpenCode model discovery is authenticated GET and exposes only local projected model fields",async()=>{
 const paths=[];const client=new OpenCodeClient({password:"private-opencode-password",fetchImpl:async(url,options)=>{
  paths.push(new URL(url).pathname);assert.equal(options.method,"GET");assert.ok(options.headers.Authorization.startsWith("Basic "));
  return Response.json({data:[remote("first"),remote("second"),{...remote("unchecked")}, {...remote("external"),providerID:"openai"}]});
 }});
 const config={mode:"shadow",manifest,backgroundModel:manifest.defaultModel};
 const service=new AgentModelSelection({config,opencode:client,call:async()=>assert.fail("discovery must not mutate")});
 const catalog=await service.list();assert.deepEqual(paths,["/api/model"]);
 assert.deepEqual(catalog.models.filter(m=>m.ready).map(m=>m.alias),["first","second"]);
 assert.equal(catalog.models.find(m=>m.alias==="unchecked").ready,false);
 assert.doesNotMatch(JSON.stringify(catalog),/private-|apiKey|settings|external/);
});

test("selection rejects absent, disabled, mismatched, unverified or unavailable models without changing the saved default",async()=>{
 for(const kind of ["missing","disabled","context","tools","unchecked","offline"]){
  let writes=0;const config={mode:"shadow",manifest,backgroundModel:manifest.defaultModel};
  const service=new AgentModelSelection({config,call:async()=>{writes++;},opencode:{models:async()=>{
   if(kind==="offline")throw Error("private network error");
   const m=remote(kind==="unchecked"?"unchecked":"second");
   if(kind==="disabled")m.enabled=false;if(kind==="context")m.limit.context=4096;if(kind==="tools")m.capabilities.tools=false;
   return {data:kind==="missing"?[]:[m]};
  }}});
  await assert.rejects(service.select(kind==="unchecked"?"llamacpp/unchecked":"llamacpp/second"));
  assert.equal(writes,0);assert.equal(config.backgroundModel,manifest.defaultModel);
 }
});

test("failed model probes remain disabled and expose only a safe diagnostic",async()=>{
 const config={mode:'shadow',manifest:structuredClone(manifest),backgroundModel:manifest.defaultModel};
 config.manifest.models.find(m=>m.alias==='unchecked').lastProbe={status:'failed',at:'2026-10-19T10:00:00.000Z',errorCode:'MODEL_LOAD_FAILED',headers:{Authorization:'PRIVATE'}};
 const service=new AgentModelSelection({config,call:async()=>assert.fail('failed probes must never change selection'),opencode:{models:async()=>({data:[remote('unchecked')]})}});
 const catalog=await service.list(),item=catalog.models.find(m=>m.alias==='unchecked');
 assert.equal(item.ready,false);assert.equal(item.reason,'AGENT_MODEL_PROBE_FAILED');assert.equal(item.validation.errorCode,'MODEL_LOAD_FAILED');assert.ok(!JSON.stringify(catalog).includes('PRIVATE'));
 await assert.rejects(service.select('llamacpp/unchecked'),{code:'AGENT_MODEL_PROBE_FAILED'});
 config.manifest.models.find(m=>m.alias==='unchecked').lastProbe.errorCode='https://private.invalid/secret';
 assert.equal((await service.list({refresh:true})).models.find(m=>m.alias==='unchecked').validation.errorCode,null);
});

test("model selection persists across npm-style restarts, replaces pending automatic work and preserves active runs and chat",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"ogid-model-selection-"));let runtime;
 const options={host:"127.0.0.1",port:0,disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(dir,"db.sqlite")},market:{provider:"",historyPersist:false,historyDir:dir},news:{providers:[],rssFeeds:[]},security:{adminApiToken:"admin-fixture",allowLocalAdmin:false},agent:{mode:"shadow",manifest,backgroundModel:manifest.defaultModel}};
 try{
  runtime=createAppServer(options);await runtime.start();
  runtime.app.locals.agentModels.opencode={models:async()=>({data:[remote("first"),remote("second")]})};
  const base=`http://127.0.0.1:${runtime.server.address().port}`,call=runtime.app.locals.agentCall;
  const send=(model,extra={})=>fetch(base+"/api/admin/agent/model",{method:"POST",headers:{Authorization:"Bearer admin-fixture","Content-Type":"application/json",...extra},body:JSON.stringify({model})});
  const active=await call("enqueue",{task:"market_outlook_global",model:manifest.defaultModel,key:"active",priority:10});
  await call("claim",{owner:"active-owner"});
  const queued=await call("enqueue",{task:"global_intelligence_brief",model:manifest.defaultModel,key:"automatic",input:{outboxSequence:4},priority:30});
  const device=await call("deviceCreate",{label:"model test"}),session=await call("sessionCreate",{deviceId:device.deviceId,model:manifest.defaultModel,title:"existing chat"});
  const chat=await call("send",{sessionId:session.sessionId,deviceId:device.deviceId,key:"chat",text:"Stored question"});
  assert.equal((await fetch(base+"/api/admin/agent/model",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"llamacpp/second"})})).status,401);
  assert.equal((await send("llamacpp/second",{Origin:"https://untrusted.invalid"})).status,403);
  runtime.app.locals.agentModelWarning="AGENT_SAVED_MODEL_UNVERIFIED";
  const changed=await send("llamacpp/second");assert.equal(changed.status,200);assert.equal((await changed.json()).data.requeued,1);
  assert.equal(runtime.app.locals.agentModelWarning,undefined);
  assert.equal((await call("run",{jobId:queued.jobId,internal:true})).status,"superseded");
  assert.equal((await call("run",{jobId:active.jobId,internal:true})).model,manifest.defaultModel);
  assert.equal((await call("run",{jobId:chat.jobId,internal:true})).model,manifest.defaultModel);
  assert.equal((await call("run",{jobId:active.jobId,internal:true})).status,"running");
  await call("control",{paused:true});assert.equal((await call("control")).backgroundModel,"llamacpp/second");
  const selectedSession=(await fetch(base+"/api/agent/v1/models").then(r=>r.json())).data;
  assert.equal(selectedSession.backgroundModel,"llamacpp/second");assert.equal(selectedSession.source,"opencode");
  await runtime.stop();runtime=createAppServer(options);await runtime.start();
  assert.equal(runtime.app.locals.agentConfig.backgroundModel,"llamacpp/second");assert.equal(runtime.app.locals.agentPaused,true);
  assert.equal((await runtime.app.locals.agentCall("sessions",{deviceId:device.deviceId})).items[0].model,manifest.defaultModel);
 }finally{await runtime?.stop();rmSync(dir,{recursive:true,force:true});}
});

test("worker adopts the backend default for subsequent jobs without changing a claimed job",async()=>{
 const worker=new IntelligenceWorker({model:"llamacpp/first",opencode:{verify:async()=>{}},call:async method=>{
  if(method==="consume")return {model:"llamacpp/second"};
  if(["reconcileCandidates","pendingCancellations"].includes(method))return [];
  if(method==="claim")return null;
 }});
 await worker.tick();assert.equal(worker.model,"llamacpp/second");worker.stop();
});
