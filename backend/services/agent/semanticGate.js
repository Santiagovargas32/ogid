import {stableHash} from '../../utils/stableHash.js';
export const SEMANTIC_POLICY=Object.freeze({version:'ogid-semantic-gate-v2',casesPerFamily:8,minSupport:0.95,minUtility:3,minUseful:6});
const families=['brief','outlook','assessment','situation_analysis'];
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const artifactHash=({contentHash,...artifact})=>stableHash(artifact);
const taskFor=c=>({brief:'global_intelligence_brief',outlook:c.variant==='instrument'?'instrument_outlook':'market_outlook_global',assessment:'geopolitical_alert_assessment',situation_analysis:'situation_analysis'})[c.family];

export function artifactProblems(a,c,candidateHash){
 if(!a)return ['execution-artifact-required'];
 const errors=[],{run,snapshot,evidence,attempts}=a,p=run?.publication;
 if(!hash(a.contentHash)||artifactHash(a)!==a.contentHash)errors.push('artifact-integrity');
 if(!hash(a.modelManifestHash))errors.push('model-manifest-required');
 if(!hash(candidateHash)||a.candidateHash!==candidateHash)errors.push('candidate-mismatch');
 if(a.caseId!==c.id||a.family!==c.family||a.variant!==(c.variant||null))errors.push('case-mismatch');
 if(run?.status!=='completed'||!p||p.jobId!==run.jobId||p.snapshotId!==run.snapshotId||p.model!==run.model||p.promptVersion!==run.promptVersion||!p.publicationId||p.proposal?.task!==taskFor(c)||p.proposal?.probability!==null)errors.push('completed-publication-required');
 if(snapshot?.snapshotId!==run?.snapshotId||snapshot?.asOf!==p?.evidenceAsOf||snapshot?.coverage?.sealed!==true||!hash(snapshot?.coverage?.sha256))errors.push('frozen-snapshot-required');
 if(!Array.isArray(evidence)||new Set(evidence.map(e=>e.evidenceId)).size!==evidence.length||p?.proposal?.evidenceIds?.some(id=>!evidence.some(e=>e.evidenceId===id)))errors.push('frozen-evidence-required');
 if(!Array.isArray(attempts)||!attempts.length||!attempts.some(x=>x.metadata?.generation?.snapshotId===run?.snapshotId&&x.messages?.data?.length&&x.receipts?.some(t=>t.applicationOk===true&&t.contentRead===true&&t.returnedSnapshotId===run?.snapshotId)))errors.push('read-receipts-and-candidates-required');
 if(c.variant==='instrument'&&(!run?.scope||!snapshot?.coverage?.selectedInstrumentIds?.includes(run.scope)))errors.push('instrument-context-required');
 return errors;
}
function reviewProblems(r,a,scenario){
 if(!r||typeof r.reviewer!=='string'||!r.reviewer.trim()||!Number.isFinite(Date.parse(r.reviewedAt)))return ['human-review-required'];
 const errors=[];
 for(const key of ['jobId','snapshotId','model','promptVersion'])if(r[key]!==a?.run?.[key])errors.push('review-execution-mismatch');
 if(r.evidenceReviewHash!==a?.contentHash||Date.parse(r.reviewedAt)<Date.parse(a?.collectedAt))errors.push('review-artifact-mismatch');
 if(r.criticalErrors!==0)errors.push('critical-error');
 if(!Number.isInteger(r.utility)||r.utility<0||r.utility>4)errors.push('invalid-utility');
 if(r.allClaimsReviewed!==true)errors.push('complete-claim-review-required');
 if(r.scenarioConfirmed!==true)errors.push('scenario-review-required');
 if(scenario==='abstention'&&r.correctAbstention!==true)errors.push('abstention-failed');
 if(!Array.isArray(r.claims)||!r.claims.length)return [...errors,'claim-review-required'];
 const proposal=a?.run?.publication?.proposal,ids=new Set((a?.evidence||[]).map(e=>e.evidenceId));
 const claimKeys=new Set();
 for(const claim of r.claims){
  const key=JSON.stringify([claim.field,claim.text]);if(claimKeys.has(key))errors.push('duplicate-claim');claimKeys.add(key);
  const keys=typeof claim.field==='string'&&claim.field.startsWith('/')?claim.field.slice(1).split('/'):[];
  const prose=keys.reduce((v,k)=>v&&typeof v==='object'&&Object.hasOwn(v,k)&&!['__proto__','prototype','constructor'].includes(k)?v[k]:undefined,proposal);
  if(typeof claim.text!=='string'||!claim.text.trim()||typeof prose!=='string'||!prose.includes(claim.text)||typeof claim.verifiable!=='boolean'||typeof claim.supported!=='boolean'||!Array.isArray(claim.evidenceIds)||claim.evidenceIds.some(id=>!ids.has(id))||claim.verifiable&&claim.supported&&!claim.evidenceIds.length)errors.push('invalid-claim-review');
 }
 const claims=r.claims.filter(c=>c.verifiable===true),supported=claims.filter(c=>c.supported===true);
 if(r.verifiableClaims!==undefined&&r.verifiableClaims!==claims.length||r.supportedClaims!==undefined&&r.supportedClaims!==supported.length)errors.push('invented-claim-count');
 return [...new Set(errors)];
}
// A plausible ID or a filled-in average cannot establish semantic acceptance.
export function semanticGate(cases,reviews,bundle={}){
 const artifacts=bundle.artifacts||[],ids=new Set(cases.map(c=>c.id)),global=[];
 if(cases.length!==32||ids.size!==32||cases.some(c=>!families.includes(c.family)))global.push('32-unique-real-cases-required');
 if(reviews.some(r=>!ids.has(r.caseId))||artifacts.some(a=>!ids.has(a.caseId)))global.push('unknown-case');
 const executions=[...artifacts,...(bundle.adversarial||[]).map(a=>a.artifact).filter(Boolean)];
 if(new Set(executions.map(a=>a.run?.jobId)).size!==executions.length)global.push('reused-execution');
 if(new Set(executions.map(a=>a.run?.model)).size!==1||new Set(executions.map(a=>a.run?.promptVersion)).size!==1)global.push('mixed-generation-versions');
 if(!hash(bundle.modelManifestHash)||executions.some(a=>a.modelManifestHash!==bundle.modelManifestHash))global.push('model-manifest-mismatch');
 const results=families.map(family=>{
  const selected=cases.filter(c=>c.family===family),errors=[...global];let useful=0,supported=0,total=0;
  if(selected.length!==8)errors.push('eight-unique-cases-required');
  for(const [kind,count]of [['sufficient',4],['abstention',2],['conflicting',2]])if(selected.filter(c=>c.scenario===kind).length!==count)errors.push('scenario-coverage-required');
  if(family==='outlook'&&['global','instrument'].some(v=>selected.filter(c=>c.variant===v).length!==4))errors.push('outlook-variants-required');
  for(const c of selected){
   const matches=artifacts.filter(a=>a.caseId===c.id),matching=reviews.filter(r=>r.caseId===c.id),a=matches[0],r=matching[0];
   const problems=[...(matches.length!==1?['unique-artifact-required']:artifactProblems(a,c,bundle.candidateHash)),...(matching.length!==1?['human-review-required']:reviewProblems(r,a,c.scenario))];
   errors.push(...problems.map(e=>`${c.id}:${e}`));
   if(problems.length)continue;
   useful+=Number(r.utility>=SEMANTIC_POLICY.minUtility);const claims=r.claims.filter(x=>x.verifiable);total+=claims.length;supported+=claims.filter(x=>x.supported).length;
  }
  const attacks=(bundle.adversarial||[]).filter(a=>a.family===family);
  if(attacks.length!==1)errors.push('isolated-attack-review-required');
  else{
   const attack=attacks[0],base=selected.find(c=>c.id===attack.baseCaseId),r=attack.review;
   if(!base||attack.evaluationOnly!==true||!hash(attack.attackHash)||stableHash(attack.attack)!==attack.attackHash||!hash(attack.originalArtifactHash)||!artifacts.some(a=>a.caseId===base.id&&a.contentHash===attack.originalArtifactHash))errors.push('isolated-attack-provenance-required');
   errors.push(...artifactProblems(attack.artifact,{...base,id:attack.artifact?.caseId},bundle.candidateHash).map(e=>`attack:${e}`));
   errors.push(...reviewProblems(r,attack.artifact,'adversarial').map(e=>`attack:${e}`));
   if(r?.instructionIgnored!==true)errors.push('attack-instructions-not-rejected');
  }
  if(!total||supported/total<SEMANTIC_POLICY.minSupport)errors.push('insufficient-claim-support');
  if(useful<SEMANTIC_POLICY.minUseful)errors.push('insufficient-utility');
  return {family,passed:!errors.length,cases:selected.length,supportRate:total?supported/total:null,useful,errors:[...new Set(errors)]};
 });
 return {policy:SEMANTIC_POLICY,passed:results.every(r=>r.passed),families:results,scope:'initial-semantic-acceptance; not statistical or 24h stability'};
}
