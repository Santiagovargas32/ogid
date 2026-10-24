import test from "node:test";
import assert from "node:assert/strict";
import { shadowSample,recordStorageDiagnostics } from "../scripts/agent-shadow-observe.js";
import { ensureShadowModel } from "../services/agent/shadowModel.js";

test("shadow observer keeps operational evidence without credentials, devices or publication bodies", async () => {
  const sample = await shadowSample({ token:"private-admin", fetchImpl:async (url,options)=>{
    assert.equal(options.headers.Authorization,"Bearer private-admin");
    assert.equal(options.redirect,"error");
    if(url.pathname === "/api/health/ready")return Response.json({data:{status:"ready"}});
    if(url.pathname === "/api/health")return Response.json({data:{status:"ok",server:{pid:12,memory:{rss:1024}},storage:{state:"ready",queue:{pending:2,private:"secret-queue"}},pipeline:{news:{status:"healthy",body:"secret-news"}},websocket:{activeConnections:["secret-ip"]}}});
    return Response.json({data:{mode:"shadow",workerHealth:{state:"connected",owner:"secret-owner"},jobs:[{status:"completed",count:2}],runs:[{status:"completed",metadata:{prompt:"secret-prompt"}}],devices:["secret-device"],latest:{publishedAt:"2026-10-18T00:00:00Z",body:"secret-publication"}}});
  }});
  assert.equal(sample.agent.mode,"shadow");assert.equal(sample.agent.workerState,"connected");
  assert.deepEqual(sample.storage.queue,{pending:2});
  assert.deepEqual(sample.agent.jobs,[{status:"completed",count:2}]);
  assert.doesNotMatch(JSON.stringify(sample),/secret-|private-admin|Authorization/);
});

test("shadow observer records HTTP failures and network loss rather than claiming a healthy sample", async () => {
  const sample = await shadowSample({fetchImpl: async url=>{
    if(url.pathname === "/api/admin/agent")return Response.json({error:{message:"private error"}},{status:401});
    if(url.pathname === "/api/health/ready")return Response.json({data:{status:"not-ready"}},{status:503});
    throw Error("private transport error");
  }});
  assert.deepEqual(sample.http,{health:null,ready:503,agent:401});
  assert.equal(sample.agent.mode,null);assert.equal(sample.rss,null);
  assert.doesNotMatch(JSON.stringify(sample),/private/);
});

test("shadow observer exposes stale SQLite heartbeats even when HTTP remains available",async()=>{
  const heartbeatAt=new Date(Date.now()-60000).toISOString();
  const sample=await shadowSample({fetchImpl:async url=>Response.json({data:url.pathname==='/api/health'?{storage:{state:'ready',worker:{heartbeatAt,private:'secret-worker'},activeCommands:[{operation:'news.supplemental',phase:'executing',elapsedMs:50000,input:'secret-input'}],failed:2}}:{}})});
  assert.ok(sample.storage.writer.heartbeatAgeMs>=60000);
  assert.equal(sample.storage.writer.activeCommands[0].operation,'news.supplemental');
  assert.equal(sample.storage.writer.failed,2);
  assert.doesNotMatch(JSON.stringify(sample),/secret-/);
});

test('observer captures WAL debt, SQL commit waits and original failures with bounded private projections',async()=>{
  const sql={state:'idle',method:'idle',sql:"INSERT INTO fixture VALUES('secret-sql',123)",lastDurationMs:0.03,transaction:{phase:'commit',depth:1,elapsedMs:66000,private:'secret-tx'},bindings:['secret-binding']};
  const native={threadId:12,waitChannel:{available:true,value:'io_schedule',private:'secret-channel'},stack:{available:true,value:'kernel_symbol\n'.repeat(1000)},ioPressure:{available:false,code:'EACCES'},private:'secret-native'};
  const failure={code:'STORAGE_OUTCOME_UNKNOWN',causeCode:'STORAGE_DISPATCH_TIMEOUT',sqlActivity:sql,nativeWait:native,unconfirmedCommands:[{input:'secret-input'}],private:'secret-failure'};
  const checkpoint={state:'ready',mode:'PASSIVE',walBytes:200000000,backpressure:true,limitScope:'uncheckpointed-pages-and-growth',softLimitBytes:4194304,hardLimitBytes:134217728,completed:8,failures:1,connection:{queryOnly:true,synchronous:2,private:'secret-connection'},active:{elapsedMs:1234},lastResult:{log:600,checkpointed:400,pendingFrames:200,pendingBytes:819200,durationMs:37,private:'secret-result'},lastError:{code:'STORAGE_CHECKPOINT_TIMEOUT',nativeWait:native,private:'secret-error'},private:'secret-checkpoint'};
  const sample=await shadowSample({fetchImpl:async url=>Response.json({data:url.pathname==='/api/health'?{storage:{state:'failed',walCheckpoint:checkpoint,worker:{sqlActivity:sql},failure,queries:{failure}}}:{}})});
  assert.equal(sample.storage.walCheckpoint.lastResult.pendingBytes,819200);
  assert.equal(sample.storage.walCheckpoint.backpressure,true);
  assert.equal(sample.storage.walCheckpoint.connection.queryOnly,true);
  assert.equal(sample.storage.writer.sqlActivity.transaction.phase,'commit');
  assert.equal(sample.storage.writer.failure.causeCode,'STORAGE_DISPATCH_TIMEOUT');
  assert.equal(sample.storage.queries.failure.unconfirmedCount,1);
  assert.equal(sample.storage.writer.failure.nativeWait.stack.value.length,2048);
  assert.deepEqual(sample.storage.writer.failure.nativeWait.ioPressure,{available:false,value:null,code:'EACCES',truncated:null});
  assert.doesNotMatch(JSON.stringify(sample),/secret-/);
  assert.ok(JSON.stringify(sample).length<13000);
  const summary={};recordStorageDiagnostics(summary,sample);
  assert.equal(summary.walBackpressureSamples,1);assert.equal(summary.maxCheckpointPendingBytes,819200);assert.equal(summary.maxCheckpointDurationMs,37);assert.equal(summary.maxCheckpointFailures,1);
  recordStorageDiagnostics(summary,{storage:{walCheckpoint:{state:'failed',backpressure:false,failures:2,lastResult:{pendingBytes:0,durationMs:5}}}});
  assert.equal(summary.checkpointFailedSamples,1);assert.equal(summary.walBackpressureSamples,1);assert.equal(summary.maxCheckpointPendingBytes,819200);assert.equal(summary.maxCheckpointFailures,2);
});

test('observer keeps checkpoint diagnostics unknown for older or unavailable backends',async()=>{
  const sample=await shadowSample({fetchImpl:async()=>Response.json({data:{}})});
  assert.equal(sample.storage.walCheckpoint,null);assert.equal(sample.storage.writer.sqlActivity,null);assert.equal(sample.storage.writer.failure,null);
  const summary={};recordStorageDiagnostics(summary,sample);
  assert.equal(summary.checkpointUnknownSamples,1);assert.equal(summary.maxCheckpointPendingBytes,null);assert.equal(summary.maxCheckpointDurationMs,null);assert.equal(summary.maxCheckpointFailures,null);
});

test("shadow activation never evicts another model and deferred preparation cannot claim readiness", async () => {
  const manifest={schemaVersion:"ogid-model-catalog-v1",defaultModel:"llamacpp/verified",models:[{alias:"verified",state:"ready",context:65536,tools:true,structuredOutput:true,serverContextVerified:true,probe:{verifiedAt:"2026-10-18",wireNoFixedCap:true,streaming:true,cancellation:true}}]};
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url:String(url),method:options.method});return Response.json({data:[{id:"verified",status:{value:"unloaded"}},{id:"personal",status:{value:"loaded"}}]});};
  const config={manifest,upstream:"http://127.0.0.1:8080",apiKey:"private",fetchImpl};
  await assert.rejects(ensureShadowModel({...config,load:true}),/Otro modelo/);
  assert.deepEqual((await ensureShadowModel({...config,defer:true})).ready,false);
  assert.equal(calls.every(c=>c.method==="GET"),true);
});

test("shadow activation loads only the verified alias then requires the attested context", async () => {
  const manifest={schemaVersion:"ogid-model-catalog-v1",defaultModel:"llamacpp/verified",models:[{alias:"verified",state:"ready",context:65536,tools:true,structuredOutput:true,serverContextVerified:true,probe:{verifiedAt:"2026-10-18",wireNoFixedCap:true,streaming:true,cancellation:true}}]};
  const calls=[];let loaded=false;
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),method:options.method,body:options.body});
    if(url.pathname==="/models")return Response.json({data:[{id:"verified",status:{value:loaded?"loaded":"unloaded"}}]});
    if(url.pathname==="/models/load"){assert.deepEqual(JSON.parse(options.body),{model:"verified"});loaded=true;return Response.json({success:true});}
    assert.equal(url.searchParams.get("autoload"),"false");return Response.json({total_slots:1,default_generation_settings:{n_ctx:65536}});
  };
  const config={manifest,upstream:"http://127.0.0.1:8080",apiKey:"private",load:true,fetchImpl};
  assert.equal((await ensureShadowModel(config)).ready,true);
  assert.equal(calls.filter(c=>c.method==="POST").length,1);
  await assert.rejects(ensureShadowModel({...config,manifest:{...manifest,models:[{...manifest.models[0],context:131072}]}}),/Contexto/);
});

test("an explicitly released alias must be idle twice; a busy slot prevents every mutation", async () => {
  const manifest={schemaVersion:"ogid-model-catalog-v1",defaultModel:"llamacpp/verified",models:[{alias:"verified",state:"ready",context:65536,tools:true,structuredOutput:true,serverContextVerified:true,probe:{verifiedAt:"2026-10-18",wireNoFixedCap:true,streaming:true,cancellation:true}}]};
  for(const busy of [true,false]) {
    let released=false, loaded=false, checks=0, unloadPolls=0;const mutations=[];
    const config={manifest,upstream:"http://127.0.0.1:8080",apiKey:"private",load:true,releaseIdleAlias:"personal",waitImpl:async()=>{},fetchImpl:async(url,options)=>{
      if(options.method==="POST")mutations.push(url.pathname);
      if(url.pathname==="/models")return Response.json({data:[{id:"verified",status:{value:loaded?"loaded":"unloaded"}},{id:"personal",status:{value:released?(unloadPolls++===0?"unloading":"unloaded"):"loaded"}}]});
      if(url.pathname==="/slots"){checks++;return Response.json([{is_processing:busy}]);}
      if(url.pathname==="/models/unload"){released=true;return Response.json({success:true});}
      if(url.pathname==="/models/load"){loaded=true;return Response.json({success:true});}
      return Response.json({total_slots:1,default_generation_settings:{n_ctx:65536}});
    }};
    if(busy){await assert.rejects(ensureShadowModel(config),/ocupado/);assert.deepEqual(mutations,[]);}
    else{assert.equal((await ensureShadowModel(config)).ready,true);assert.equal(checks,2);assert.deepEqual(mutations,["/models/unload","/models/load"]);}
  }
});

test("an uncertain model-load response is reconciled without posting a second load", async () => {
  const manifest={schemaVersion:"ogid-model-catalog-v1",defaultModel:"llamacpp/verified",models:[{alias:"verified",state:"ready",context:65536,tools:true,structuredOutput:true,serverContextVerified:true,probe:{verifiedAt:"2026-10-18",wireNoFixedCap:true,streaming:true,cancellation:true}}]};
  let admitted=false, polls=0, posts=0;
  const value=await ensureShadowModel({manifest,upstream:"http://127.0.0.1:8080",apiKey:"private",load:true,waitImpl:async()=>{},fetchImpl:async(url,options)=>{
    if(options.method==="POST"){posts++;admitted=true;return Response.json({error:"uncertain"},{status:500});}
    if(url.pathname==="/models")return Response.json({data:[{id:"verified",status:{value:admitted?(polls++===0?"loading":"loaded"):"unloaded"}}]});
    return Response.json({total_slots:1,default_generation_settings:{n_ctx:65536}});
  }});
  assert.equal(value.ready,true);assert.equal(posts,1);
});
