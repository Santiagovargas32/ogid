// Explicit operator-run campaign. The checked-in rubric is not a corpus or a pass.
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import dotenv from 'dotenv';
import {createHash} from 'node:crypto';
import {localUrl} from '../services/agent/config.js';
import {OpenCodeClient} from '../services/agent/opencodeClient.js';
import {collectSemanticBatch} from '../services/agent/semanticCampaign.js';
import {semanticCandidate,archiveSemanticCase} from '../services/agent/semanticArchive.js';
const [campaignFile,credentialFile,outputDir,family='brief']=process.argv.slice(2);
if(!campaignFile||!credentialFile||!outputDir)throw Error('Uso: node scripts/agent-semantic-collect.js campaign.json device-credential.json output-directory');
const campaign=JSON.parse(readFileSync(campaignFile)),credential=JSON.parse(readFileSync(credentialFile));
const rubric=JSON.parse(readFileSync(new URL('../evaluations/agent-semantic-cases.json',import.meta.url)));
const base=localUrl(campaign.baseUrl||'http://127.0.0.1:3000').origin,directory=resolve(outputDir);mkdirSync(directory,{recursive:true,mode:0o700});
chmodSync(directory,0o700);
const request=async(path,body)=>{
 const response=await fetch(base+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Cookie:credential.cookie,'x-ogid-csrf':credential.csrf},...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok){await response.body?.cancel();throw Error('Campaign HTTP '+response.status);}
 const reader=response.body.getReader(),parts=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2097152)throw Error('Campaign response too large');parts.push(value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const value=JSON.parse(Buffer.concat(parts).toString());return value.data||value;
};
const save=(name,value)=>{const temp=join(directory,name+'.tmp');writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temp,join(directory,name));};
const read=name=>existsSync(join(directory,name))?JSON.parse(readFileSync(join(directory,name))):null;
const env={...dotenv.parse(readFileSync(new URL('../.env',import.meta.url))),...process.env};
const secrets=JSON.parse(readFileSync(campaign.opencodeCredentialFile||new URL('../data/agent-runtime/credentials.json',import.meta.url)));
const opencode=new OpenCodeClient({baseUrl:campaign.opencodeUrl||env.OGID_OPENCODE_URL,password:secrets.opencodePassword});
const modelFile=resolve(new URL('../',import.meta.url).pathname,env.AGENT_MODEL_MANIFEST||'data/agent-runtime/models.json');
const modelHash=()=>createHash('sha256').update(readFileSync(modelFile)).digest('hex');
const modelManifestHash=modelHash(),source=semanticCandidate();
const profile=()=>createHash('sha256').update(readFileSync(new URL('../.env',import.meta.url))).update(readFileSync(campaign.llamaPresetPath||'/etc/llama-server/models.ini')).digest('hex');
const runtimeProfileHash=profile();
const previous=read('source.json');if(previous&&previous.candidateHash!==source.candidateHash)throw Error('Candidate changed; preserve the original campaign directory');
if(!previous)save('source.json',source);
const results=await collectSemanticBatch({campaign,rubric,family,candidateHash:source.candidateHash,modelManifestHash,runtimeProfileHash,read,save,request,pause:wait,exportCase:async(selected,run)=>{
 if(semanticCandidate().candidateHash!==source.candidateHash||modelHash()!==modelManifestHash||profile()!==runtimeProfileHash)throw Error('Candidate changed during collection');
 const artifact=await archiveSemanticCase({selected,run,candidateHash:source.candidateHash,modelManifestHash,runtimeProfileHash,databasePath:campaign.databasePath||env.STORAGE_DB_PATH,request,opencode});
 if(semanticCandidate().candidateHash!==source.candidateHash||modelHash()!==modelManifestHash||profile()!==runtimeProfileHash)throw Error('Candidate changed during collection');
 return artifact;
}});
for(const result of results)process.stdout.write(JSON.stringify(result)+'\n');
