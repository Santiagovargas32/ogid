import {NEWS_SOURCE_CATALOG,renderGeneratedSearchUrl} from '../services/news/newsSourceCatalog.js';
import {deriveFeedId,canonicalizeFeedUrl} from '../services/news/rssCanonicalCatalog.js';

const PILOTS=[
  {id:'ukraine-blacksea',label:'Ucrania / mar Negro',countries:['UA'],terms:['Ukraine','Russia','Black Sea'],sources:['rss-kyiv-independent','rss-bbc-world','rss-un-news-global']},
  {id:'redsea',label:'mar Rojo',countries:['YE'],terms:['Red Sea','Yemen'],sources:['rss-gcaptain','rss-usni-news','rss-al-jazeera','rss-un-news-global']}
];
const percentile=values=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]:null;

// Current feed checkpoints are independent of the received-at archive window.
// Unknown/stale health is never upgraded merely because a source is configured.
export function pilotCoverage(db,{from,to,now=Date.now(),catalog=NEWS_SOURCE_CATALOG}={}){
  return PILOTS.map(pilot=>{
    const selected=catalog.entries.filter(e=>pilot.sources.includes(e.sourceId)||e.type==='generated_search'&&e.countries.some(c=>pilot.terms.includes(c)));
    const observed=selected.map(entry=>{
      const url=entry.type==='generated_search'?renderGeneratedSearchUrl(entry):entry.url;
      const key='rss-canonical-feed:'+deriveFeedId(canonicalizeFeedUrl(url));
      const state=db.prepare("SELECT json_extract(payload_json,'$.lastAttemptAt') attempted,json_extract(payload_json,'$.lastSuccessAt') succeeded,json_extract(payload_json,'$.healthStatus') health,json_extract(payload_json,'$.lastHttpStatus') httpStatus FROM runtime_snapshots WHERE kind=?").get(key);
      const recent=state?.attempted>0&&now>=state.attempted&&now-state.attempted<=entry.expectedCadence.minPollIntervalMs*2;
      return {sourceId:entry.sourceId,name:entry.name,url,type:entry.type,enabled:entry.enabled,consulted:Boolean(state?.attempted),lastAttemptAt:state?.attempted?new Date(state.attempted).toISOString():null,lastSuccessAt:state?.succeeded?new Date(state.succeeded).toISOString():null,httpStatus:state?.httpStatus??null,health:!entry.enabled?'disabled':!state?.attempted?'unqueried':!recent?'stale':state.health||'unknown'};
    });
    const sources=observed.filter(x=>x.type!=='generated_search'),queries=observed.filter(x=>x.type==='generated_search');
    const rows=db.prepare(`SELECT f.article_id id,f.publisher_id publisherId,f.language,f.origin_chain_id originChainId,a.published_at publishedAt,f.received_at receivedAt,json_extract(a.payload_json,'$.provenance.publishedAtQuality') timeQuality
      FROM news_editorial_facets f JOIN articles a ON a.article_id=f.article_id WHERE f.received_at>=? AND f.received_at<=? AND EXISTS(SELECT 1 FROM json_each(f.country_mentions_json) WHERE value IN (SELECT value FROM json_each(?))) ORDER BY f.received_at DESC,f.article_id DESC LIMIT 1001`).all(from,to,JSON.stringify(pilot.countries));
    const sample=rows.slice(0,1000),languages=new Map(),origins=new Map(),latencies=[];
    for(const row of sample){languages.set(row.language||'unknown',(languages.get(row.language||'unknown')||0)+1);if(row.originChainId)origins.set(row.originChainId,(origins.get(row.originChainId)||0)+1);const delay=Date.parse(row.receivedAt)-Date.parse(row.publishedAt);if(Number.isFinite(delay)&&delay>=0&&!String(row.timeQuality||'').startsWith('fallback-'))latencies.push(delay);}
    return {id:pilot.id,label:pilot.label,selection:{countryMentions:pilot.countries,geographyPrecision:'country-mention; incident location not established'},observedAt:new Date(now).toISOString(),sources,
      configured:sources.length,enabled:sources.filter(x=>x.enabled).length,consulted:sources.filter(x=>x.consulted).length,healthy:sources.filter(x=>x.enabled&&x.health==='healthy').length,
      discoveryQueries:{configured:queries.length,enabled:queries.filter(x=>x.enabled).length,consulted:queries.filter(x=>x.consulted).length,healthy:queries.filter(x=>x.enabled&&x.health==='healthy').length},
      archiveSample:{articles:sample.length,partial:rows.length>1000,maxArticles:1000,publishers:new Set(sample.map(x=>x.publisherId).filter(Boolean)).size,unknownPublisherArticles:sample.filter(x=>!x.publisherId).length,languages:[...languages].map(([language,articles])=>({language,articles})),knownOriginChains:origins.size,sharedOriginReports:[...origins.values()].reduce((n,v)=>n+Math.max(0,v-1),0),unknownOriginArticles:sample.filter(x=>!x.originChainId).length,publicationToReception:{samples:latencies.length,p95Ms:percentile(latencies)},examples:sample.slice(0,3).map(({id,publishedAt,receivedAt})=>({articleId:id,publishedAt,receivedAt}))},
      limitations:['Country mentions select this sample; they do not verify incidents or maritime coordinates.','Feed health is current checkpoint evidence, not historical availability or regional reporting coverage.','Shared origins are a duplication indicator; unknown origins are not independent reports.','RU/UK classification requires its own evaluation and remains outside the supported language set.']};
  });
}
