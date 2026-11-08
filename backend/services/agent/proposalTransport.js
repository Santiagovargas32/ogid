import {AGENT_PROPOSAL_TRANSPORT,isProposalTool} from '../../contracts/agentProposalTransport.js';
import {stableHash} from '../../utils/stableHash.js';
import {NARRATIVE_PROMPT_VERSION} from './narrativeFacts.js';

export const usesProposalTransport=job=>job.task!=='contextual_chat'&&['ogid-analyst-v1.21','ogid-analyst-v1.22',NARRATIVE_PROMPT_VERSION].includes(job.promptVersion);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function envelope(value,depth=0){
  if(depth>6||value==null)return null;
  if(typeof value==='string'){
    if(value.length>2097152)return null;
    try{return envelope(JSON.parse(value),depth+1);}catch{return null;}
  }
  if(!object(value)&&!Array.isArray(value)||value.isError===true)return null;
  if(object(value)&&Object.hasOwn(value,'ok'))return value;
  const children=Array.isArray(value)?value.slice(0,32):[value.structuredContent,value.content,value.text,value.output];
  for(const child of children){const found=envelope(child,depth+1);if(found)return found;}
  return null;
}

// A named terminal local MCP call is an ingress attempt, including a structural
// rejection. Its bound arguments must reach the worker's existing single
// repair, rather than trapping the model in repeated rejected tool calls.
// valid describes transport binding, never approval of the candidate content.
export function proposalReturns(assistants){
  return assistants.flatMap(message=>(message.content||[]).flatMap((part,index)=>{
    if(part.type!=='tool'||!isProposalTool(part.name))return [];
    if(part.state?.status==='error'){
      const value=part.state.error?.type==='tool.execution'?envelope(part.state.error.message):null,input=part.state.input;
      if(value?.ok!==false||value.error?.code!=='INVALID_ARGUMENTS'||value.truncated===true||
        !/^[a-f0-9]{64}$/.test(value.identity?.hash||'')||value.identity?.profile!=='agent-evidence'||
        !object(input)||typeof input.snapshotId!=='string'||!input.snapshotId.length||input.snapshotId.length>128||!object(input.proposal))return [];
      try{
        if(Buffer.byteLength(JSON.stringify(input.proposal))>2097152)return [];
        return [{toolCallId:part.id||`${message.id}:${index}`,messageId:message.id,valid:true,rejected:true,
          snapshotId:input.snapshotId,contractHash:value.identity.hash,proposal:input.proposal,proposalHash:stableHash(input.proposal)}];
      }catch{return [];}
    }
    if(part.state?.status!=='completed')return [];
    const value=envelope(part.state.output??part.state.content),input=part.state.input;
    const valid=value?.ok===true&&value.origin==='OGID'&&value.truncated!==true&&
      value.data?.transport===AGENT_PROPOSAL_TRANSPORT.version&&
      /^[a-f0-9]{64}$/.test(value.identity?.hash||'')&&value.identity?.profile==='agent-evidence'&&
      typeof value.data.snapshotId==='string'&&object(value.data.proposal)&&object(input)&&object(input.proposal)&&
      input.snapshotId===value.data.snapshotId&&stableHash(input.proposal)===stableHash(value.data.proposal);
    return [{toolCallId:part.id||`${message.id}:${index}`,messageId:message.id,valid,
      ...(valid?{snapshotId:value.data.snapshotId,contractHash:value.identity.hash,proposal:value.data.proposal,
        proposalHash:stableHash(value.data.proposal)}:{reason:'invalid-or-altered-local-return'})}];
  }));
}

export function proposalText(result,snapshotId,contractHash){
  const returns=result.proposalReturns||[];
  const fail=reason=>{throw Object.assign(Error('A single bound proposal return is required'),{code:'AGENT_INVALID_PROPOSAL_RETURN',statusCode:400,details:{reason}});};
  if(returns.length!==1)fail(returns.length?'multiple-proposals':'proposal-tool-required');
  const row=returns[0];
  if(!row.valid)fail(row.reason);
  if(row.snapshotId!==snapshotId)fail('wrong-snapshot');
  if(row.contractHash!==contractHash)fail('wrong-contract');
  return JSON.stringify(row.proposal);
}

export const proposalInstructions=snapshotId=>`Devuelve la propuesta exclusivamente mediante ogid_agent_proposal, con snapshotId=${JSON.stringify(snapshotId)} y proposal igual a una instancia del contrato con valores concretos. No devuelvas el esquema: type, properties, required y $ref describen el formato, no son valores de la propuesta. Haz antes las lecturas necesarias. Llama a esta herramienta una sola vez por intento y termina: no generes un JSON ni texto final después. Es un retorno local de datos al validador; no publica, no almacena y no acredita lectura de fuentes. Todos los campos y citas seguirán siendo validados.`;
