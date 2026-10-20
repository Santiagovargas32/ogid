// Explicit local model discovery/probing. Never writes the business database.
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import dotenv from 'dotenv';
import {loadAgentConfig} from '../services/agent/config.js';
import {LlamaModels} from '../services/agent/modelCatalog.js';
const args=process.argv.slice(2),all=args.includes('--validate-all'),resident=args.includes('--validate-resident'),write=args.includes('--write-catalog'),output=args.find(x=>x.startsWith('--output='))?.slice(9),selected=args.filter(x=>x.startsWith('--validate-model=')).map(x=>x.slice(17));
if(args.some(x=>!['--validate-all','--validate-resident','--write-catalog'].includes(x)&&!x.startsWith('--output=')&&!x.startsWith('--validate-model='))||!output||all&&resident)throw Error('Usage: agent-model-catalog --output=report.json [--validate-all|--validate-resident] [--write-catalog]');
const env={...dotenv.parse(readFileSync(new URL('../.env',import.meta.url))),...process.env},config=loadAgentConfig(env),manifest=config.manifest;manifest.defaultModel=config.backgroundModel;
const gateway=new LlamaModels({upstream:env.LLAMACPP_BASE_URL,apiKey:env.LLAMACPP_API_KEY,manifest});const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
const report={startedAt:new Date().toISOString(),kind:'explicit router model contract validation',defaultModel:manifest.defaultModel,results:[],productionDatabaseModified:false};
try{
 await gateway.discover(controller.signal);
 for(const model of manifest.models){
  if(!(all||resident&&model.resident||selected.includes(model.alias))){report.results.push({alias:model.alias,state:'discovered',context:model.context,resident:model.resident});continue;}
  model.state='available';const start=Date.now();console.log(JSON.stringify({alias:model.alias,phase:'load-and-probe'}));
  try{await gateway.validate(model.alias,controller.signal);report.results.push({alias:model.alias,state:'passed',context:model.context,durationMs:Date.now()-start});}
  catch(error){report.results.push({alias:model.alias,state:'failed',errorCode:model.lastProbe?.errorCode||error.code||'AGENT_MODEL_PROBE_FAILED',durationMs:Date.now()-start});}
  console.log(JSON.stringify(report.results.at(-1)));
  if(controller.signal.aborted)break;
 }
}finally{
 if(all||resident||selected.length){try{await gateway.load(manifest.defaultModel.replace(/^llamacpp\//,''),AbortSignal.timeout(420000));report.defaultRestored=true;}catch(error){report.defaultRestored=false;report.restoreErrorCode=error.code||'AGENT_MODEL_RESTORE_FAILED';}}
 if(write){const file=resolve(env.AGENT_MODEL_MANIFEST),temporary=file+'.tmp';writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});renameSync(temporary,file);report.catalogWritten=true;}
 report.finishedAt=new Date().toISOString();report.status=report.results.some(r=>r.state==='failed')?'partial':controller.signal.aborted?'interrupted':'passed';writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}
