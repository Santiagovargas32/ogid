import {prepareDirectGeneration} from './directGeneration.js';
import {stableHash} from '../../utils/stableHash.js';
import {agentError} from './contracts.js';

// Select whole source bodies, never a convenient first page or a truncated body.
// Outlook uses the canonical technical.get observations/indicators, excluding
// nonpublishable inputs explicitly; derived global snapshots duplicate those
// signals and are not required source material for this task contract.
// The source manifest stays intact; selection is explicit delivery metadata.
export const taskPacketDomains=job=>{
  switch(job.task){
    case 'global_intelligence_brief':return ['coverage',(job.input?.context||job.input?.appContext)?.alertId?'geopolitical-alert':'news'];
    case 'geopolitical_alert_assessment':return ['coverage','geopolitical-alert','news-reference','source-profile'];
    case 'instrument_outlook':
    case 'market_outlook_global':return ['coverage','technical.get'];
    case 'situation_analysis':return ['coverage','situation-source','source-profile','analysis-baseline','technical.get'];
    default:throw agentError('AGENT_DIRECT_TASK_UNSUPPORTED');
  }
};
export function prepareTaskPacket({job,snapshot,evidence,collectionReceipt}){
  if(collectionReceipt?.complete!==true||collectionReceipt.snapshotId!==snapshot.snapshotId||collectionReceipt.evidenceHash!==stableHash(evidence))
    throw agentError('AGENT_DIRECT_COLLECTION_REQUIRED');
  const domains=taskPacketDomains(job),outlook=['instrument_outlook','market_outlook_global'].includes(job.task);
  const omitted=evidence.filter(item=>outlook&&item.domain==='technical.get'&&item.publicationEligibility?.eligible!==true);
  const selected=evidence.filter(item=>domains.includes(item.domain)&&!omitted.includes(item));
  if(collectionReceipt.materialization==='selected-domains'&&stableHash(collectionReceipt.domains)!==stableHash([...domains].sort()))throw agentError('AGENT_DIRECT_COLLECTION_REQUIRED');
  if(!selected.some(item=>item.domain==='coverage'))throw agentError('AGENT_DIRECT_COVERAGE_REQUIRED');
  const selection={version:'ogid-task-packet-v2',policy:outlook?'complete-publishable-technical-domain':'complete-task-domains',domains,sourceEvidenceCount:collectionReceipt.sourceEvidenceCount??evidence.length,materializedEvidenceCount:evidence.length,deliveredEvidenceCount:selected.length,excludedEvidence:omitted.map(item=>({evidenceId:item.evidenceId,domain:item.domain,reason:item.publicationEligibility?.reason||'not-publishable'})),
    materializedEvidenceHash:collectionReceipt.evidenceHash,sourceInventoryHash:collectionReceipt.sourceInventoryHash||null,deliveredEvidenceHash:stableHash(selected),excludedDomains:[...new Set([...(collectionReceipt.excludedDomains||[]),...evidence.filter(item=>!domains.includes(item.domain)).map(item=>item.domain)])].sort(),sourceMaterialization:collectionReceipt.materialization||'entire-snapshot'};
  const prepared=prepareDirectGeneration({job,snapshot:{...snapshot,deliverySelection:selection},evidence:selected});
  return {prepared,selection};
}
