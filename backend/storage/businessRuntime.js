import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { SqlResearchStore, SqlCandleStore, SqlAlertStore, SqlEventLedger, readMeta, writeMeta, instrumentRow, sourceRow } from "./sqlRepositories.js";
import { SqlNewsArchive } from "./sqlNewsArchive.js";
import { SqlNewsCorpus } from "./sqlNewsCorpus.js";
import { SqlNewsPipeline } from "./sqlNewsPipeline.js";
import { EventLedger } from "../services/research/eventLedger.js";
import { OfficialSourceService, loadResearchSources } from "../services/research/officialSources.js";
import { HistoricalAcquisitionService } from "../services/market/historicalAcquisitionService.js";
import { HistoricalImportService } from "../services/market/historicalImportService.js";
import { TechnicalContextService } from "../services/market/technicalContextService.js";
import { TechnicalIndicatorService } from "../services/market/technicalIndicatorService.js";
import { NewsPriceCouplingService } from "../services/market/newsPriceCouplingService.js";
import { ScenarioService } from "../services/research/scenarioService.js";
import { ForecastEvaluationService } from "../services/research/forecastEvaluationService.js";
import { PortfolioContextService } from "../services/research/portfolioContext.js";
import { RssAggregatorService } from "../services/news/rssAggregator.js";
import { fetchRss } from "../services/news/providers/rssProvider.js";
import { registerInstruments, listVerifiedInstruments, getInstrumentByCanonicalSymbol } from "../services/market/instrumentRegistry.js";
import { AppError } from "../utils/error.js";
import { stableHash } from "../utils/stableHash.js";
import { MarketConditionsService } from "../services/market/marketConditionsService.js";
import { MapLayerService } from "../services/map/mapLayerService.js";
import { AdvancedIntelligenceService } from "../services/intel/advancedIntelligenceService.js";
import { SignalCorrelatorService } from "../services/intel/signalCorrelator.js";
import { SqlAwarenessStore } from "./sqlAwarenessStore.js";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";

const METHODS={awareness:["parseSource","getSnapshot","reconcile","setSourceStale"],store:["view","getRow"],news:["ingest","recordContext","search","getItem","getHistory","coverage","getProjection","getFeed","getLiveFeed"],events:["ingest","search","replayAwareness"],alerts:["acknowledge","delta","acknowledgeChanges","recoverCheckpoint"],sources:["status","run","holdings"],history:["create","get","run","coverage"],imports:["datasets","import"],technical:["get"],indicators:["calculate"],coupling:["calculate"],scenarios:["refresh","list","remove"],forecasts:["evaluate","record"],portfolio:["getContext"],rss:["getSnapshot","refresh"],conditions:["getSnapshot"],map:["getDashboardMapAssets","getLayerBundle","getConfig"],advanced:["getSnapshot"],signals:["recordSnapshot","getAnomalies"],candles:["query","append","upsert","latest","has","hasCandle","hydrate"]};
export class BusinessRuntime {
  constructor(db,rpc){Object.assign(this,{db,rpc});this.services=null;this.rssCursor=0;}
  registry(instruments){
    registerInstruments(instruments || []);for(const i of listVerifiedInstruments())instrumentRow(this.db,i.instrumentId);
    const universe=listVerifiedInstruments(),fingerprint=stableHash(universe.map(i=>[i.instrumentId,i.canonicalSymbol,i.aliases,i.companyId]));
    if(readMeta(this.db,"events.index",null)!==fingerprint){
      this.db.transaction(()=>{
        this.db.prepare("DELETE FROM event_instruments").run();
        const ledger=new EventLedger({store:{}});
        for(let offset=0;;offset+=256){const page=this.db.prepare("SELECT payload_json FROM events ORDER BY event_id LIMIT 256 OFFSET ?").all(offset);if(!page.length)break;for(const row of page)for(const impact of ledger.impact(JSON.parse(row.payload_json),universe))this.db.prepare("INSERT INTO event_instruments VALUES(?,?,?)").run(JSON.parse(row.payload_json).eventId,impact.instrumentId,JSON.stringify(impact));}
        writeMeta(this.db,"events.index",fingerprint);
      }).immediate();
    }
    return {registered:universe.length};
  }
  close(){this.services?.news.close();}
  restoreQuotas(){for(const [provider,saved]of Object.entries(this.load("provider-quota")?.providers || {})){apiQuotaTracker.ensureProvider(provider);Object.assign(apiQuotaTracker.providers[provider],saved);}}
  configure(input={}){
    if(input.requireImport&&!readMeta(this.db,"import.ready",false))throw new AppError("Ejecutar storage:migrate antes de activar el servicio SQL.",503,"STORAGE_IMPORT_REQUIRED");
    if(input.requireImport)this.db.prepare("UPDATE pipeline_runs SET status='failed',completed_at=?,error_code='STORAGE_RESTART_INTERRUPTED' WHERE status='running'").run(new Date().toISOString());
    this.close();
    loadResearchSources(process.env.RESEARCH_SOURCES_FILE);
    this.registry(input.instruments);
    apiQuotaTracker.reset(input.apiLimits || {});this.restoreQuotas();
    const store=new SqlResearchStore(this.db),candles=new SqlCandleStore(this.db,{rootDir:input.rootDir,enabled:input.candlesEnabled}),alerts=new SqlAlertStore(this.db),events=new SqlEventLedger({store}),news=new SqlNewsArchive(this.db,{retentionDays:input.newsRetentionDays || 30});
    news.onIngest=items=>{for(let offset=0;offset<items.length;offset+=500)events.ingest(items.slice(offset,offset+500));};
    const imports=new HistoricalImportService({ledger:store,rootDir:input.rootDir});imports.open=datasetId=>new SqlCandleStore(this.db,{datasetId,rootDir:input.rootDir});
    const technical=new TechnicalContextService({store:candles,imports}),scenarios=new ScenarioService({alerts,technicalContext:technical,eventLedger:events,candleStore:candles,policy:input.signalPolicy});
    this.contextStorage=new AsyncLocalStorage();
    this.defaultContext={snapshot:{},signalCorpus:[],marketSignalCorpus:[],awareness:{mode:input.awarenessMode || "off",upcoming:[],recent:[]},selectedInstrumentIds:[],intradayMetrics:{}};
    Object.defineProperty(this,"context",{configurable:true,get:()=>this.contextStorage.getStore() || this.defaultContext});
    this.newsCorpus=new SqlNewsCorpus(news,{...input.news,awarenessMode:input.awarenessMode});
    this.newsPipeline=new SqlNewsPipeline(this,news,this.newsCorpus,{...input.news,awarenessMode:input.awarenessMode});
    news.getProjection=(...args)=>this.newsPipeline.getProjection(...args);
    news.getFeed=(...args)=>this.newsPipeline.getFeed(...args);
    news.getLiveFeed=(...args)=>this.newsCorpus.getLiveFeed(...args);
    const stateManager={getSnapshot:()=>this.context.snapshot,getSignalCorpus:()=>this.context.signalCorpus,getMarketSignalCorpus:()=>this.context.marketSignalCorpus};
    const rssReadView={maxCorpusItems:input.news?.analyzeLimit || 3000,getSnapshot:options=>this.newsCorpus.getFeed({...options,windowHours:this.context.newsWindowHours,awarenessMode:this.context.awareness?.mode || input.awarenessMode})};
    const awarenessService={getSnapshot:()=>structuredClone(this.context.awareness)};
    const runtime=this,watchlist={get selectedInstrumentIds(){return runtime.context.selectedInstrumentIds;},selectedInstruments:()=>listVerifiedInstruments().filter(i=>this.context.selectedInstrumentIds.includes(i.instrumentId))};
    const signals=new SignalCorrelatorService({persistencePath:null});
    const savedSignals=this.load("signals");if(savedSignals)signals.history=savedSignals.history || savedSignals;
    const persistedSignalRows=new Map(this.db.prepare("SELECT signal,country,bucket,value FROM signal_buckets").all().map(row=>[JSON.stringify([row.signal,row.country,row.bucket]),row.value]));
    signals.persist=()=>{
      const next=new Map();
      this.db.transaction(()=>{
        this.save("signals",signals.history);
        for(const [signal,rows]of Object.entries(signals.history))for(const row of rows)for(const [country,value]of Object.entries(row.byCountry || {})){
          const key=JSON.stringify([signal,country,row.timestamp]);next.set(key,value);
          if(!persistedSignalRows.has(key)||persistedSignalRows.get(key)!==value)this.db.prepare("INSERT INTO signal_buckets VALUES(?,?,?,?,?) ON CONFLICT(signal,country,bucket) DO UPDATE SET observed_at=excluded.observed_at,value=excluded.value").run(row.timestamp,signal,country,row.timestamp,value);
        }
        for(const key of persistedSignalRows.keys())if(!next.has(key))this.db.prepare("DELETE FROM signal_buckets WHERE signal=? AND country=? AND bucket=?").run(...JSON.parse(key));
      }).immediate();persistedSignalRows.clear();for(const [key,value]of next)persistedSignalRows.set(key,value);
    };
    const rss=new RssAggregatorService({...input.rss,persistencePath:null,onCollected:async articles=>{
      for(let offset=0;offset<articles.length;offset+=100){
        news.ingest(articles.slice(offset,offset+100),{awarenessMode:input.awarenessMode});
        await new Promise(resolve=>setImmediate(resolve));
      }
    }});
    const canonical=this.load("rss-canonical");if(canonical){rss.canonicalPipeline.states=new Map(Object.entries(canonical.states || {}));rss.canonicalPipeline.corpus=canonical.corpus || [];rss.canonicalPipeline.metrics={...rss.canonicalPipeline.metrics,...canonical.metrics};}
    rss.canonicalPipeline.persist=()=>this.save("rss-canonical",{version:1,states:Object.fromEntries(rss.canonicalPipeline.states),corpus:rss.canonicalPipeline.corpus,metrics:rss.canonicalPipeline.metrics});
    const savedRss=this.load("rss");if(savedRss){rss.lastSnapshot=savedRss;rss.corpus=savedRss.items || [];}
    this.persistedRssSnapshot=savedRss || null;
    if(input.news){
      const generated=this.load("rss-generated") || {};
      this.rssGeneratedCursor=generated.nextOffset || 0;
      this.nextGeneratedCollectAt=generated.nextCollectAt || 0;
      // Primary feeds already have their own fast, persistent rotation. Retain
      // the existing generated searches without downloading primaries twice.
      rss.nextFeedBatch=()=>{
        const feeds=rss.feedCatalog.filter(feed=>feed.generated && !feed.disabled),batch=[];
        for(let i=0;i<Math.min(rss.maxFeedsPerRun,feeds.length);i++)batch.push(feeds[(this.rssGeneratedCursor+i)%feeds.length]);
        this.rssGeneratedCursor=feeds.length?(this.rssGeneratedCursor+batch.length)%feeds.length:0;
        return batch;
      };
    }
    const savedFeedStatus=this.load("rss-feeds");this.rssCursor=savedFeedStatus?.nextFeedOffset || 0;this.rssFeedStatuses=new Map(Object.entries(savedFeedStatus?.feeds || {}));
    this.services={store,news,events,alerts,candles,imports,technical,scenarios,signals,rss,awareness:new SqlAwarenessStore(this.db),
      sources:new OfficialSourceService({store,eventLedger:events,sources:input.researchSources || [],userAgent:process.env.RESEARCH_SEC_USER_AGENT || null}),
      history:new HistoricalAcquisitionService({ledger:store,candleStore:candles,marketDataService:{fetchYahooBars:(symbol,options)=>this.rpc("market.fetch",{symbol,options})}}),
      indicators:new TechnicalIndicatorService({store:candles}),coupling:new NewsPriceCouplingService({store:candles}),forecasts:new ForecastEvaluationService({store,candleStore:candles}),
      portfolio:new PortfolioContextService({stateManager,archive:news,alerts,awarenessService,watchlist,scenarioService:scenarios}),
      conditions:new MarketConditionsService({stateManager,candleStore:candles,marketWatchlistService:watchlist,awarenessService,intradayCandleService:{getMetrics:()=>this.context.intradayMetrics},intradayCandlesEnabled:input.intradayEnabled}),
      map:new MapLayerService({stateManager,rssAggregator:input.news ? rssReadView : rss}),advanced:new AdvancedIntelligenceService({stateManager,rssAggregator:input.news ? rssReadView : rss,signalCorrelator:signals})};
    this.db.prepare("UPDATE pipeline_definitions SET storage_backend='sqlite'").run();
    writeMeta(this.db,"businessStorage","sqlite");
    return {configured:true,coverage:news.coverage()};
  }
  save(kind,payload){
    const at=new Date().toISOString();
    return this.db.transaction(()=>{
      if(kind === "awareness"){
        for(const s of payload.sourceStatus || []){sourceRow(this.db,s.sourceId,s);this.db.prepare("INSERT INTO awareness_source_status VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET payload_json=excluded.payload_json").run(s.sourceId,JSON.stringify(s));}
        for(const e of payload.events || []){const id=e.source?.sourceId || "awareness";sourceRow(this.db,id,e.source || {});this.db.prepare("INSERT INTO awareness_events VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET observed_at=excluded.observed_at,revision=excluded.revision,payload_json=excluded.payload_json WHERE awareness_events.revision!=excluded.revision").run(e.eventId,id,e.observedAt || at,e.revision || 1,JSON.stringify(e));}
        writeMeta(this.db,"awareness.revision",Math.max(readMeta(this.db,"awareness.revision",0),payload.revision || 0));
      } else if(kind === "ai" || kind === "ai-record"){
        for(const row of kind==="ai"?(Array.isArray(payload.records)?payload.records:[]):[payload])this.db.prepare("INSERT INTO ai_enrichments VALUES(?,?,?,?,?,?) ON CONFLICT(enrichment_id) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at,payload_json=excluded.payload_json").run(row.enrichmentId,row.kind,row.cacheKey || row.inputHash || "unknown",row.status,row.updatedAt || at,JSON.stringify(row));
      } else if(kind === "quotes"){
        for(const [symbol,quote]of Object.entries(payload.quotes || {})){
          const i=getInstrumentByCanonicalSymbol(symbol);if(!i||quote.synthetic||["synthetic","fallback","seeded"].includes(quote.dataMode)||!Number.isFinite(Number(quote.price)))continue;
          instrumentRow(this.db,i.instrumentId);const id=`quote-${stableHash([i.instrumentId,quote.asOf,quote.price,quote.source]).slice(0,40)}`;
          this.db.prepare("INSERT OR IGNORE INTO quote_observations VALUES(?,?,?,?,?,?,?,?)").run(id,i.instrumentId,quote.asOf || null,at,quote.source || "unknown",quote.dataMode || "observed",Number(quote.price),JSON.stringify(quote));
        }
      } else if(["awareness-audit","awareness-poll"].includes(kind)){
        this.db.prepare("INSERT INTO runtime_audit(kind,observed_at,payload_json) VALUES(?,?,?)").run(kind,payload.recordedAt || at,JSON.stringify(payload));
        if(kind==="awareness-poll"){sourceRow(this.db,payload.sourceId);this.db.prepare("INSERT OR IGNORE INTO source_polls VALUES(?,?,?,?,?)").run(`poll-${stableHash(payload).slice(0,40)}`,payload.sourceId,payload.recordedAt,payload.poll.outcome,JSON.stringify(payload.poll));}
      } else this.db.prepare("INSERT INTO runtime_snapshots VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json").run(kind,at,JSON.stringify(payload));
      const pipelineId=({awareness:"awareness","awareness-audit":"awareness","awareness-poll":"awareness",ai:"ai","ai-record":"ai","ai-budget":"ai",market:"market-quotes",quotes:"market-quotes",rss:"rss","rss-canonical":"rss","rss-feeds":"rss",signals:"signals","provider-quota":"storage"})[kind];
      if(pipelineId)this.db.prepare("INSERT INTO pipeline_checkpoints VALUES(?,?,?,?) ON CONFLICT(pipeline_id) DO UPDATE SET updated_at=excluded.updated_at,revision=excluded.revision,payload_json=excluded.payload_json").run(pipelineId,at,String(payload?.revision || ""),JSON.stringify({kind,persisted:true}));
      return {persisted:true};
    }).immediate();
  }
  load(kind){
    if(kind === "awareness")return {revision:readMeta(this.db,"awareness.revision",0),events:this.db.prepare("SELECT payload_json FROM awareness_events ORDER BY (json_extract(payload_json,'$.scheduledAt')>=? AND json_extract(payload_json,'$.status') IN ('scheduled','live')) DESC, observed_at DESC LIMIT 1000").all(new Date().toISOString()).map(r=>JSON.parse(r.payload_json)),sourceStatus:this.db.prepare("SELECT payload_json FROM awareness_source_status").all().map(r=>JSON.parse(r.payload_json)),polls:this.db.prepare("SELECT source_id,diagnostics_json AS payload_json FROM source_polls WHERE completed_at>=? ORDER BY completed_at").all(new Date(Date.now()-7*86400000).toISOString()).map(r=>({sourceId:r.source_id,poll:JSON.parse(r.payload_json).poll || JSON.parse(r.payload_json)}))};
    if(kind === "ai")return {records:this.db.prepare("SELECT payload_json FROM ai_enrichments ORDER BY observed_at DESC LIMIT 1000").all().reverse().map(r=>JSON.parse(r.payload_json))};
    const row=this.db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind=?").get(kind);return row?JSON.parse(row.payload_json):null;
  }
  async call({service,method,args=[],context}){
    if(service === "quotes" && method === "history"){
      const i=getInstrumentByCanonicalSymbol(args[0]);if(!i)return [];
      return this.db.prepare("SELECT market_time,price,payload_json FROM quote_observations WHERE instrument_id=? ORDER BY coalesce(market_time,received_at) DESC LIMIT 500").all(i.instrumentId).reverse().map(r=>({...JSON.parse(r.payload_json),timestamp:r.market_time,price:r.price}));
    }
    if(!this.services||!METHODS[service]?.includes(method))throw new AppError("Operación de worker desconocida.",400,"STORAGE_UNKNOWN_OPERATION");
    // Each request captures its context; CPU work is synchronous after awaits.
    let captured=context || this.defaultContext;
    if(captured.newsFromStorage && ["conditions","advanced","map","portfolio"].includes(service)){
      const newsWindowHours=service==="advanced" ? Math.max(2,Number(args[0]?.windowHours || 24)*2) : service==="conditions" ? Math.max(1,Number(args[0]?.windowMin || 240)/60) : this.newsCorpus.config.candidateWindowHours || 36;
      const corpus=await this.newsCorpus.read({windowHours:newsWindowHours,awarenessMode:captured.awareness?.mode || "off"});
      captured={...captured,newsWindowHours,newsCoverage:corpus.meta,signalCorpus:corpus.signalCorpus,marketSignalCorpus:corpus.marketSignalCorpus,snapshot:{...captured.snapshot,meta:{...captured.snapshot?.meta,newsArchiveRevision:corpus.meta.revision}}};
    }
    return this.contextStorage.run(captured,async()=>{
    if(service==="rss")this.restoreQuotas();
    const target=this.services[service],track=["ingest","append","upsert","recordContext","recordSnapshot","run","import","refresh","record","acknowledgeChanges","acknowledge","recoverCheckpoint","remove","reconcile","setSourceStale"].includes(method);
    const pipelineId=({news:"news",rss:"rss",candles:"market-candles",signals:"signals",awareness:"awareness"})[service] || "research",runId=randomUUID(),started=new Date().toISOString();
    if(track)this.db.prepare("INSERT INTO pipeline_runs VALUES(?,?,?,?,?,?,?)").run(runId,pipelineId,started,null,"running","{}",null);
    try{
      const result=await target[method](...args.map(value=>value === null ? undefined : value));
      if(captured.newsCoverage && ["conditions","advanced"].includes(service)) result.newsCoverage=captured.newsCoverage;
      if(service==="rss" && target.lastSnapshot && target.lastSnapshot!==this.persistedRssSnapshot){this.save("rss",target.lastSnapshot);this.persistedRssSnapshot=target.lastSnapshot;}
      if(["indicators","technical","conditions","coupling","forecasts","advanced"].includes(service))this.recordAnalysis(`${service}.${method}`,args,result);
      if(track){const counts=Object.fromEntries(Object.entries(result || {}).filter(([key,value])=>["accepted","changed","inserted","updated","duplicates","rejectedOpen","requestsThisRun"].includes(key)&&Number.isSafeInteger(value)));this.db.prepare("UPDATE pipeline_runs SET completed_at=?,status=?,counts_json=? WHERE run_id=?").run(new Date().toISOString(),["retry","blocked","partial"].includes(result?.status)?"degraded":"healthy",JSON.stringify(counts),runId);}
      return result;
    }catch(error){if(track)this.db.prepare("UPDATE pipeline_runs SET completed_at=?,status='failed',error_code=? WHERE run_id=?").run(new Date().toISOString(),error.code || "STORAGE_COMMAND_FAILED",runId);throw error;}

    });
  }
  recordAnalysis(kind,input,result){
    const at=new Date().toISOString(),id=`analysis-${stableHash([kind,input,result]).slice(0,40)}`;
    this.db.transaction(()=>{
      this.db.prepare("INSERT OR IGNORE INTO analysis_runs VALUES(?,?,?,?,?,?,?,?)").run(id,kind,result?.methodVersion || "runtime-v1",at,result?.asOf || result?.calculatedAt || at,stableHash(input),JSON.stringify(result?.quality || {}),JSON.stringify(result));
      if(result?.instrumentId&&result.indicators){instrumentRow(this.db,result.instrumentId);for(const [name,indicator]of Object.entries(result.indicators))this.db.prepare("INSERT OR IGNORE INTO indicator_values VALUES(?,?,?,?,?,?,?,?)").run(id,result.instrumentId,result.interval || "1day",result.adjustmentMode || result.adjusted || "splits","provider-yahoo",result.seriesRevision || "unknown",name,typeof indicator?.value === "number" ? indicator.value : null);}
    }).immediate();
  }
  rssCatalog(feeds,batch){
    return feeds.map(feed=>{const url=String(feed.url || feed),previous=this.rssFeedStatuses?.get(url);return {...previous,url,label:feed.label || url,enabled:!feed.disabled,status:feed.disabled?"disabled":previous?.status || "not-polled",queriedInCycle:batch.some(candidate=>String(candidate.url || candidate)===url),error:feed.disabled?feed.reason || "feed-disabled":previous?.error || null};});
  }
  async fetchRss(input){
    const feeds=input.feeds || [],activeFeeds=feeds.filter(feed=>!feed.disabled),count=Math.min(this.newsCorpus?.config.rssFeedsPerCycle || 18,activeFeeds.length),batch=[];
    for(let i=0;i<count;i++)batch.push(activeFeeds[(this.rssCursor+i)%activeFeeds.length]);this.rssCursor=activeFeeds.length?(this.rssCursor+count)%activeFeeds.length:0;
    const runId=randomUUID(),startedAt=new Date().toISOString();
    this.db.prepare("INSERT INTO pipeline_runs VALUES(?,?,?,?,?,?,?)").run(runId,"rss",startedAt,null,"running","{}",null);
    this.rssDiagnostics={startedAt,stage:"fetching",catalogSize:feeds.length,availableFeedCount:activeFeeds.length,queriedFeedCount:batch.length,nextFeedOffset:this.rssCursor,concurrency:4,deadlineMs:60000,timeoutPerFeedMs:Math.min(input.timeoutMs || 9000,9000),catalogStatus:this.rssCatalog(feeds,batch)};
    try{
    const result=await fetchRss({feeds:batch,timeoutMs:Math.min(input.timeoutMs || 9000,9000),retries:0,concurrency:4,deadlineMs:60000});
    this.rssDiagnostics={...this.rssDiagnostics,stage:"persisting",collectedCount:result.articles.length,feedStatus:result.sourceMeta.feedStatus || []};
    if(this.services){for(let offset=0;offset<result.articles.length;offset+=100){this.services.news.ingest(result.articles.slice(offset,offset+100),{lane:input.lane === "financial" ? "financial" : "editorial",awarenessMode:input.awarenessMode || this.defaultContext.awareness.mode});this.rssDiagnostics.persistedCount=Math.min(offset+100,result.articles.length);await new Promise(resolve=>setImmediate(resolve));}}
    const collected=result.articles.length;result.articles=result.articles.slice(0,900);
    const completedAt=new Date().toISOString();this.rssFeedStatuses ||= new Map();
    for(const feed of result.sourceMeta.feedStatus || []){const previous=this.rssFeedStatuses.get(feed.url);this.rssFeedStatuses.set(feed.url,{...feed,lastAttemptAt:startedAt,lastSuccessAt:feed.status==="ok"?completedAt:previous?.lastSuccessAt || null});}
    const catalogStatus=this.rssCatalog(feeds,batch);
    this.rssDiagnostics={...this.rssDiagnostics,stage:"completed",completedAt,returnedCount:result.articles.length,catalogStatus};
    this.save("rss-feeds",{nextFeedOffset:this.rssCursor,feeds:Object.fromEntries(catalogStatus.filter(feed=>feed.lastAttemptAt).map(feed=>[feed.url,feed]))});
    const healthy=(result.sourceMeta.feedStatus || []).every(feed=>feed.status==="ok")&&collected>0;
    this.db.prepare("UPDATE pipeline_runs SET completed_at=?,status=?,counts_json=? WHERE run_id=?").run(completedAt,healthy?"healthy":"degraded",JSON.stringify({queriedFeeds:batch.length,collected,returned:result.articles.length}),runId);
    result.sourceMeta={...result.sourceMeta,feedStatus:(result.sourceMeta.feedStatus || []).map(feed=>this.rssFeedStatuses.get(feed.url)),collectedCount:collected,returnedCount:result.articles.length,returnedCorpusBounded:collected>result.articles.length,catalogSize:feeds.length,queriedFeedCount:batch.length,partial:feeds.length>batch.length,acquisition:"rolling-bounded-rss-cycle"};return result;
    }catch(error){this.rssDiagnostics={...this.rssDiagnostics,stage:"failed",errorCode:error.code || "RSS_FETCH_FAILED"};this.db.prepare("UPDATE pipeline_runs SET completed_at=?,status='failed',error_code=? WHERE run_id=?").run(new Date().toISOString(),error.code || "RSS_FETCH_FAILED",runId);throw error;}
  }
  adminHistory(awareness){
    const {store,history,imports}=this.services,events=Object.values(store.state.events);
    return {instruments:listVerifiedInstruments().map(i=>({instrumentId:i.instrumentId,symbol:i.canonicalSymbol,currency:i.currency,missingIdentity:["companyId","calendarId","mic","isin"].filter(k=>!i[k]),coverage:history.coverage(i.instrumentId)})),jobs:Object.values(store.state.jobs).filter(j=>j.kind!=="csv-import").sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50).map(j=>history.get(j.jobId)),datasets:imports.datasets(),eventIdentity:{verified:events.filter(e=>e.identityVersion==="source-publication-v2").length,legacyRequiresReplay:events.filter(e=>e.identityVersion!=="source-publication-v2").slice(0,100).map(e=>({eventId:e.eventId,evidenceCount:e.evidence.length,reason:"legacy_identity_requires_replay; excluded from impacts"}))}};
  }
}
