import {projectNewsMeta} from './news/newsFreshness.js';
export function healthDiagnostics(locals,meta={},now=Date.now()){
  meta=projectNewsMeta(meta,now);
  const storage=locals.storageManager?.getStatus?.(),stages=locals.pipelineMonitor?.snapshot?.()||{},causes=[];
  const add=(dimension,origin,code,details={})=>{const existing=causes.find(c=>c.dimension===dimension&&c.origin===origin&&c.code===code);if(existing){Object.assign(existing,details);return;}if(causes.length<32)causes.push({dimension,origin,code,observedAt:new Date(now).toISOString(),...details});};
  for(const [name,w]of [['writer',storage],['analysis',storage?.analysis],['queries',storage?.queries]])if(w&&!['ready','disabled'].includes(w.state))add('operational',name,w.lastErrorCode||'STORAGE_NOT_READY',{state:w.state});
  if(storage?.reconciliation?.pending)add('operational','writer','STORAGE_RECONCILING');
  for(const [id,s]of Object.entries(stages)){
    if(s.enabled===false)continue;
    const qualityReason=['data-stale','data-unavailable','content-publication-expired','insufficient-coverage'].includes(s.reason);
    if(['blocked','failed','stale','degraded'].includes(s.status)&&!qualityReason)add('operational',id,s.errorCode||s.reason||`PIPELINE_${s.status.toUpperCase()}`);
    if(qualityReason&&s.reason!=='data-stale' && !(id==='news'&&['content-publication-expired','data-unavailable'].includes(s.reason)&&meta.sourceMeta?.corpus?.freshness))add('quality',id,s.reason);
    if((s.quality?.status==='stale'||s.reason==='data-stale') && !(id==='news'&&meta.sourceMeta?.corpus?.staleReasons))add('quality',id,'DATA_STALE');
  }
  const corpus=meta.sourceMeta?.corpus;
  for(const code of corpus?.staleReasons||[])add('quality','news',code,{dataAsOf:corpus.latestGeopoliticalPublishedAt||null,checkedAt:corpus.lastSuccessfulCheckAt||null});
  for(const [name,q]of Object.entries(meta.dataQuality||{}))if(['stale','unavailable','fallback'].includes(q.mode) && !(name==='news'&&corpus?.staleReasons?.length))add('quality',name,q.reason||q.mode);
  const recovery=locals.agentRuntime?.status?.().recovery;
  if(recovery?.consecutiveFailures>=3)add('quality','agent',recovery.lastFailure?.causeCode||'AGENT_GENERATION_FAILED',{nextEligibleAt:recovery.nextEligibleAt||null});
  return {sampledAt:new Date(now).toISOString(),operational:{status:causes.some(c=>c.dimension==='operational')?'degraded':locals.runtimeMetrics?.ready===false?'initializing':'ok'},quality:{status:causes.some(c=>c.dimension==='quality')?'degraded':'ok'},causes};
}
