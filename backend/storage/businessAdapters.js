// These adapters contain no historical corpus. Domain methods execute inside
// the SQLite worker; HTTP controllers and pipeline callbacks await their result.
export function createBusinessAdapters(manager, {rootDir,enabled=true,context=()=>undefined}={}) {
  const call=(service,method,args=[],options={})=>manager.request("domain.call",{service,method,args,...(options.context?{context:context()}: {})},{timeoutMs:options.timeoutMs || (options.network?180000:manager.options.timeoutMs)});
  const proxy=(service,methods,options={})=>Object.fromEntries(methods.map(method=>[method,(...args)=>call(service,method,args,{...options,network:options.network || ["run","import","refresh"].includes(method)})]));
  let coverage={totalStored:0};
  const news=proxy("news",["search","getItem","getHistory","coverage","recordContext","getFeed","getLiveFeed"]);
  news.getProjection=(input)=>call("news","getProjection",[input],{context:true,timeoutMs:90000});
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
  const candles={...proxy("candles",["query","has","hasCandle","latest","hydrate"]),enabled,rootDir};
  for(const method of ["append","upsert"])candles[method]=(values,options)=>batches(values,batch=>call("candles",method,[batch,options]),{maxItems:500,maxBytes:Math.max(1,Math.min(2097152,manager.options.maxCommandBytes-1024))});
  const map=proxy("map",["getDashboardMapAssets","getLayerBundle","getConfig"],{context:true,network:true});
  map.getDashboardMapAssets=(input={})=>call("map","getDashboardMapAssets",[{snapshot:input.snapshot?{news:input.snapshot.news,countries:input.snapshot.countries,hotspots:input.snapshot.hotspots,meta:input.snapshot.meta}:null}],{context:true});
  const signals=proxy("signals",["recordSnapshot","getAnomalies"]);
  signals.recordSnapshot=(snapshot,aggregate)=>call("signals","recordSnapshot",[{meta:{lastRefreshAt:snapshot.meta?.lastRefreshAt},signalCorpus:snapshot.signalCorpus || [],impact:snapshot.impact,predictions:snapshot.predictions,market:{quotes:snapshot.market?.quotes || {}}},aggregate]);
  return {call,news,candles,
    store:proxy("store",["view","getRow"]),events:proxy("events",["ingest","search","replayAwareness"]),alerts:proxy("alerts",["acknowledge","delta","acknowledgeChanges","recoverCheckpoint"]),
    sources:proxy("sources",["status","run","holdings"]),history:proxy("history",["create","get","run","coverage"]),imports:proxy("imports",["datasets","import"]),
    technical:proxy("technical",["get"]),indicators:proxy("indicators",["calculate"]),coupling:proxy("coupling",["calculate"]),scenarios:proxy("scenarios",["refresh","list","remove"]),
    forecasts:proxy("forecasts",["evaluate","record"]),portfolio:proxy("portfolio",["getContext"],{context:true}),
    conditions:proxy("conditions",["getSnapshot"],{context:true}),map,
    advanced:proxy("advanced",["getSnapshot"],{context:true,network:true}),signals,
    rss:{...proxy("rss",["getSnapshot","refresh"],{network:true}),maxCorpusItems:900}
  };
}
