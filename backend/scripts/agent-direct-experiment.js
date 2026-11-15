// Diagnostic replay only. No production database writes or publication.
import {readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {connect} from 'node:net';
import dotenv from 'dotenv';
import {loadAgentConfig,AGENT_POLICY} from '../services/agent/config.js';
import {ensureShadowModel} from '../services/agent/shadowModel.js';
import {createInferenceBroker} from '../services/agent/broker.js';
import {prepareDirectGeneration,runDirectGeneration,directBrokerCompletion} from '../services/agent/directGeneration.js';
import {semanticCandidate} from '../services/agent/semanticArchive.js';
import {stableHash} from '../utils/stableHash.js';

const [artifactPath,outputPath,...extra]=process.argv.slice(2);
if(!artifactPath||!outputPath||extra.length)throw Error('Uso: node backend/scripts/agent-direct-experiment.js artifact.json NUEVO_DIRECTORIO_PRIVADO');
const artifact=JSON.parse(readFileSync(resolve(artifactPath)));
const prepared=prepareDirectGeneration({job:artifact.run,snapshot:artifact.snapshot,evidence:artifact.evidence});
const directory=resolve(outputPath);
mkdirSync(directory,{mode:0o700}); // Exclusive: never overwrite or replay a previous attempt.
const parent=openSync(dirname(directory),'r');try{fsyncSync(parent);}finally{closeSync(parent);}
function save(name,value){const path=resolve(directory,name),fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
save('input.json',{kind:'historical-diagnostic-replay',countsForAcceptance:false,originalArtifactHash:artifact.contentHash,archiveHash:stableHash(artifact),prepared});
const env={...dotenv.parse(readFileSync(new URL('../.env',import.meta.url))),...process.env};
const config=loadAgentConfig(env),upstream=env.LLAMACPP_BASE_URL||'http://127.0.0.1:8080/v1';
const signal=AbortSignal.timeout(AGENT_POLICY.runDeadlineMs);
const controller=new AbortController();
for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>controller.abort());
const runSignal=AbortSignal.any([signal,controller.signal]);
let server;
try{
  const port=Number(env.PORT||3000);
  await new Promise((ok,fail)=>{const socket=connect({host:'127.0.0.1',port});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();fail(Error('Backend activo: detenerlo antes de este ensayo aislado'));});socket.once('error',error=>{socket.destroy();error.code==='ECONNREFUSED'?ok():fail(error);});socket.once('timeout',()=>{socket.destroy();fail(Error('No se puede verificar el puerto del backend'));});});
  const resident=await ensureShadowModel({manifest:config.manifest,upstream,apiKey:env.LLAMACPP_API_KEY});
  if('llamacpp/'+resident.alias!==prepared.input.job.model)throw Error('El modelo del archivo difiere del residente');
  const slotsResponse=await fetch(new URL('/slots?'+new URLSearchParams({model:resident.alias,autoload:'false'}),upstream),{headers:{Authorization:`Bearer ${env.LLAMACPP_API_KEY}`},signal:runSignal,redirect:'error'});
  if(!slotsResponse.ok)throw Error('No se pueden verificar los slots');
  const slots=await slotsResponse.json();if(!Array.isArray(slots)||slots.length!==1||slots.some(s=>s.is_processing!==false))throw Error('El modelo está ocupado');
  save('preflight.json',{candidate:semanticCandidate(),resident,slotsIdle:true,backendPortClosed:true,manifestHash:stableHash(config.manifest),historicalValidationAt:prepared.input.snapshot.asOf});
  const token=randomBytes(32).toString('hex');
  // In-process test harness for the existing broker, not an alternative service.
  server=createInferenceBroker({upstream,apiKey:env.LLAMACPP_API_KEY,token,manifest:config.manifest,onTelemetry:value=>{if(value.lastFailure)save('broker-failure-'+Date.now()+'.json',value);}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const complete=directBrokerCompletion({baseUrl:'http://127.0.0.1:'+server.address().port,token});
  let terminal=false;
  const result=await runDirectGeneration({prepared,complete,signal:runSignal,
    // Frozen-time validation is explicitly historical, never fresh acceptance.
    validationNow:Date.parse(prepared.input.snapshot.asOf),
    record:async event=>{if(event.state==='admitted')save('admitted.json',event);else{save('result.json',event);terminal=true;}}});
  if(!terminal)throw Error('No terminal receipt');
  console.log(JSON.stringify({state:result.state,evidenceCount:prepared.input.evidence.length,key:prepared.key,countsForAcceptance:false}));
}catch(error){save('error.json',{code:error.code||error.name,message:error.message});console.error(error.code||error.message);process.exitCode=1;}
finally{if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}}
