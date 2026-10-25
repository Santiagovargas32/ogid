export const NEWS_FRESHNESS_POLICY = Object.freeze({version:'news-freshness-v2',publicationMs:1800000,acquisitionMs:600000});
// A pure clock projection. Publication, acquisition and projection have separate clocks.
export function newsFreshness(corpus = {}, now = Date.now(), policy = corpus.freshnessPolicy || NEWS_FRESHNESS_POLICY) {
  const age = value => {const t=Date.parse(value);return Number.isFinite(t)&&t<=now?now-t:null;};
  const publicationAgeMs=age(corpus.latestGeopoliticalPublishedAt), acquisitionAgeMs=age(corpus.lastSuccessfulCheckAt);
  const eligible=Number(corpus.eligibleCount)>0;
  const reasons=[];
  if(!eligible)reasons.push('no-eligible-content');
  if(publicationAgeMs===null)reasons.push('content-publication-unknown');
  else if(publicationAgeMs>policy.publicationMs)reasons.push('content-publication-expired');
  if(acquisitionAgeMs===null||acquisitionAgeMs>policy.acquisitionMs)reasons.push('acquisition-check-expired');
  return {policy:{...policy},evaluatedAt:new Date(now).toISOString(),publicationAgeMs,acquisitionAgeMs,
    contentStatus:publicationAgeMs===null?'unknown':publicationAgeMs>policy.publicationMs?'stale':'recent',
    acquisitionStatus:acquisitionAgeMs===null?'unknown':acquisitionAgeMs>policy.acquisitionMs?'stale':'current',
    sourceMode:!eligible||publicationAgeMs===null?'unavailable':reasons.length?'stale':'live',staleReasons:reasons};
}
export function currentNewsCorpus(corpus,now=Date.now()) {
  if(!corpus || corpus.freshnessPolicy?.version!==NEWS_FRESHNESS_POLICY.version)return corpus;
  const freshness=newsFreshness(corpus,now);
  return {...corpus,freshness,sourceMode:freshness.sourceMode,staleReasons:freshness.staleReasons};
}
export function projectNewsMeta(meta={},now=Date.now()) {
  const original=meta.sourceMeta?.corpus,corpus=currentNewsCorpus(original,now);
  if(!corpus || corpus===original)return meta;
  return {...meta,sourceMode:corpus.sourceMode,sourceMeta:{...meta.sourceMeta,corpus},
    dataQuality:{...meta.dataQuality,news:{...meta.dataQuality?.news,mode:corpus.sourceMode,reason:corpus.staleReasons[0]||null}}};
}
