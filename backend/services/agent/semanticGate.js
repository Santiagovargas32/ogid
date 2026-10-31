export const SEMANTIC_POLICY=Object.freeze({version:'ogid-semantic-gate-v1',casesPerFamily:8,minSupport:0.95,minUtility:3,minUseful:6});
export function semanticGate(cases,reviews){
 const families=['brief','outlook','assessment','situation_analysis'];
 const results=families.map(family=>{
  const selected=cases.filter(c=>c.family===family),ids=new Set(selected.map(c=>c.id));
  const errors=[];if(selected.length!==8||ids.size!==8)errors.push('eight-unique-cases-required');
  for(const [kind,count] of [['sufficient',4],['abstention',2],['conflicting',2]])if(selected.filter(c=>c.scenario===kind).length!==count)errors.push('scenario-coverage-required');
  let useful=0,supported=0,total=0;
  for(const c of selected){
   const matching=reviews.filter(r=>r.caseId===c.id),r=matching[0];
   if(matching.length!==1||!r?.reviewer?.trim()||!r.reviewedAt||!Number.isFinite(Date.parse(r.reviewedAt))||!r.jobId||!r.snapshotId||!r.model||!r.promptVersion||!r.evidenceReviewHash){errors.push(`${c.id}:human-review-required`);continue;}
   if(r.criticalErrors!==0)errors.push(`${c.id}:critical-error`);
   if(!Number.isSafeInteger(r.supportedClaims)||!Number.isSafeInteger(r.verifiableClaims)||r.supportedClaims<0||r.supportedClaims>r.verifiableClaims){errors.push(`${c.id}:invalid-claim-count`);continue;}
   if(!Number.isInteger(r.utility)||r.utility<0||r.utility>4)errors.push(`${c.id}:invalid-utility`);
   if(c.scenario==='abstention'&&r.correctAbstention!==true)errors.push(`${c.id}:abstention-failed`);
   if(r.utility>=3)useful++;supported+=r.supportedClaims;total+=r.verifiableClaims;
  }
  if(!total||supported/total<SEMANTIC_POLICY.minSupport)errors.push('insufficient-claim-support');
  if(useful<6)errors.push('insufficient-utility');
  return {family,passed:!errors.length,cases:selected.length,supportRate:total?supported/total:null,useful,errors};
 });
 return {policy:SEMANTIC_POLICY,passed:results.every(r=>r.passed),families:results,scope:'initial-semantic-acceptance; not statistical or 24h stability'};
}
