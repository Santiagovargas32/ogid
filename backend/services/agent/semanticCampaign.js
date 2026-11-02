import {stableHash} from '../../utils/stableHash.js';
import {AGENT_POLICY} from './config.js';
import {narrativeFields} from './narrativeFacts.js';
import {artifactHash} from './semanticGate.js';

export function validateCampaign(campaign,rubric){
 if(!/^[A-Za-z0-9._:-]{1,64}$/.test(campaign.runId)||!campaign.sessionId||!Array.isArray(campaign.cases)||campaign.cases.length!==32)throw Error('Campaign requires runId, owned sessionId and 32 real cases');
 for(const expected of rubric.cases){
  const selected=campaign.cases.filter(c=>c.id===expected.id),c=selected[0];
  if(selected.length!==1||c.family!==expected.family||(c.variant||null)!==(expected.variant||null)||c.scenario!==expected.scenario||!c.context||!c.evidenceSelectionRationale?.trim())throw Error('Record real context and scenario rationale for '+expected.id);
  if(expected.variant==='instrument'&&(!c.scope||c.scope==='global'||!c.context.instrumentIds?.includes(c.scope)))throw Error('Instrument context required for '+expected.id);
 }
}
export function reviewTemplate(artifact){
 return {caseId:artifact.caseId,jobId:artifact.run.jobId,snapshotId:artifact.run.snapshotId,model:artifact.run.model,promptVersion:artifact.run.promptVersion,evidenceReviewHash:artifact.contentHash,reviewer:'',reviewedAt:null,scenarioConfirmed:null,allClaimsReviewed:false,criticalErrors:null,utility:null,correctAbstention:null,
  claims:[...narrativeFields(artifact.run.publication?.proposal||{}).entries()].map(([field,row])=>({field,text:row.text,evidenceIds:row.refs,verifiable:null,supported:null}))};
}
// Files and HTTP are injected so recovery is tested without inference. An
// admission is durable before polling. A lost ACK reuses the exact same key.
export async function collectSemanticBatch({campaign,rubric,family,candidateHash,modelManifestHash,read,save,request,exportCase,pause,now=Date.now}){
 validateCampaign(campaign,rubric);
 const selected=campaign.cases.filter(c=>c.family===family);if(selected.length!==8)throw Error('Select one family of eight');
 const manifest={version:'ogid-semantic-campaign-v2',candidateHash,modelManifestHash,campaignHash:stableHash(campaign),rubricHash:stableHash(rubric)},old=read('manifest.json');
 if(old&&stableHash(old)!==stableHash(manifest))throw Error('Campaign or candidate changed; preserve this directory and use a new runId');
 save('manifest.json',manifest);save('campaign.json',campaign);save('rubric.json',rubric);
 const results=read('results.json')||[];
 for(const c of selected){
  const existing=read(c.id+'-artifact.json');
  if(existing){if(existing.candidateHash!==candidateHash||existing.contentHash!==artifactHash(existing)||existing.caseId!==c.id||existing.run.sessionId!==campaign.sessionId||existing.run.status==='incomplete')throw Error('Reconcile existing artifact before continuing');continue;}
  let admission=read(c.id+'-admission.json');
  if(!admission){admission=await request(`/api/agent/v1/chat/sessions/${encodeURIComponent(campaign.sessionId)}/requests`,{family:c.family,scope:c.scope,context:c.context,key:`eval:${campaign.runId}:${c.id}`});save(c.id+'-admission.json',admission);}
  let run;const started=now();
  do{
   run=await request('/api/agent/v1/runs/'+encodeURIComponent(admission.jobId));save(c.id+'-run.json',run);
   if(run.sessionId!==campaign.sessionId||run.jobId!==admission.jobId)throw Error('Owned execution identity mismatch');
   if(['completed','failed','cancelled','incomplete','superseded'].includes(run.status))break;
   await pause(5000);
  }while(now()-started<AGENT_POLICY.runDeadlineMs);
  const result={caseId:c.id,jobId:run.jobId,status:run.status,snapshotId:run.snapshotId,model:run.model,promptVersion:run.promptVersion};
  const at=results.findIndex(r=>r.caseId===c.id);if(at===-1)results.push(result);else results[at]=result;save('results.json',results);
  if(!['completed','failed','cancelled','superseded'].includes(run.status))throw Error('Unresolved execution; reconcile the same job before continuing');
  const artifact=await exportCase(c,run);save(c.id+'-artifact.json',artifact);
  if(!read(c.id+'-review.json'))save(c.id+'-review.json',reviewTemplate(artifact));
 }
 return results.filter(r=>selected.some(c=>c.id===r.caseId));
}
