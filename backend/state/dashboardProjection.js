export const DASHBOARD_PROFILE='dashboard-v1';
export const DASHBOARD_POLICY=Object.freeze({bootstrapBytes:128*1024,operationalBytes:16*1024,newsLimit:20});
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));

export function operationalSummary(pipeline={}) {
  return Object.fromEntries(Object.entries(pipeline).map(([id,stage])=>[id,pick(stage,['status','enabled','errorCode','reason','lastSuccessAt','lastRunAt'])]));
}
export function compactResource(key,value) {
  if(key==='pipelineStatus')return null;
  if(key==='meta')return {...pick(value,['lastRefreshAt','refreshIntervalMs','sourceMode','dataQuality','watchlistCountries','newsRevision','refreshStatus']),
    sourceMeta:{corpus:pick(value?.sourceMeta?.corpus,['revision','asOf','from','to','dayStart','dayTimeZone','windowHours','eligibleCount','displayCount','displayLimit','analysisCount','analysisTruncated','latestGeopoliticalPublishedAt']),
      rssIngestion:pick(value?.sourceMeta?.rssIngestion,['active','availability','lastSuccessAt'])}};
  if(key==='market')return {...pick(value,['provider','sourceMode','updatedAt','revision','session']),sourceMeta:{unavailableBySymbol:value?.sourceMeta?.unavailableBySymbol||{}},quotes:Object.fromEntries(Object.entries(value?.quotes||{}).map(([symbol,quote])=>[symbol,pick(quote,['instrumentId','symbol','canonicalSymbol','name','price','change','changePct','currency','exchange','asOf','source','sourceDetail','dataMode','synthetic','stale','session','unavailableReason','providerScore','providerLatencyMs','marketState'])]))};
  if(key==='awareness')return {...pick(value,['schemaVersion','revision','generatedAt','mode','quality','coverage']),upcoming:(value?.upcoming||[]).slice(0,5),recent:(value?.recent||[]).slice(0,5),compact:true};
  if(key==='news')return (value||[]).map(article=>pick(article,['id','identity','revision','contentRevision','title','url','publishedAt','publishedAtQuality','firstSeenAt','receivedAt','updatedAt','sourceName','publisher','publisherId','publisherResolution','transportProvider','discoverySourceId','originChainId','classification','analysisScore','countryMentions','threatLevel','severity','severityOrigin','excerpt','description','dataMode','synthetic','topicTags','provider','provenance','leadImageUrl']));
  if(key==='countries')return Object.fromEntries(Object.entries(value||{}).map(([id,country])=>[id,pick(country,['iso2','country','score','level','trend','updatedAt','metrics','topTags'])]));
  if(key==='hotspots')return (value||[]).map(country=>pick(country,['iso2','country','score','level','updatedAt']));
  if(key==='insights')return value;
  if(['predictions','impact','ai'].includes(key))return {deferred:true,available:Boolean(value),updatedAt:value?.updatedAt||null,detailResource:key};
  return undefined;
}
export function projectDashboard(snapshot,{countries=[],sources=[],limit=DASHBOARD_POLICY.newsLimit,order='recent',filterNews}={}) {
  const data={};
  for(const key of ['meta','market','countries','hotspots','insights','awareness','predictions','impact','ai'])data[key]=compactResource(key,snapshot[key]);
  const news=compactResource('news',snapshot.news);
  const countryFiltered=countries.length?news.filter(article=>article.countryMentions?.some(country=>countries.includes(country))):news;
  data.news=filterNews(countryFiltered,{sources,limit,order});
  data.meta.view={profile:DASHBOARD_PROFILE,news:{pageSize:limit,availableCount:countryFiltered.length,complete:data.news.length===countryFiltered.length}};
  data.pipelineStatus=operationalSummary(snapshot.pipelineStatus);
  return data;
}
