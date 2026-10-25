// Real terminal-managed integration on an isolated database; no systemd or
// production acquisition. Requires an already verified/resident model.
import { readFileSync,mkdtempSync,writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { loadAgentConfig } from "../services/agent/config.js";
import { ensureShadowModel } from "../services/agent/shadowModel.js";
if(!process.argv.includes("--resident-model"))throw Error("Añadir --resident-model: esta prueba ejecuta inferencia local real.");
const backend=fileURLToPath(new URL("../",import.meta.url));
const settings={...dotenv.parse(readFileSync(join(backend,".env"))),...process.env};
const config=loadAgentConfig(settings);
await ensureShadowModel({manifest:config.manifest,upstream:settings.LLAMACPP_BASE_URL,apiKey:settings.LLAMACPP_API_KEY});
createRequire(import.meta.url)("../tests/testSetup.cjs");
process.env.LOG_LEVEL="error";process.env.LLAMACPP_API_KEY=settings.LLAMACPP_API_KEY;process.env.LLAMACPP_BASE_URL=settings.LLAMACPP_BASE_URL;
const {createAppServer}=await import("../server.js");
const root=mkdtempSync(resolve(backend,"../.agent-validation/terminal-real-"));
const port=async()=>{const s=createServer();s.listen(0,"127.0.0.1");await once(s,"listening");const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const runtime=createAppServer({port:0,host:"127.0.0.1",disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(root,"test.sqlite")},market:{provider:"",tickers:[],historyPersist:false},news:{providers:[],rssFeeds:[]},agent:{...config,brokerUrl:`http://127.0.0.1:${await port()}`,opencodeUrl:`http://127.0.0.1:${await port()}`,managed:{broker:true,opencode:true,worker:true,directory:join(root,"runtime"),binary:resolve(backend,settings.AGENT_OPENCODE_BINARY)}}});
const allTasks=process.argv.includes('--all-tasks');
const chatOnly=process.argv.includes('--chat-only');
// This fixture has no market/news providers or automatic analytical admission.
runtime.app.locals.agentMaintenance.enabled=false;
// Admit only this script's explicit cases; processing its fixture outbox must
// not schedule additional model generations while a case is being measured.
const fixtureCall=runtime.app.locals.agentCall;
runtime.app.locals.agentCall=(method,input)=>method==='consume'?Promise.resolve({jobs:[],hasMore:false,model:config.backgroundModel}):fixtureCall(method,input);
const report={kind:"terminal-managed-real-inference",startedAt:new Date().toISOString(),checks:[],status:"failed",productionDatabaseModified:false};
let base,cookie="",csrf="",stream,streamTask;
const request=async(path,method="GET",body,authenticated=false)=>{
  const r=await fetch(base+path,{method,headers:{"Content-Type":"application/json",...(authenticated?{Cookie:cookie,"x-ogid-csrf":csrf}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  const value=await r.json();if(!r.ok)throw Error(value.error?.code || `HTTP_${r.status}`);
  return {data:value.data,response:r};
};
const until=async(read,accept,timeout=300000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(accept(value))return value;await wait(500);}throw Error("TERMINAL_SMOKE_TIMEOUT");};
try{
  await runtime.start();base=`http://127.0.0.1:${runtime.server.address().port}`;
  await runtime.app.locals.agentRuntime.boot;
  assert.equal(Object.values(runtime.app.locals.agentRuntime.status().components).every(c=>c.state==="running"),true);
  await until(async()=>(await request("/api/admin/agent")).data,a=>a.workerHealth.state==="connected",120000);
  report.checks.push("Backend starts broker, isolated OpenCode and worker without systemd; authenticated MCP ready");
  const anonymous=await fetch(runtime.app.locals.agentConfig.opencodeUrl+"/api/info");assert.equal(anonymous.status,401);await anonymous.body.cancel();
  report.cases=[];
  if(!chatOnly){
  const brief=await runtime.app.locals.agentCall("enqueue",{task:"global_intelligence_brief",model:config.backgroundModel,key:randomUUID(),priority:10});
  const run=await until(()=>runtime.app.locals.agentCall("run",{jobId:brief.jobId,internal:true}),r=>["completed","failed","incomplete","superseded"].includes(r.status));
  assert.equal(run.status,"completed",run.errorCode || "brief failed");
  const publications=await runtime.app.locals.agentCall("publications",{includeShadow:true});assert.equal(publications.items.length>0,true);
  assert.equal((await request("/api/agent/v1/brief")).data.items.length,0);
  report.checks.push("Real background brief validated and persisted in shadow; hidden from public API");
  report.cases.push({task:'global_intelligence_brief',status:run.status});
  }
  if(allTasks){
    const at=new Date().toISOString();
    await runtime.app.locals.storageManager.request('analysis.persist',{type:'analysis',record:{kind:'technical.get',input:{instrumentId:'us-equity-oracle',interval:'1day'},result:{instrumentId:'us-equity-oracle',interval:'1day',methodVersion:'controlled-insufficient-fixture-v1',generatedAt:at,dataAsOf:at,sourceMode:'live',quality:{status:'insufficient',stale:false,synthetic:false},indicators:{rsi:{value:null,warmup:21}},methodExplanation:'Controlled missing-data fixture; no candle measurement. '.repeat(500)}}});
    for(const [task,scope]of chatOnly?[]:[['geopolitical_alert_assessment','global'],['market_outlook_global','global'],['instrument_outlook','us-equity-oracle']]){
      const admitted=await runtime.app.locals.agentCall('enqueue',{task,scope,model:config.backgroundModel,key:randomUUID(),priority:10});
      const finished=await until(()=>runtime.app.locals.agentCall('run',{jobId:admitted.jobId,internal:true}),r=>['completed','failed','incomplete','superseded'].includes(r.status),600000);
      report.cases.push({task,status:finished.status,errorCode:finished.errorCode||null});
      if(finished.status!=='completed')assert.equal((await runtime.app.locals.agentCall('publications',{includeShadow:true})).items.some(p=>p.jobId===admitted.jobId),false,'failed proposal must never publish');
    }
    if(!chatOnly)report.checks.push('All four background tasks exercised with the real model; invalid proposals remain unpublished');
  }
  const authorized=await request("/api/agent/v1/access/device","POST",{label:"Terminal isolated smoke"});
  cookie=authorized.response.headers.get("set-cookie").split(";")[0];csrf=authorized.data.csrf;
  const chat=(await request("/api/agent/v1/chat/sessions","POST",{model:config.backgroundModel,title:"Prueba terminal"},true)).data;
  const sent=(await request(`/api/agent/v1/chat/sessions/${chat.sessionId}/messages`,"POST",{key:randomUUID(),text:(allTasks?'Consulta technical.get mediante ogid_agent_evidence. Si representation=chunked lee el chunk con ogid_agent_evidence_chunk y format=utf8 antes de responder. ':'')+"Resume la cobertura y los límites del snapshot en dos frases. Incluye al menos una cita exacta [evidence:ID] de la evidencia consultada."},true)).data;
  const sse=await fetch(`${base}/api/agent/v1/chat/sessions/${chat.sessionId}/events`,{headers:{Cookie:cookie},signal:AbortSignal.timeout(300000)});assert.equal(sse.status,200);stream=sse.body.getReader();let bytes=0;
  streamTask=(async()=>{for(;;){const part=await stream.read();if(part.done)break;bytes+=part.value.length;}})().catch(()=>{});
  const chatRun=await until(()=>runtime.app.locals.agentCall("run",{jobId:sent.jobId,internal:true}),r=>["completed","failed","incomplete"].includes(r.status));
  report.cases.push({task:'contextual_chat',status:chatRun.status,errorCode:chatRun.errorCode||null});
  assert.equal(chatRun.status,"completed",chatRun.errorCode || "chat failed");
  const history=(await request(`/api/agent/v1/chat/sessions/${chat.sessionId}/messages`,"GET",undefined,true)).data;
  assert.equal(history.items.some(m=>m.role==="assistant" && m.evidenceIds?.length),true);await stream.cancel();await streamTask;
  report.chat={status:chatRun.status,messages:history.items.length,citationsValidated:true,sseBytes:bytes};
  report.checks.push("Enabled chat: device/CSRF, HTTP send, SSE, model response and cited history persisted");
  const cancel=(await request(`/api/agent/v1/chat/sessions/${chat.sessionId}/messages`,"POST",{key:randomUUID(),text:"Consulta para comprobar cancelación."},true)).data;
  await request(`/api/agent/v1/runs/${cancel.jobId}/cancel`,"POST",{},true);
  assert.equal((await runtime.app.locals.agentCall("run",{jobId:cancel.jobId,internal:true})).status,"cancelled");
  report.checks.push("Chat cancellation authorized through HTTP");
  report.processes=runtime.app.locals.agentRuntime.status();
  assert.equal(report.cases.every(c=>c.status==='completed'),true,'Some real-model proposals failed validation; inspect cases');
  report.status="passed";
}catch(error){report.errorCode=error.code || error.message;process.exitCode=1;}
finally{
  report.processes=runtime.app.locals.agentRuntime.status();
  await stream?.cancel().catch(()=>{});await streamTask;
  await runtime.stop();
  assert.equal(runtime.app.locals.agentRuntime.children.size,0);
  report.checks.push("Shutdown leaves no managed child processes");report.finishedAt=new Date().toISOString();
  writeFileSync(join(root,"result.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
  console.log(JSON.stringify({status:report.status,error:report.errorCode || null,output:join(root,"result.json"),checks:report.checks},null,2));
}
