// Explicit operator-run campaign. The checked-in rubric is not a corpus or a pass.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {localUrl} from '../services/agent/config.js';
const [campaignFile,credentialFile,outputDir]=process.argv.slice(2);
if(!campaignFile||!credentialFile||!outputDir)throw Error('Uso: node scripts/agent-semantic-collect.js campaign.json device-credential.json output-directory');
const campaign=JSON.parse(readFileSync(campaignFile)),credential=JSON.parse(readFileSync(credentialFile));
const rubric=JSON.parse(readFileSync(new URL('../evaluations/agent-semantic-cases.json',import.meta.url)));
if(!/^[A-Za-z0-9._:-]{1,64}$/.test(campaign.runId)||!campaign.sessionId||!Array.isArray(campaign.cases)||campaign.cases.length!==32)throw Error('Campaign requires runId, owned sessionId and 32 real cases');
for(const expected of rubric.cases){const selected=campaign.cases.filter(c=>c.id===expected.id);if(selected.length!==1||selected[0].family!==expected.family||!selected[0].context||!selected[0].evidenceSelectionRationale?.trim())throw Error('Record real context and selection rationale for '+expected.id);}
const base=localUrl(campaign.baseUrl||'http://127.0.0.1:3000').origin,directory=resolve(outputDir);mkdirSync(directory,{recursive:true,mode:0o700});
const request=async(path,body)=>{const response=await fetch(base+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Cookie:credential.cookie,'x-ogid-csrf':credential.csrf},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw Error('Campaign HTTP '+response.status);const value=await response.json();return value.data||value;};
const save=(name,value)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
save('campaign.json',campaign);save('rubric.json',rubric);const results=[];
for(const selected of campaign.cases){
 const job=await request(`/api/agent/v1/chat/sessions/${encodeURIComponent(campaign.sessionId)}/requests`,{family:selected.family,scope:selected.scope,context:selected.context,key:`eval:${campaign.runId}:${selected.id}`});save(selected.id+'-admission.json',job);
 let run;const started=Date.now();
 do{run=await request('/api/agent/v1/runs/'+job.jobId);save(selected.id+'-run.json',run);if(['completed','failed','cancelled','incomplete','superseded'].includes(run.status))break;await wait(5000);}while(Date.now()-started<1800000);
 results.push({caseId:selected.id,jobId:job.jobId,status:run.status,snapshotId:run.snapshotId,model:run.model,promptVersion:run.promptVersion});save('results.json',results);
 if(!['completed','failed','cancelled','incomplete','superseded'].includes(run.status))throw Error('Observation ended with unresolved run; reconcile before continuing');
 process.stdout.write(JSON.stringify(results.at(-1))+'\n');
}
