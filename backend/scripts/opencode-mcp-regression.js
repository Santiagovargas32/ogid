// Pinned transport regression with simulated model/provider; never uses llama.cpp.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as wait} from 'node:timers/promises';
import {generateOpenCodeConfig} from '../services/agent/opencodeConfig.js';
import {generationFor} from '../services/agent/generation.js';
import {OpenCodeClient} from '../services/agent/opencodeClient.js';
import {createInferenceBroker} from '../services/agent/broker.js';

const binary=resolve(process.argv[2]||'data/agent-runtime/bin/opencode');
const digest=createHash('sha256');for await(const part of createReadStream(binary))digest.update(part);
assert.equal(digest.digest('hex'),'2df936a20cf74af5706020342164628f9a31978c50c2b0ad306b42b614fe245d');
const root=mkdtempSync(join(tmpdir(),'ogid-opencode-mcp-'));
const names=['home','data','state','cache','tmp','workspace','config'];for(const d of names)mkdirSync(join(root,d),{mode:0o700});
let child,stderrBytes=0,requests=0,steps=0,last,failureMode=null,modelRequests=0;
const reasoningReplays=[];
const calls=[],advertised=[];
const provider=createServer(async(req,res)=>{
 if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture',object:'model'}]}));return;}
 const chunks=[];for await(const b of req)chunks.push(b);const input=JSON.parse(Buffer.concat(chunks));
 modelRequests++;
 if(failureMode){
  res.writeHead(200,{'content-type':'text/event-stream'});
  if(failureMode==='format')res.end('event: error\ndata: {"error":{"type":"server_error","message":"The model produced output that does not match the expected peg-native format","code":500}}\n\n');
  else res.end('data: {"choices":[{"index":0,"delta":{"content":"Unfinished private fixture"},"finish_reason":null}]}\n\n');
  return;
 }
 const system=JSON.stringify((input.messages||[]).filter(m=>m.role==='system'||m.role==='developer').map(m=>m.content));
 advertised.push({path:req.url,tools:input.tools?.map(t=>t.function?.name||t.name)||[],stream:input.stream,titleTask:/generate.{0,50}title|title.{0,50}generat/i.test(system),analyst:/analista de inteligencia/.test(system),fixtureTask:JSON.stringify(input.messages?.at(-1)?.content).includes('deterministic fixture')});
 for(const m of input.messages||[])if(m.role==='assistant'&&m.tool_calls?.length)reasoningReplays.push(m.reasoning_content==='fixture-private-reasoning');
 const name=input.tools?.find(t=>t.function?.name.endsWith('ogid_agent_evidence_chunk'))?.function.name;
 let delta={content:'Transport regression finished.'},finish='stop';
 if(name&&steps<2){
  const parameters=steps===0?{snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',offset:0,format:'utf8'}:{snapshotId:'snapshot-fixture',evidenceId:42};
  calls.push({operationId:'agent.evidence.chunk',valid:steps===0});
  delta={tool_calls:[{index:0,id:`fixture-call-${++steps}`,type:'function',function:{name,arguments:JSON.stringify(parameters)}}]};finish='tool_calls';
 }
 const base={id:'fixture-completion',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture'};
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',reasoning_content:'fixture-private-reasoning',...delta},finish_reason:null}]})+'\n\n');
 res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n');
});
const backend=createServer((_req,res)=>{requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,data:{snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',chunk:'{"data":{"value":42}}',encoding:'utf8',bytes:21,sha256:'0'.repeat(64),hasMore:false,nextOffset:21}}));});
const portServer=createServer();
const manifest={models:[{alias:'fixture',state:'ready',context:32768,tools:true,structuredOutput:true,serverContextVerified:true,probe:{verifiedAt:'2026-10-24',wireNoFixedCap:true,streaming:true,cancellation:true}}]};
let broker;
try{
 for(const server of [provider,backend,portServer]){server.listen(0,'127.0.0.1');await once(server,'listening');}
 const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 broker=createInferenceBroker({upstream:`http://127.0.0.1:${provider.address().port}`,apiKey:'fixture-only',token:'fixture-only',manifest,contextInspector:async()=>({})});broker.listen(0,'127.0.0.1');await once(broker,'listening');
 const config=generateOpenCodeConfig({manifest,brokerUrl:`http://127.0.0.1:${broker.address().port}`,defaultModel:'llamacpp/fixture',mcpCommand:[process.execPath,resolve('../integrations/ogid-mcp/src/index.js')],toolNames:['ogid_read_ogid_agent_evidence_chunk','ogid_read_ogid_get_capabilities','ogid_read_ogid_health']});
 config.providers.llamacpp.models.fixture.compatibility={reasoningField:'reasoning_content'};
 const configPath=join(root,'opencode.json');writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
 const env={PATH:process.env.PATH,HOME:join(root,'home'),TMPDIR:join(root,'tmp'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),OPENCODE_CONFIG:configPath,OPENCODE_PASSWORD:'fixture-private-password',OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1',AGENT_BROKER_TOKEN:'fixture-only',OGID_BASE_URL:`http://127.0.0.1:${backend.address().port}`};
 child=spawn(binary,['serve','--hostname','127.0.0.1','--port',String(port)],{cwd:join(root,'workspace'),env,detached:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',()=>{});child.stderr.on('data',b=>{stderrBytes+=b.length;});
 const client=new OpenCodeClient({baseUrl:`http://127.0.0.1:${port}`,password:env.OPENCODE_PASSWORD}),signal=AbortSignal.timeout(90000);
 let ready=false;while(!signal.aborted&&child.exitCode===null){try{await client.verify(signal);ready=true;break;}catch{await wait(200,undefined,{signal});}}
 assert.equal(ready,true,'isolated pinned OpenCode must be ready');
 const mcpState=await client.request('/api/mcp',{signal});console.log(JSON.stringify({phase:'mcp-ready',servers:mcpState.data?.map(s=>({name:s.name,status:s.status,keys:Object.keys(s),tools:s.tools?.map(t=>({name:t.name,enabled:t.enabled}))}))}));
 const generation=generationFor({jobId:'fixture-job',fence:1,model:'llamacpp/fixture',task:'instrument_outlook'},{snapshotId:'snapshot-fixture'},{fixture:true});
 const session=await client.create({id:generation.sessionId,model:'llamacpp/fixture',title:'MCP regression',signal});
 let messageId=generation.messageId,repairUsed=false;
 const completed=async()=>{while(!signal.aborted){last=await client.progress(session.id,signal,messageId);if(last.idle&&last.messageId)return;await wait(100,undefined,{signal});}};
 await client.prompt(session.id,{messageId,text:'Execute the deterministic fixture tool calls.',signal});await completed();
 // Exercise the SAME single missing-evidence repair used by IntelligenceWorker.
 // V2 can report MCP connected before advertising tools on the first turn.
 // Record that initial failure; never count its plain text as evidence.
 if(!last.tools.length&&steps===0&&requests===0&&last.finish==='stop'){
  repairUsed=true;messageId=generation.repairMessageId;
  await client.prompt(session.id,{messageId,text:'Missing evidence read. This is the only permitted repair. Execute the deterministic fixture tool calls.',signal});await completed();
 }
 if(requests!==1)console.error(JSON.stringify({phase:'transport-validation',advertised,steps,requests,finish:last.finish,outcome:last.outcome}));
 assert.equal(steps,2);assert.equal(requests,1);assert.ok(reasoningReplays.length>=2);assert.ok(reasoningReplays.every(Boolean),'reasoning must round-trip through both tool turns');
 if(!last.tools.some(t=>t.applicationOk===true))console.error(JSON.stringify({phase:'receipt-decoding',tools:last.tools.map(t=>({name:t.name,status:t.status,applicationCode:t.applicationCode}))}));
 const read=last.tools.find(t=>t.applicationOk===true),bad=last.tools.find(t=>t.applicationCode==='INVALID_ARGUMENTS');
 if(!bad)console.error(JSON.stringify({phase:'fixture-tool-error-shape',tools:last.tools.map(t=>({name:t.name,status:t.status,applicationCode:t.applicationCode}))}));
 assert.equal(read?.contentRead,true);assert.equal(read?.returnedSnapshotId,'snapshot-fixture');assert.equal(bad?.applicationOk,false);assert.ok(bad.validation.issues.length>0);
 const failures=[];
 for(const mode of ['format','incomplete']){
  failureMode=mode;
  const g=generationFor({jobId:'fixture-'+mode,fence:1,model:'llamacpp/fixture',task:'global_intelligence_brief'},{snapshotId:'snapshot-fixture'},{mode});
  const s=await client.create({id:g.sessionId,model:'llamacpp/fixture',title:'Terminal failure fixture',signal});await client.prompt(s.id,{messageId:g.messageId,text:'Exercise the terminal failure fixture.',signal});
  let terminal;for(let i=0;i<200;i++){terminal=await client.progress(s.id,signal,g.messageId);if(terminal.idle&&terminal.messageId)break;await wait(100,undefined,{signal});}
  if(terminal.finish!=='error')console.error(JSON.stringify({phase:'terminal-fixture',mode,modelRequests,idle:terminal.idle,finish:terminal.finish,outcome:terminal.outcome,inactive:terminal.inactive,terminalError:terminal.terminalError,messages:(await client.messages(s.id,signal,g.messageId)).data.map(m=>({type:m.type,finish:m.finish,completed:m.time?.completed,errorType:m.error?.type,parts:m.content?.map(p=>p.type)}))}));
  assert.equal(terminal.finish,'error');assert.equal(terminal.outcome,'failed');
  assert.equal(terminal.terminalError?.causeCode,mode==='format'?'LLAMACPP_OUTPUT_FORMAT':'BROKER_INCOMPLETE_STREAM');
  await client.cancel(s.id);
  failures.push({mode,cause:terminal.terminalError.causeCode});
 }
 console.log(JSON.stringify({passed:true,openCode:'2.0.31',provider:'simulated',reasoningRoundTrip:true,typedArguments:true,brokerTransport:true,repairUsed,failures,advertised,operationalServicesAccessed:false,requests,calls,receipt:true,invalidArguments:true,contractHash:read.returnedContractHash,stderrBytes}));
}finally{
 if(child){try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([once(child,'exit').catch(()=>{}),wait(3000)]);try{process.kill(-child.pid,'SIGKILL');}catch{}}
 for(const server of [broker,provider,backend,portServer].filter(Boolean)){server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}
 rmSync(root,{recursive:true,force:true});
}
