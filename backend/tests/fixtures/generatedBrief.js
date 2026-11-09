import {usesBoundBriefPlans} from '../../services/agent/briefReports.js';
import {usesStructuredBrief} from '../../services/agent/narrativeFacts.js';
import {PROMPT_VERSION} from '../../services/agent/contracts.js';
import {proposalReturns} from '../../services/agent/proposalTransport.js';
import {AGENT_PROPOSAL_TRANSPORT} from '../../contracts/agentProposalTransport.js';
import {OPERATIONS_HASH} from '../../contracts/ogidOperations.js';

export function returnedProposal(proposal,snapshotId){
 const payload={ok:true,origin:'OGID',identity:{hash:OPERATIONS_HASH,profile:'agent-evidence'},data:{transport:AGENT_PROPOSAL_TRANSPORT.version,snapshotId,proposal}};
 return proposalReturns([{id:'fixture-return',content:[{type:'tool',id:'proposal-return',name:'ogid_read_ogid_agent_proposal',executed:false,state:{status:'completed',input:{snapshotId,proposal},content:[{type:'text',text:JSON.stringify(payload)}]}}]}]);
}

export function rejectedProposal(proposal,snapshotId){
 const error={ok:false,identity:{hash:OPERATIONS_HASH,profile:'agent-evidence'},error:{code:'INVALID_ARGUMENTS',message:'Input does not match the operation contract'}};
 return proposalReturns([{id:'fixture-rejection',content:[{type:'tool',id:'proposal-rejection',name:'ogid_read_ogid_agent_proposal',state:{status:'error',input:{snapshotId,proposal},error:{type:'tool.execution',message:JSON.stringify(error)}}}]}]);
}

// Convert only explicitly valid canonical fixture reports to model selections.
// Invalid model candidates must be constructed directly by their behavior test.
export function generatedBrief(value,job={task:value.task,promptVersion:PROMPT_VERSION}){
 if(!usesStructuredBrief(job))return value;
 const {summary,...rest}=value;
 const sources=(value.narrativeFacts||[]).filter(f=>f.kind==='reported-claim'&&f.field==='/summary');
 if(summary!=='La evidencia consultada no permite una síntesis comprobable.'&&!sources.length)throw Error('Declare the invalid model input explicitly');
 if(usesBoundBriefPlans(job)){
  const {drivers,limitations,contradictions,invalidation,intradayScenarios,scenarios,alertAssessments,...selection}=rest;
  return {...selection,direction:'unavailable',sentiment:'unavailable',stability:'unavailable',sourceReports:sources.map(({evidenceId,path,quote})=>({evidenceId,path,quote,verificationFocus:'source_verification'})),narrativeFacts:value.narrativeFacts?.filter(f=>!sources.includes(f))};
 }
 return {...rest,sourceReports:sources.map(({evidenceId,path,quote})=>({evidenceId,path,quote})),
  narrativeFacts:value.narrativeFacts?.filter(f=>!sources.includes(f)),drivers:value.drivers||[]};
}
