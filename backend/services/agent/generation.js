import {stableHash} from '../../utils/stableHash.js';
import {PROMPT_VERSION} from './contracts.js';
export function generationFor(job,snapshot,input){
  const inputHash=stableHash(input),promptVersion=job.promptVersion||PROMPT_VERSION;
  const key=stableHash([job.jobId,job.fence,snapshot.snapshotId,job.model,promptVersion,inputHash]);
  return {key,inputHash,snapshotId:snapshot.snapshotId,model:job.model,promptVersion,fence:job.fence,
    messageId:`msg_ogid_${key}`,repairMessageId:`msg_repair_${key}`,sessionId:job.task==='contextual_chat'?(job.opencodeId||`ses_ogid_${job.sessionId}`):`ses_ogid_${key}`};
}
