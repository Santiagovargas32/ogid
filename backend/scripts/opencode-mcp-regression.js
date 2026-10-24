// Pinned transport regression with simulated model/provider; never uses llama.cpp.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as wait} from 'node:timers/promises';
import {generateOpenCodeConfig} from '../services/agent/opencodeConfig.js';
import {generationFor} from '../services/agent/generation.js';
import {OpenCodeClient} from '../services/agent/opencodeClient.js';

const binary=resolve(process.argv[2]||'data/agent-runtime/bin/opencode');
const digest=createHash('sha256');for await(const part of createReadStream(binary))digest.update(part);
assert.equal(digest.digest('hex'),'2df936a20cf74af5706020342164628f9a31978c50c2b0ad306b42b614fe245d');
const root=mkdtempSync(join(tmpdir(),'ogid-opencode-mcp-'));
const names=['home','data','state','cache','tmp','workspace','config'];for(const d of names)mkdirSync(join(root,d),{mode:0o700});
let child,stderrBytes=0,requests=0,steps=0,last;
const calls=[],advertised=[];
const provider=createServer(async(req,res)=>{
 if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture',object:'model'}]}));return;}
 const chunks=[];for await(const b of req)chunks.push(b);const input=JSON.parse(Buffer.concat(chunks));
 advertised.push({path:req.url,tools:input.tools?.map(t=>t.function?.name||t.name)||[],stream:input.stream});
 const name=input.tools?.find(t=>t.function?.name.endsWith('ogid_query'))?.function.name;
 let delta={content:'Transport regression finished.'},finish='stop';
 if(name&&steps<2){
  const parameters=steps===0?{snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',offset:0,format:'utf8'}:{snapshotId:'snapshot-fixture',evidenceId:42};
  calls.push({operationId:'agent.evidence.chunk',valid:steps===0});
  delta={tool_calls:[{index:0,id:`fixture-call-${++steps}`,type:'function',function:{name,arguments:JSON.stringify({operationId:'agent.evidence.chunk',parameters})}}]};finish='tool_calls';
 }
 const base={id:'fixture-completion',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture'};
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})+'\n\n');
 res.end('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n');
});
const backend=createServer((_req,res)=>{requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,data:{snapshotId:'snapshot-fixture',evidenceId:'technical-fixture',chunk:'{"data":{"value":42}}',encoding:'utf8',bytes:21,sha256:'0'.repeat(64),hasMore:false,nextOffset:21}}));});
const portServer=createServer();
try{
 for(const server of [provider,backend,portServer]){server.listen(0,'127.0.0.1');await once(server,'listening');}
 const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 const config=generateOpenCodeConfig({manifest:{models:[{alias:'fixture',state:'available',context:32768}]},brokerUrl:`http://127.0.0.1:${provider.address().port}`,defaultModel:'llamacpp/fixture',mcpCommand:[process.execPath,resolve('../integrations/ogid-mcp/src/index.js')],toolNames:['ogid_read_ogid_query','ogid_read_ogid_get_capabilities','ogid_read_ogid_health']});
 const configPath=join(root,'opencode.json');writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
 const env={PATH:process.env.PATH,HOME:join(root,'home'),TMPDIR:join(root,'tmp'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),OPENCODE_CONFIG:configPath,OPENCODE_PASSWORD:'fixture-private-password',OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1',AGENT_BROKER_TOKEN:'fixture-only',OGID_BASE_URL:`http://127.0.0.1:${backend.address().port}`};
 child=spawn(binary,['serve','--hostname','127.0.0.1','--port',String(port)],{cwd:join(root,'workspace'),env,detached:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',()=>{});child.stderr.on('data',b=>{stderrBytes+=b.length;});
 const client=new OpenCodeClient({baseUrl:`http://127.0.0.1:${port}`,password:env.OPENCODE_PASSWORD}),signal=AbortSignal.timeout(90000);
 let ready=false;while(!signal.aborted&&child.exitCode===null){try{await client.verify(signal);ready=true;break;}catch{await wait(200,undefined,{signal});}}
 assert.equal(ready,true,'isolated pinned OpenCode must be ready');
 const generation=generationFor({jobId:'fixture-job',fence:1,model:'llamacpp/fixture',task:'instrument_outlook'},{snapshotId:'snapshot-fixture'},{fixture:true});
 const session=await client.create({id:generation.sessionId,model:'llamacpp/fixture',title:'MCP regression',signal});
 const messageId=generation.messageId;await client.prompt(session.id,{messageId,text:'Execute the deterministic fixture tool calls.',signal});
 while(!signal.aborted){last=await client.progress(session.id,signal,messageId);if(last.idle&&last.messageId)break;await wait(100,undefined,{signal});}
 if(requests!==1)console.error(JSON.stringify({phase:'transport-validation',advertised,steps,requests,finish:last.finish,outcome:last.outcome,tools:last.tools,messages:(await client.messages(session.id,signal,messageId)).data.filter(m=>m.type==='assistant').map(m=>({finish:m.finish,error:m.error}))}));
 assert.equal(steps,2);assert.equal(requests,1);
 if(!last.tools.some(t=>t.applicationOk===true))console.error(JSON.stringify({phase:'receipt-decoding',advertised,tools:last.tools,outputs:(await client.messages(session.id,signal,messageId)).data.flatMap(m=>m.content||[]).filter(p=>p.type==='tool').map(p=>p.state)}));
 const read=last.tools.find(t=>t.applicationOk===true),bad=last.tools.find(t=>t.applicationCode==='INVALID_ARGUMENTS');
 assert.equal(read?.contentRead,true);assert.equal(read?.returnedSnapshotId,'snapshot-fixture');assert.equal(bad?.applicationOk,false);assert.ok(bad.validation.issues.length>0);
 console.log(JSON.stringify({passed:true,openCode:'2.0.31',provider:'simulated',operationalServicesAccessed:false,requests,calls,receipt:true,invalidArguments:true,contractHash:read.returnedContractHash,stderrBytes}));
}finally{
 if(child){try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([once(child,'exit').catch(()=>{}),wait(3000)]);try{process.kill(-child.pid,'SIGKILL');}catch{}}
 for(const server of [provider,backend,portServer]){server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}
 rmSync(root,{recursive:true,force:true});
}
