import { RUNTIME_POLICY } from "../config/runtimePolicy.js";
import { workerRssStatus } from "../services/news/rssDiagnostics.js";
// These adapters contain no historical corpus. Domain methods execute inside
// the SQLite worker; HTTP controllers and pipeline callbacks await their result.
export function createBusinessAdapters(manager, {rootDir,enabled=true,rssEnabled=false,rssIntervalMs=30000,context=()=>undefined}={}) {
  const call=(service,method,args=[],options={})=>manager.request("domain.call",{service,method,args,...(options.context?{context:context()}: {})},{timeoutMs:options.timeoutMs,signal:options.signal,requestId:options.requestId});
  const proxy=(service,methods,options={})=>Object.fromEntries(methods.map(method=>[method,(...args)=>call(service,method,args,options)]));
  let coverage={totalStored:0};
  const news=proxy("news",["search","getItem","getHistory","coverage","recordContext","getFeed","getLiveFeed","enrichEditorialPage","sourceAssessments","sourceAssessment","sourceCoverage","comparisons","comparison","comparisonClaim","comparisonChanges"]);
  news.importSourceAssessments=input=>call('news','importSourceAssessments',[input],{requestId:input.requestId});
  news.reviewComparison=input=>call('news','reviewComparison',[input],{requestId:input.requestId});
  news.getProjection=(input)=>call("news","getProjection",[input],{context:true});
  news.recordContext=snapshot=>call("news","recordContext",[{meta:{lastRefreshAt:snapshot.meta?.lastRefreshAt,dataQuality:snapshot.meta?.dataQuality},countries:snapshot.countries,impact:{items:snapshot.impact?.items || []}}]);
  const originalCoverage=news.coverage;news.coverage=async(...args)=>{coverage=await originalCoverage(...args);return coverage;};
  news.records={get size(){return coverage.totalStored;}};
  async function batches(values,work,{maxItems=100,maxBytes=128000}={}){
    if(!values?.length)return work([]);
    let batch=[],bytes=0,combined={};
    async function flush(){if(!batch.length)return;const result=await work(batch);for(const [key,value]of Object.entries(result || {}))combined[key]=typeof value==="number"&&key!=="revision"?(combined[key] || 0)+value:value;batch=[];bytes=0;}
    for(const row of values || []){const size=Buffer.byteLength(JSON.stringify(row));if(batch.length&&(bytes+size>maxBytes||batch.length>=maxItems))await flush();batch.push(row);bytes+=size;}await flush();return combined;
  }
  news.ingest=async(values,options)=>{const result=await batches(values,batch=>call("news","ingest",[batch,options]));coverage=await originalCoverage();return result;};
  const candles={...proxy("candles",["query","has","hasCandle","latest","hydrate","coverageSummary"]),enabled,rootDir};
  for(const method of ["append","upsert"])candles[method]=(values,options)=>batches(values,batch=>call("candles",method,[batch,options]),{maxItems:500,maxBytes:Math.max(1,Math.min(2097152,manager.options.maxCommandBytes-1024))});
  candles.persistDeferred=(values,options)=>manager.marketWrites.admit(values,options);
  candles.waitForPersistence=receipt=>manager.marketWrites.wait(receipt);
  const map=proxy("map",["getDashboardMapAssets","getLayerBundle","getConfig"],{context:true});
  map.getDashboardMapAssets=(input={})=>call("map","getDashboardMapAssets",[{snapshot:input.snapshot?{news:input.snapshot.news,countries:input.snapshot.countries,hotspots:input.snapshot.hotspots,meta:input.snapshot.meta}:null}],{context:true});
  const signals=proxy("signals",["recordSnapshot","getAnomalies"]);
  signals.recordSnapshot=(snapshot,aggregate)=>call("signals","recordSnapshot",[{meta:{lastRefreshAt:snapshot.meta?.lastRefreshAt},signalCorpus:snapshot.signalCorpus || [],impact:snapshot.impact,predictions:snapshot.predictions,market:{quotes:snapshot.market?.quotes || {}}},aggregate]);
  const rss={...proxy("rss",["getSnapshot","refresh"],{}),maxCorpusItems:RUNTIME_POLICY.news.rssAggregateMaxItems,
    getStatus:()=>workerRssStatus(manager.getStatus().worker?.rss),
    start(){
      if(!rssEnabled || !rssIntervalMs || rss.running)return;
      rss.running=true;
      const tick=()=>{
        rss.task=call('rss','refresh',[]).then(snapshot=>{
          if(rss.running && snapshot.meta?.acquisition?.successfulChecks)Promise.resolve(rss.onSnapshot?.(snapshot)).catch(()=>{});
        }).catch(error=>{rss.lastErrorCode=error.code || 'RSS_ACQUISITION_FAILED';}).finally(()=>{
          rss.task=null;if(rss.running){rss.timer=setTimeout(tick,rssIntervalMs);rss.timer.unref?.();}
        });
      };
      tick();
    },
    async stop(){rss.running=false;clearTimeout(rss.timer);await rss.task;}
  };
  return {call,news,candles,rss,situations:proxy('situations',['list','detail','revisions','changes','status','review']),
    store:proxy("store",["view","getRow"]),events:proxy("events",["ingest","search","replayAwareness"]),alerts:proxy("alerts",["acknowledge","delta","getChange","acknowledgeChanges","recoverCheckpoint"]),
    sources:proxy("sources",["status","run","holdings","stop"]),history:proxy("history",["create","get","run","coverage","coverageState","coverageStates","ensureCatchup","repairPlan","cancel"]),imports:proxy("imports",["datasets","datasetsPage","import"]),
    technical:proxy("technical",["get"]),indicators:proxy("indicators",["calculate"]),coupling:proxy("coupling",["calculate"]),scenarios:proxy("scenarios",["refresh","list","remove"]),
    forecasts:proxy("forecasts",["evaluate","record"]),portfolio:proxy("portfolio",["getContext"],{context:true}),
    conditions:proxy("conditions",["getSnapshot"],{context:true}),map,
    advanced:proxy("advanced",["getSnapshot"],{context:true}),signals,

  };
}
