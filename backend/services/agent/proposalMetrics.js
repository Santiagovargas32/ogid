// Bounded diagnostic window. Unknown delivery and historical metadata without
// attempt telemetry never count as invalid proposals or successful repairs.
export function summarizeProposals(rows,{since,limit=1000,maxGroups=64}={}) {
  const groups=new Map();
  let excluded=0,omittedGroups=0;
  for(const row of rows.slice(0,limit)){
    const validation=typeof row.validation==='string'?JSON.parse(row.validation):row.validation;
    if(!validation || !(validation.candidateAttempts>0)){excluded++;continue;}
    const key=JSON.stringify([row.task,row.model]);
    if(!groups.has(key)){
      if(groups.size>=maxGroups){omittedGroups++;continue;}
      groups.set(key,{task:row.task,model:row.model,runs:0,initialValid:0,initialInvalid:0,initialUnknown:0,repairAttempts:0,repairValid:0,repairInvalid:0,repairUnknown:0});
    }
    const group=groups.get(key);group.runs++;
    group[{valid:'initialValid',invalid:'initialInvalid'}[validation.initialOutcome]||'initialUnknown']++;
    if(validation.repairAttempted){
      group.repairAttempts++;
      group[{valid:'repairValid',invalid:'repairInvalid'}[validation.repairOutcome]||'repairUnknown']++;
    }
  }
  return {since,limit,sampled:Math.min(rows.length,limit),truncated:rows.length>limit,excluded,omittedGroups,groups:[...groups.values()].map(group=>{
    const initialAssessed=group.initialValid+group.initialInvalid,repairAssessed=group.repairValid+group.repairInvalid;
    return {...group,initialAssessed,repairAssessed,initialConformity:initialAssessed?group.initialValid/initialAssessed:null,repairSuccess:repairAssessed?group.repairValid/repairAssessed:null};
  })};
}
