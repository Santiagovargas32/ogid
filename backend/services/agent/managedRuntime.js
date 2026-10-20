import {LlamaModels,catalogModel} from "./modelCatalog.js";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, createReadStream } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { generateOpenCodeConfig } from "./opencodeConfig.js";
import { OpenCodeClient } from "./opencodeClient.js";
import { readyModel } from "./config.js";

const backend=fileURLToPath(new URL("../../",import.meta.url));
const binaryHash="2df936a20cf74af5706020342164628f9a31978c50c2b0ad306b42b614fe245d";
const fresh=()=>randomBytes(32).toString("hex");
const save=(path,value)=>{writeFileSync(path,JSON.stringify(value,null,2)+"\n",{mode:0o600});chmodSync(path,0o600);};
export function prepareManagedAgentConfig(config,env=process.env) {
  if(config.mode==="off" || !Object.values(config.managed || {}).some(v=>v===true))return config;
  const directory=resolve(backend,config.managed.directory || env.AGENT_RUNTIME_DIR || "data/agent-runtime");
  mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
  const path=join(directory,"credentials.json");
  const secrets=existsSync(path)?JSON.parse(readFileSync(path)):{brokerToken:fresh(),workerToken:fresh(),opencodePassword:fresh()};
  if(Object.values(secrets).length!==3 || ["brokerToken","workerToken","opencodePassword"].some(k=>typeof secrets[k]!=="string" || secrets[k].length<32))throw Object.assign(Error(),{code:"AGENT_RUNTIME_CREDENTIALS_INVALID"});
  save(path,secrets);
  return {...config,internalToken:config.internalToken || secrets.workerToken,brokerToken:config.brokerToken || secrets.brokerToken,opencodePassword:config.opencodePassword || secrets.opencodePassword,
    managed:{...config.managed,directory,binary:resolve(backend,config.managed.binary || env.AGENT_OPENCODE_BINARY || "data/agent-runtime/bin/opencode")}};
}

// Owns only its spawned process groups. An occupied port never grants ownership.
export class ManagedAgentRuntime {
  constructor({config,environment=process.env,logger={info(){},warn(){}},spawnImpl=spawn}) {
    Object.assign(this,{config,environment:{...environment},logger,spawnImpl});
    this.controller=new AbortController();this.children=new Map();this.timers=new Set();this.retiring=new Set();this.attempts={};this.stopping=false;
    this.components=Object.fromEntries(["broker","opencode","worker"].map(name=>[name,{enabled:config.mode!=="off" && config.managed?.[name]===true,state:config.mode!=="off" && config.managed?.[name]===true?"pending":"off",pid:null,errorCode:null}]));
  }
  status(){
    const components=structuredClone(this.components),worker=components.worker;
    if(worker.state==='running' && Date.now()-Date.parse(worker.workerHealth?.reportedAt)>90000)
      Object.assign(worker,{state:'degraded',errorCode:'AGENT_WORKER_HEARTBEAT_STALE'});
    return {mode:"terminal",components};
  }
  start(baseUrl){
    if(this.boot)return this.boot;
    this.baseUrl=baseUrl;
    this.boot=this.launch().catch(error=>{if(!this.stopping){for(const c of Object.values(this.components).filter(c=>c.enabled && c.state==="pending"))Object.assign(c,{state:"degraded",errorCode:error.code || "AGENT_RUNTIME_START_FAILED"});this.logger.warn("agent_runtime_degraded",{code:error.code || "AGENT_RUNTIME_START_FAILED"});}});
    return this.boot;
  }
  async launch(){
    if(!Object.values(this.components).some(c=>c.enabled))return;
    const directory=this.config.managed.directory;
    for(const dir of ["workspace","home","config","data","state","cache","tmp"])mkdirSync(join(directory,dir),{recursive:true,mode:0o700});
    if(this.environment.LLAMACPP_BASE_URL)await new LlamaModels({upstream:this.environment.LLAMACPP_BASE_URL || 'http://127.0.0.1:8080/v1',apiKey:this.environment.LLAMACPP_API_KEY,manifest:this.config.manifest}).discover();
    const model=this.config.manifest.models.find(m=>`llamacpp/${m.alias}`===this.config.backgroundModel);
    if(!catalogModel(model)){
      for(const c of Object.values(this.components).filter(c=>c.enabled))Object.assign(c,{state:"degraded",errorCode:"AGENT_MODEL_UNVERIFIED"});
      throw Object.assign(Error(),{code:"AGENT_MODEL_UNVERIFIED"});
    }
    this.manifestPath=join(directory,"models.runtime.json");save(this.manifestPath,this.config.manifest);
    this.configPath=join(directory,"opencode.json");
    save(this.configPath,generateOpenCodeConfig({manifest:this.config.manifest,defaultModel:this.config.backgroundModel,brokerUrl:this.config.brokerUrl,mcpCommand:[process.execPath,resolve(backend,"../integrations/ogid-mcp/src/index.js")],toolNames:["ogid_read_ogid_query","ogid_read_ogid_get_capabilities","ogid_read_ogid_health"]}));
    for(const name of ["broker","opencode","worker"])if(this.components[name].enabled){try{await this.launchComponent(name);}catch(error){this.failed(name,error);}}
  }
  childEnvironment(name){
    const c=this.config,d=c.managed.directory;
    const env={PATH:this.environment.PATH || "/usr/local/bin:/usr/bin:/bin",HOME:join(d,"home"),TMPDIR:join(d,"tmp"),LANG:this.environment.LANG || "C.UTF-8",NODE_ENV:"production",OGID_MANAGED_CHILD:"1",AGENT_MODEL_MANIFEST:this.manifestPath};
    if(name==="broker")return {...env,AGENT_BROKER_URL:c.brokerUrl,AGENT_BROKER_TOKEN:c.brokerToken,LLAMACPP_BASE_URL:this.environment.LLAMACPP_BASE_URL || "http://127.0.0.1:8080/v1",LLAMACPP_API_KEY:this.environment.LLAMACPP_API_KEY || ""};
    if(name==="worker")return {...env,AGENT_MODE:c.mode,AGENT_BACKGROUND_MODEL:c.backgroundModel,AGENT_WORKER_TOKEN:c.internalToken,OGID_INTERNAL_URL:this.baseUrl,OGID_OPENCODE_URL:c.opencodeUrl,OGID_OPENCODE_PASSWORD:c.opencodePassword};
    return {...env,AGENT_BROKER_TOKEN:c.brokerToken,OPENCODE_PASSWORD:c.opencodePassword,OGID_BASE_URL:this.baseUrl,OPENCODE_CONFIG:this.configPath,OPENCODE_DISABLE_PROJECT_CONFIG:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",XDG_CONFIG_HOME:join(d,"config"),XDG_DATA_HOME:join(d,"data"),XDG_STATE_HOME:join(d,"state"),XDG_CACHE_HOME:join(d,"cache")};
  }
  async launchComponent(name){
    if(this.stopping)return;
    const state=this.components[name];Object.assign(state,{state:"starting",errorCode:null});
    const c=this.config;
    if(name==="broker" && !this.environment.LLAMACPP_API_KEY)throw Object.assign(Error(),{code:"BROKER_CREDENTIALS_REQUIRED"});
    if(name!=="worker"){
      const u=new URL(name==="broker"?c.brokerUrl:c.opencodeUrl);
      await new Promise((accept,reject)=>{const s=createServer();s.once("error",()=>reject(Object.assign(Error(),{code:"AGENT_COMPONENT_PORT_IN_USE"})));s.listen(Number(u.port || 80),"127.0.0.1",()=>s.close(accept));});
    }
    if(this.stopping)return;
    let executable=process.execPath,args=[join(backend,"scripts",name==="broker"?"agent-broker.js":"agent-worker.js")];
    if(name==="opencode"){
      executable=c.managed.binary;
      const hash=createHash("sha256");for await(const chunk of createReadStream(executable))hash.update(chunk);
      if(hash.digest("hex")!==binaryHash)throw Object.assign(Error(),{code:"OPENCODE_BINARY_UNVERIFIED"});
      args=[join(backend,"scripts/agent-opencode.js"),executable,"serve","--hostname","127.0.0.1","--port",new URL(c.opencodeUrl).port || "80"];executable=process.execPath;
    }
    const child=this.spawnImpl(executable,args,{cwd:join(c.managed.directory,"workspace"),env:this.childEnvironment(name),detached:true,stdio:["ignore","pipe","pipe","ipc"]});
    this.children.set(name,child);state.pid=child.pid || null;
    state.spawnedAt=new Date().toISOString();state.workerHealth=null;
    // Drain child output continuously, retaining only bounded counters and
    // recognized diagnostic codes. No model text, tool bodies or credentials
    // cross into the backend log. Rotation remains the existing logger's job.
    state.diagnostics={stdoutBytes:0,stderrBytes:0,lastCode:null,suppressedCodes:0};
    let lastDiagnosticAt=0;
    for(const stream of ['stdout','stderr'])child[stream]?.on('data',chunk=>{
      if(this.children.get(name)!==child)return;
      state.diagnostics[`${stream}Bytes`]+=chunk.length;
      const code=chunk.subarray(0,4096).toString().match(/\b(?:AGENT|BROKER|OPENCODE|MCP|SQLITE)_[A-Z][A-Z0-9_]{1,63}\b|\b(?:EACCES|ENOENT|ENOMEM|EADDRINUSE)\b/)?.[0];
      if(code && code!==state.diagnostics.lastCode){
        state.diagnostics.lastCode=code;
        if(Date.now()-lastDiagnosticAt>=30000){lastDiagnosticAt=Date.now();this.logger.warn('agent_child_diagnostic',{component:name,code});}
        else state.diagnostics.suppressedCodes++;
      }
    });
    child.on('message',message=>{
      if(this.children.get(name)!==child || name!=='worker' || message?.type!=='agent-worker-health' || !['connected','degraded'].includes(message.state))return;
      state.workerHealth={state:message.state,reportedAt:new Date().toISOString()};
      if(state.state!=='starting')state.state=message.state==='connected'?'running':'degraded';
      state.errorCode=message.state==='connected'?null:/^AGENT_[A-Z0-9_]{1,64}$/.test(message.errorCode || '')?message.errorCode:'AGENT_WORKER_UNAVAILABLE';
    });
    child.on("error",()=>{if(this.children.get(name)===child)this.failed(name,Object.assign(Error(),{code:"AGENT_COMPONENT_SPAWN_FAILED"}));});
    child.once("exit",(code,signal)=>{
      if(this.children.get(name)!==child)return;
      this.children.delete(name);this.signal(child,"SIGTERM");state.pid=null;
      if(this.stopping){state.state="off";return;}
      if(Date.now()-Date.parse(state.spawnedAt)>=60000)this.attempts[name]=0;
      this.logger.warn("agent_component_exited",{component:name,exitCode:code,signal,diagnostics:state.diagnostics});
      this.failed(name,Object.assign(Error(),{code:"AGENT_COMPONENT_EXITED"}));
    });
    try{await this.waitReady(name,child);}catch(error){if(this.children.get(name)!==child)return;throw error;}
    if(this.stopping || this.children.get(name)!==child)return;
    state.state="running";state.errorCode=null;
    this.logger.info("agent_component_started",{component:name,pid:child.pid});
  }
  async waitReady(name,child){
    const deadline=Date.now()+90000,c=this.config;
    while(Date.now()<deadline && !this.stopping && child.exitCode===null && this.children.get(name)===child){
      try{
        if(name==='worker'){
          if(this.components.worker.workerHealth?.state!=='connected')throw Error();
        }else if(name==="broker"){
          const r=await fetch(c.brokerUrl+"/health",{headers:{Authorization:`Bearer ${c.brokerToken}`},signal:AbortSignal.timeout(2000)});await r.body?.cancel();if(!r.ok)throw Error();
        }else await new OpenCodeClient({baseUrl:c.opencodeUrl,password:c.opencodePassword}).verify(this.controller.signal);
        return;
      }catch{await wait(500,undefined,{signal:this.controller.signal}).catch(()=>{});}
    }
    throw Object.assign(Error(),{code:"AGENT_COMPONENT_NOT_READY"});
  }
  failed(name,error){
    if(this.stopping || this.components[name].state==="restarting")return;
    const child=this.children.get(name);if(child){this.children.delete(name);const task=this.terminate(child).finally(()=>this.retiring.delete(task));this.retiring.add(task);}
    Object.assign(this.components[name],{state:"restarting",pid:null,errorCode:error.code || "AGENT_COMPONENT_FAILED"});
    this.logger.warn("agent_component_unavailable",{component:name,code:this.components[name].errorCode});
    const delay=Math.min(60000,1000*2**Math.min(this.attempts[name] || 0,6));this.attempts[name]=(this.attempts[name] || 0)+1;
    const timer=setTimeout(()=>{this.timers.delete(timer);void this.launchComponent(name).catch(e=>this.failed(name,e));},delay);timer.unref();this.timers.add(timer);
  }
  signal(child,signal){try{process.kill(-child.pid,signal);}catch{/* exited group */}}
  async terminate(child){
    if(child.pid && child.exitCode===null && child.signalCode===null){const done=once(child,"exit").catch(()=>{});this.signal(child,"SIGTERM");let timer;await Promise.race([done,new Promise(r=>{timer=setTimeout(r,10000);})]);clearTimeout(timer);if(child.exitCode===null && child.signalCode===null){this.signal(child,"SIGKILL");await done;}}
    this.signal(child,"SIGTERM");
  }
  stop(){
    if(this.stopTask)return this.stopTask;
    this.stopping=true;this.controller.abort();for(const timer of this.timers)clearTimeout(timer);this.timers.clear();
    this.stopTask=(async()=>{
      for(const name of ["worker","opencode","broker"]){
        const child=this.children.get(name);if(!child)continue;
        await this.terminate(child);this.children.delete(name);
      }
      await Promise.allSettled([...this.retiring]);
      await this.boot;
      for(const state of Object.values(this.components))Object.assign(state,{state:"off",pid:null});
    })();return this.stopTask;
  }
}
