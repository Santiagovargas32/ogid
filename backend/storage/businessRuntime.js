import {beginEventIndex,eventIndexPage,eventIndexStatus,cleanEventIndex} from "./eventIndex.js";
import { AdminHistoryProjection } from './adminHistoryProjection.js';
import {RUNTIME_POLICY} from '../config/runtimePolicy.js';
import { AdvancedSnapshots } from "./advancedSnapshots.js";
import { calculateMarketProjection } from "../services/market/marketProjection.js";
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
import { registerInstruments, listVerifiedInstruments, getInstrumentByCanonicalSymbol } from "../services/market/instrumentRegistry.js";
import { AppError } from "../utils/error.js";
import { stableHash } from "../utils/stableHash.js";
import { MarketConditionsService } from "../services/market/marketConditionsService.js";
import { MapLayerService } from "../services/map/mapLayerService.js";
import { AdvancedIntelligenceService } from "../services/intel/advancedIntelligenceService.js";
import { SignalCorrelatorService } from "../services/intel/signalCorrelator.js";
import { SqlAwarenessStore, loadAwarenessProjection } from "./sqlAwarenessStore.js";
import { awarenessMarketArticles } from "../services/awareness/marketArticles.js";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { ingestNewsBatches } from "./newsIngestion.js";
import { publicProjection } from "../utils/researchProjection.js";
import { AgentRepository } from "./agentRepository.js";
import { SqlRssCanonicalState } from "./rssCanonicalState.js";
import { checkOperation, committedOperationItems } from "../services/shared/operationContext.js";

const METHODS={market:["analyze"],awareness:["parseSource","getSnapshot","reconcile","setSourceStale"],store:["view","getRow"],news:["ingest","recordContext","search","getItem","getHistory","coverage","getProjection","getFeed","getLiveFeed"],events:["ingest","search","replayAwareness"],alerts:["acknowledge","delta","getChange","acknowledgeChanges","recoverCheckpoint"],sources:["status","run","holdings","stop"],history:["create","get","run","coverage","coverageState","coverageStates","ensureCatchup","repairPlan","cancel"],imports:["datasets","datasetsPage","import"],technical:["get"],indicators:["calculate"],coupling:["calculate"],scenarios:["refresh","list","remove"],forecasts:["evaluate","record"],portfolio:["getContext"],rss:["getSnapshot","refresh"],conditions:["getSnapshot"],map:["getDashboardMapAssets","getLayerBundle","getConfig"],advanced:["getSnapshot"],signals:["recordSnapshot","getAnomalies"],candles:["query","append","upsert","latest","has","hasCandle","hydrate","coverageSummary"]};
export class BusinessRuntime {
  constructor(db,rpc,emitStage=()=>{}){Object.assign(this,{db,rpc,emitStage});this.stageStates=new Map();this.stageTimes=new Map();this.services=null;this.rssCursor=0;}
  progress(id,status,details={}) {
    const now=new Date().toISOString(),previous=this.stageStates.get(id) || {};
    if(status==="running")this.stageTimes.set(id,performance.now());
    const stage={enabled:true,queue:0,processed:0,discarded:0,errorCode:null,reason:null,revision:null,...previous,...details,status,
      lastRunAt:status==="running"?now:previous.lastRunAt || now,lastSuccessAt:status==="completed"?now:previous.lastSuccessAt || null,
      durationMs:status==="running"?null:performance.now()-(this.stageTimes.get(id) || performance.now())};
    this.stageStates.set(id,stage);this.emitStage(id,stage);
  }
  registry(instruments){
    registerInstruments(instruments || []);
    if(this.analysisOnly)return {registered:listVerifiedInstruments().length};
    this.db.transaction(()=>{for(const i of listVerifiedInstruments())instrumentRow(this.db,i.instrumentId);}).immediate();
    this.registryDiagnostics=beginEventIndex(this.db);
    this.maintenancePending=null;
    return {registered:listVerifiedInstruments().length,index:this.registryDiagnostics};
  }
  indexPage(input={}){
    const started=performance.now(),budgetMs=Math.min(RUNTIME_POLICY.storage.maintenancePageMs,input.budgetMs??RUNTIME_POLICY.storage.maintenancePageMs);
    let state=eventIndexStatus(this.db),phase='events',details={};
    if(state.state!=='ready')state=eventIndexPage(this.db,{...input,budgetMs});
    else{
      this.maintenancePending ||= {cleanup:true,candles:true,research:true};
      const phases=Object.keys(this.maintenancePending),available=phases.filter(p=>this.maintenancePending[p]);
      phase=available.includes(this.maintenanceNext)?this.maintenanceNext:available[0]||'idle';
      if(phase==='cleanup')this.maintenancePending.cleanup=cleanEventIndex(this.db);
      if(phase==='candles'){const page=this.services?.candles.validatePage({budgetMs});details.candleValidation=page;this.maintenancePending.candles=Boolean(page?.hasMore);}
      if(phase==='research'){const page=this.services?.store.validateProjectionPage({budgetMs});details.researchProjection=page;this.maintenancePending.research=Boolean(page?.hasMore);}
      this.maintenanceNext=phases[(phases.indexOf(phase)+1)%phases.length];
    }
    this.registryDiagnostics={...this.registryDiagnostics,...state,...details,cleanupPending:state.state!=='ready'||!this.maintenancePending||Object.values(this.maintenancePending).some(Boolean),maintenancePhase:phase,maintenanceBudgetMs:budgetMs,durationMs:performance.now()-started};
    return this.registryDiagnostics;
  }
  close(){this.newsCorpus?.close();this.services?.news.close();}
  restoreQuotas(){for(const [provider,saved]of Object.entries(this.load("provider-quota")?.providers || {})){apiQuotaTracker.ensureProvider(provider);Object.assign(apiQuotaTracker.providers[provider],saved);}}
  configure(input={}){
    this.analysisOnly=input.analysisOnly === true;
    if(!this.analysisOnly)writeMeta(this.db,'source.configurationEpoch',readMeta(this.db,'source.configurationEpoch',0)+1);
    this.advancedSnapshots=new AdvancedSnapshots(this);
    if(!this.analysisOnly)this.advancedSnapshots.recover();
    if(input.requireImport&&!readMeta(this.db,"import.ready",false))throw new AppError("Ejecutar storage:migrate antes de activar el servicio SQL.",503,"STORAGE_IMPORT_REQUIRED");
    if(!input.analysisOnly)this.db.prepare("UPDATE pipeline_runs SET status='failed',completed_at=?,error_code='STORAGE_RESTART_INTERRUPTED' WHERE status='running'").run(new Date().toISOString());
    if(!input.analysisOnly)this.db.prepare("UPDATE pipeline_stage_state SET status='failed',updated_at=?,state_json=json_set(state_json,'$.status','failed','$.errorCode','STORAGE_RESTART_INTERRUPTED') WHERE status IN ('queued','running')").run(new Date().toISOString());
    this.close();
    loadResearchSources(process.env.RESEARCH_SOURCES_FILE);
    this.progress("storage","running",{reason:"configure.registry"});
    this.registry(input.instruments);
    this.progress("storage","running",{reason:"configure.services"});
    apiQuotaTracker.reset(input.apiLimits || {});this.restoreQuotas();
    const store=new SqlResearchStore(this.db),candles=new SqlCandleStore(this.db,{rootDir:input.rootDir,enabled:input.candlesEnabled,readOnly:this.analysisOnly}),alerts=new SqlAlertStore(this.db),events=new SqlEventLedger({store}),news=new SqlNewsArchive(this.db,{retentionDays:input.newsRetentionDays || 30,analysisOnly:input.analysisOnly});
    news.onIngest=items=>{for(let offset=0;offset<items.length;offset+=500)events.ingest(items.slice(offset,offset+500));};
    const imports=new HistoricalImportService({ledger:store,rootDir:input.rootDir});imports.open=datasetId=>new SqlCandleStore(this.db,{datasetId,rootDir:input.rootDir,readOnly:this.analysisOnly});
    const technical=new TechnicalContextService({store:candles,imports}),scenarios=new ScenarioService({alerts,technicalContext:technical,eventLedger:events,candleStore:candles,policy:input.signalPolicy});
    this.contextStorage=new AsyncLocalStorage();
    this.defaultContext={snapshot:{},signalCorpus:[],marketSignalCorpus:[],awareness:{mode:input.awarenessMode || "off",upcoming:[],recent:[]},selectedInstrumentIds:[],intradayMetrics:{}};
    Object.defineProperty(this,"context",{configurable:true,get:()=>this.contextStorage.getStore() || this.defaultContext});
    this.newsCorpus=new SqlNewsCorpus(news,{...input.news,awarenessMode:input.awarenessMode,progress:(...args)=>this.progress(...args)});
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
    const persistedSignalRows=new Map();
    signals.persist=()=>{
      const next=new Map();
      this.db.transaction(()=>{
        this.save("signals",signals.history);
        writeMeta(this.db,"signals.revision",stableHash(signals.history));
        for(const [signal,rows]of Object.entries(signals.history))for(const row of rows)for(const [country,value]of Object.entries(row.byCountry || {})){
          const key=JSON.stringify([signal,country,row.timestamp]);next.set(key,value);
          if(!persistedSignalRows.has(key)||persistedSignalRows.get(key)!==value)this.db.prepare("INSERT INTO signal_buckets VALUES(?,?,?,?,?) ON CONFLICT(signal,country,bucket) DO UPDATE SET observed_at=excluded.observed_at,value=excluded.value WHERE signal_buckets.value IS NOT excluded.value").run(row.timestamp,signal,country,row.timestamp,value);
        }
        // Historical signal buckets are retained; only the runtime cache expires.
      }).immediate();persistedSignalRows.clear();for(const [key,value]of next)persistedSignalRows.set(key,value);
    };
    this.rssAcquisitionContext=new AsyncLocalStorage();
    const rss=new RssAggregatorService({...input.rss,rssFeeds:input.rss?.rssFeeds?.length?input.rss.rssFeeds:input.news?.rssFeeds || [],persistencePath:null,onCollected:async articles=>{
      const options=this.rssAcquisitionContext.getStore() || {awarenessMode:input.awarenessMode};
      if(options.lane==='financial' && options.awarenessMode!=='visible'){
        // Keep gated acquisitions private and durable until their original lane
        // becomes visible. ETags never acknowledge facts held only in a preview.
        for(let offset=0;offset<articles.length;offset+=10){
          checkOperation();
          this.db.transaction(()=>{for(const article of articles.slice(offset,offset+10)){
            const key=`rss-held:${article.provenance.feedId}:${stableHash([article.url,article.title,article.description,article.content,article.publishedAt,article.updatedAt])}`;
            this.save(key,article);
          }}).immediate();
          committedOperationItems(Math.min(10,articles.length-offset));
          await new Promise(resolve=>setImmediate(resolve));
        }
        return;
      }
      await ingestNewsBatches(news,articles,options,count=>{
        if(this.newsPipeline)this.newsPipeline.supplementalDiagnostics={...this.newsPipeline.supplementalDiagnostics,stage:"archiving",persistedCount:count,collectedCount:articles.length};
      });
    }});
    const canonicalState=new SqlRssCanonicalState(this);
    const canonical=this.analysisOnly?null:canonicalState.load();if(canonical){rss.canonicalPipeline.states=new Map(Object.entries(canonical.states || {}));rss.canonicalPipeline.corpus=canonical.corpus || [];rss.canonicalPipeline.metrics={...rss.canonicalPipeline.metrics,...canonical.metrics};}
    rss.canonicalPipeline.persist=selectedIds=>canonicalState.save(rss.canonicalPipeline,selectedIds);
    const savedRss=this.analysisOnly?null:this.load("rss");if(savedRss){rss.lastSnapshot=savedRss;rss.corpus=savedRss.items || [];}
    this.persistedRssSnapshot=savedRss || null;
    if(input.news){
      const generated=this.load("rss-generated") || {};
      this.rssGeneratedCursor=generated.nextOffset || 0;
      this.nextGeneratedCollectAt=generated.nextCollectAt || 0;

    }
    const savedFeedStatus=this.load("rss-feeds");this.rssCursor=savedFeedStatus?.nextFeedOffset || 0;this.rssFeedStatuses=new Map(Object.entries(savedFeedStatus?.feeds || {}));
    this.services={market:{analyze:input=>this.analyzeMarket(input)},store,news,events,alerts,candles,imports,technical,scenarios,signals,rss,awareness:new SqlAwarenessStore(this.db),
      sources:new OfficialSourceService({store,eventLedger:events,sources:input.researchSources || [],userAgent:process.env.RESEARCH_SEC_USER_AGENT || null,acquire:input.analysisOnly?null:input=>this.rpc("source.acquire",input),cancelAcquire:attemptId=>this.rpc("source.cancel",{attemptId}),configurationVersion:()=>readMeta(this.db,"source.configurationEpoch",0)}),
      history:new HistoricalAcquisitionService({ledger:store,candleStore:candles,marketDataService:{fetchYahooBars:(symbol,options)=>this.rpc("market.fetch",{symbol,options})}}),
      indicators:new TechnicalIndicatorService({store:candles}),coupling:new NewsPriceCouplingService({store:candles}),forecasts:new ForecastEvaluationService({store,candleStore:candles}),
      portfolio:new PortfolioContextService({stateManager,archive:news,alerts,awarenessService,watchlist,scenarioService:scenarios}),
      conditions:new MarketConditionsService({stateManager,candleStore:candles,marketWatchlistService:watchlist,awarenessService,intradayCandleService:{getMetrics:()=>this.context.intradayMetrics},intradayCandlesEnabled:input.intradayEnabled}),
      map:new MapLayerService({stateManager,rssAggregator:input.news ? rssReadView : rss}),advanced:new AdvancedIntelligenceService({stateManager,rssAggregator:input.news ? rssReadView : rss,signalCorrelator:signals})};
    if(!this.analysisOnly){this.db.prepare("UPDATE pipeline_definitions SET storage_backend='sqlite'").run();writeMeta(this.db,"businessStorage","sqlite");}
    this.progress("storage","running",{reason:"configure.coverage"});
    const coverage=news.coverage();this.progress("storage","completed",{reason:"configure.completed"});
    return {configured:true,coverage};
  }
  save(kind,payload){
    const at=new Date().toISOString();
    return this.db.transaction(()=>{
      if(kind === "pipeline-stage"){
        this.db.prepare("INSERT INTO pipeline_stage_state VALUES(?,?,?,?) ON CONFLICT(stage_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,state_json=excluded.state_json").run(payload.id,payload.stage.status,at,JSON.stringify(payload.stage));
      } else if(kind === "awareness"){
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
      } else {
        const encoded=JSON.stringify(payload);
        this.db.prepare("INSERT INTO runtime_snapshots VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json WHERE runtime_snapshots.payload_json!=excluded.payload_json").run(kind,at,encoded);
        if(['market','signals','news-projection','ai-budget'].includes(kind))this.db.prepare("INSERT OR IGNORE INTO derived_observations VALUES(?,?,?,?)").run(kind,stableHash(payload),at,encoded);
      }
      const pipelineId=({awareness:"awareness","awareness-audit":"awareness","awareness-poll":"awareness",ai:"ai","ai-record":"ai","ai-budget":"ai",market:"market-quotes",quotes:"market-quotes",rss:"rss","rss-canonical":"rss","rss-canonical-v2":"rss","rss-feeds":"rss",signals:"signals","provider-quota":"storage"})[kind];
      if(pipelineId)this.db.prepare("INSERT INTO pipeline_checkpoints VALUES(?,?,?,?) ON CONFLICT(pipeline_id) DO UPDATE SET updated_at=excluded.updated_at,revision=excluded.revision,payload_json=excluded.payload_json").run(pipelineId,at,String(payload?.revision || ""),JSON.stringify({kind,persisted:true}));
      return {persisted:true};
    }).immediate();
  }
  load(kind,options={}){
    if(kind==='advanced-job')return this.advancedSnapshots.status(options.jobId);
    if(kind==='dashboard-analysis')return this.advancedSnapshots.peek(options);
    if(kind==="maintenance-inputs")return this.db.transaction(()=>({
      news:{...readMeta(this.db,"news.meta",{}),hasRecentNews:Boolean(this.db.prepare("SELECT 1 FROM articles INDEXED BY articles_projection_window WHERE published_at>=? AND published_at<=? LIMIT 1").get(new Date(Date.now()-48*3600000).toISOString(),new Date().toISOString()))},awareness:readMeta(this.db,"awareness.revision",0),
      research:readMeta(this.db,"research.revision",0),signals:readMeta(this.db,"signals.revision",null),
      candles:Object.fromEntries(this.db.prepare("SELECT key,value_json FROM runtime_meta WHERE key GLOB 'candles.revision:*'").all().map(row=>[row.key,JSON.parse(row.value_json)])),
      market:this.db.prepare("SELECT json_extract(payload_json,'$.revision') AS revision FROM runtime_snapshots WHERE kind='market'").get()?.revision || null,
      alerts:readMeta(this.db,'alerts.meta',{}).sequence || 0
    })).deferred();
    if(kind === "awareness")return loadAwarenessProjection(this.db);
    if(kind === "ai")return {records:this.db.prepare("SELECT payload_json FROM ai_enrichments ORDER BY observed_at DESC LIMIT 1000").all().reverse().map(r=>JSON.parse(r.payload_json))};
    const row=this.db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind=?").get(kind);return row?JSON.parse(row.payload_json):null;
  }
  async analyzeMarket(input = {}) {
    if (!input.newsFromStorage) return calculateMarketProjection(input);
    // The corpus stays in the reader worker. Providers commit before analysis;
    // SqlNewsCorpus applies the same ranking, filters and transaction as news projections.
    const options = {awarenessMode:this.newsCorpus.config.awarenessMode || "off",...input.corpusOptions};
    const corpus = await this.newsCorpus.readAnalytical({...options,windowHours:options.windowHours || this.newsCorpus.config.candidateWindowHours || 36});
    const awareness = options.awarenessMode === "visible"
      ? this.services.awareness.getSnapshot({mode:"visible",publicView:true}) : null;
    const seen = new Set();
    const articles = [...corpus.marketSignalCorpus, ...awarenessMarketArticles(awareness || {})].filter(article => {
      const key = String(article?.id || article?.url || article?.title || "").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
    return {...calculateMarketProjection({...input,articles}),newsCoverage:{...corpus.meta,awarenessRevision:awareness?.revision ?? null,analysisArticleCount:articles.length}};
  }
  async call({service,method,args=[],context,analysisJob,requestId,preparedScenarios}){
    if(service === "quotes" && method === "history"){
      const i=getInstrumentByCanonicalSymbol(args[0]);if(!i)return [];
      return this.db.prepare("SELECT market_time,price,payload_json FROM quote_observations WHERE instrument_id=? ORDER BY coalesce(market_time,received_at) DESC LIMIT 500").all(i.instrumentId).reverse().map(r=>({...JSON.parse(r.payload_json),timestamp:r.market_time,price:r.price}));
    }
    if(!this.services||!METHODS[service]?.includes(method))throw new AppError("Operación de worker desconocida.",400,"STORAGE_UNKNOWN_OPERATION");
    if(service === "advanced"){
      const asOf=analysisJob?.asOf || new Date().toISOString();
      const savedRow=this.db.prepare("SELECT payload_json FROM derived_observations WHERE kind='signals' AND observed_at<=? ORDER BY observed_at DESC LIMIT 1").get(asOf);
      const legacyRow=savedRow?null:this.db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='signals' AND updated_at<=?").get(asOf);
      const saved=JSON.parse(savedRow?.payload_json || legacyRow?.payload_json || "{}");
      this.services.signals.history=saved?.history || saved || {};
    }
    // Each request captures its context; CPU work is synchronous after awaits.
    Object.assign(this.services.news,readMeta(this.db,"news.meta",{}));
    let captured=context || this.defaultContext;
    if(service==="advanced"){
      const asOf=analysisJob?.asOf || args[0]?.asOf || new Date().toISOString();
      const corpus=await this.newsCorpus.readAnalytical({asOf,windowHours:Number(args[0]?.windowHours || 24)*2,revisionWatermark:analysisJob?.revisions.articleWatermark});
      captured={...captured,newsFromStorage:true,asOf,newsCoverage:corpus.meta,signalCorpus:corpus.articles,
        snapshot:{...captured.snapshot,meta:{...captured.snapshot?.meta,newsArchiveRevision:corpus.meta.revision}}};
      this.services.advanced.now=()=>Date.parse(asOf);
      this.services.advanced.rssAggregator={getSnapshot:async()=>({items:[],generatedAt:asOf,meta:{provider:'sqlite',analytical:corpus.meta}})};
      this.services.signals.now=()=>Date.parse(asOf);
    }
    // Portfolio queries read their requested archive window directly. Loading
    // the analytical corpus here duplicated historical I/O without using it.
    if(captured.newsFromStorage && ["conditions","map"].includes(service)){
      const newsWindowHours=service==="advanced" ? Math.max(2,Number(args[0]?.windowHours || 24)*2) : service==="conditions" ? args[0]?.anchor==="last-close"?168:Math.max(1,Number(args[0]?.windowMin || 240)/60) : this.newsCorpus.config.candidateWindowHours || 36;
      const corpus=service==='map'
        ? await this.newsCorpus.read({windowHours:newsWindowHours,awarenessMode:captured.awareness?.mode || "off"})
        : await this.newsCorpus.readAnalytical({windowHours:newsWindowHours,awarenessMode:captured.awareness?.mode || "off"});
      captured={...captured,newsWindowHours,newsCoverage:corpus.meta,signalCorpus:corpus.signalCorpus,marketSignalCorpus:corpus.marketSignalCorpus,snapshot:{...captured.snapshot,meta:{...captured.snapshot?.meta,newsArchiveRevision:corpus.meta.revision}}};
    }
    return this.contextStorage.run(captured,async()=>{
    if(service==="rss")this.restoreQuotas();
    const target=this.services[service];
    const idempotent=Boolean(requestId)&&({news:['ingest','recordContext'],candles:['append','upsert'],events:['ingest'],alerts:['acknowledge','acknowledgeChanges','recoverCheckpoint'],scenarios:['remove'],forecasts:['record']}[service] || []).includes(method);
    const requestHash=idempotent?stableHash([service,method,args]):null;
    if(idempotent){
      if(!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))throw new AppError('Identidad inválida.',400,'STORAGE_INVALID_REQUEST_ID');
      const previous=this.db.prepare('SELECT input_hash,result_json FROM storage_commands WHERE request_id=?').get(requestId);
      if(previous){if(previous.input_hash!==requestHash)throw new AppError('Conflicto de idempotencia.',409,'STORAGE_IDEMPOTENCY_CONFLICT');return JSON.parse(previous.result_json);}
    }
    const track=["ingest","append","upsert","recordContext","recordSnapshot","run","import","refresh","record","acknowledgeChanges","acknowledge","recoverCheckpoint","remove","reconcile","setSourceStale"].includes(method);
    const pipelineId=({news:"news",rss:"rss",candles:"market-candles",signals:"signals",awareness:"awareness"})[service] || "research",runId=randomUUID(),started=new Date().toISOString();
    if(track)this.db.prepare("INSERT INTO pipeline_runs VALUES(?,?,?,?,?,?,?)").run(runId,pipelineId,started,null,"running","{}",null);
    try{
      let result;
      const newsBefore=idempotent?Object.fromEntries(['revision','startedAt','lastIngestAt','capacityPrunedAt'].map(k=>[k,this.services.news[k]])):null;
      const signalBefore=service==='signals'&&method==='recordSnapshot'?structuredClone(target.history):null;
      try{
        const invoke=()=>{
          if(service==="scenarios" && method==="refresh" && preparedScenarios)return target.applyPrepared(preparedScenarios);
          if(service==="portfolio" && this.analysisOnly){
            const prepared=target.prepare(args[0]);
            if(prepared.result.mode!=="material")return prepared.result;
            // Candidate discovery is read work; registration/deduplication must
            // use the writer's current acknowledgement state.
            return this.rpc("analysis.persist",{type:"portfolio-material",candidates:prepared.candidates})
              .then(candidates=>({...prepared.result,material:{...prepared.result.material,candidates}}));
          }
          return target[method](...args.map(value=>value === null ? undefined : value));
        };
        if(idempotent)result=this.db.transaction(()=>{
          const value=invoke();if(value?.then)throw new AppError('Transacción asíncrona inválida.',500,'STORAGE_ASYNC_TRANSACTION');
          this.db.prepare('INSERT INTO storage_commands VALUES(?,?,?,?,?)').run(requestId,`domain.${service}.${method}`,requestHash,JSON.stringify(value ?? null),new Date().toISOString());
          return value;
        }).immediate();
        else result=await invoke();
      }
      catch(error){
        if(signalBefore)target.history=signalBefore;
        // Nested repository commits are savepoints. Restore auxiliary state when
        // the outer idempotency transaction fails after the repository returns.
        if(idempotent){this.services.alerts.reload();Object.assign(this.services.news,readMeta(this.db,'news.meta',newsBefore));}
        throw error;
      }
      if(captured.newsCoverage && ["conditions","advanced"].includes(service)){
        // Cached algorithm results retain the inputs of their original calculation.
        const key=stableHash([service,method,args,result]);
        this.resultCoverage ||= new Map();
        const {inputManifest,...coverage}=captured.newsCoverage;
        if(!this.resultCoverage.has(key)){
          this.resultCoverage.set(key,coverage);
          if(this.resultCoverage.size>64)this.resultCoverage.delete(this.resultCoverage.keys().next().value);
        }
        result.newsCoverage=this.resultCoverage.get(key);
      }
      if(service==="rss" && target.lastSnapshot && target.lastSnapshot!==this.persistedRssSnapshot){this.save("rss",target.lastSnapshot);this.persistedRssSnapshot=target.lastSnapshot;this.updateRssDiagnostics(target.lastSnapshot);}
      if(["market","indicators","technical","conditions","coupling","forecasts","advanced"].includes(service)){
        if(service==='advanced') {
          result.inputsAsOf=captured.asOf;
          result.inputRevisions=analysisJob?.revisions || {news:captured.newsCoverage.revision};
          result.inputManifest={articles:captured.newsCoverage.inputManifest,signalsHash:stableHash(this.services.signals.history),contextHash:stableHash(captured.snapshot)};
          result.inputHash=stableHash([args,result.inputManifest,result.inputRevisions,captured.asOf]);
          result.inputManifest.signals=this.services.signals.history;
          result.reproducibility={articles:'immutable article revisions',signals:'hash of persisted signal snapshot',context:'captured in durable job',complete:Boolean(analysisJob)&&!captured.newsCoverage.legacyAvailabilityCount,legacyAvailabilityCount:captured.newsCoverage.legacyAvailabilityCount || 0};
        }
        const record={kind:`${service}.${method}`,input:args,result};
        if(analysisJob){await this.rpc("analysis.persist",{type:"advanced",jobId:analysisJob.jobId,owner:analysisJob.owner,fence:analysisJob.fence,result});return result;}
        const identity=stableHash([record.kind,record.input,record.result?.semanticRevision || record.result]);
        this.persistedAnalyses ||= new Set();
        if(!this.persistedAnalyses.has(identity)){
          if(this.analysisOnly)await this.rpc("analysis.persist",{type:"analysis",record});
          else this.recordAnalysis(record.kind,record.input,record.result);
          this.persistedAnalyses.add(identity);if(this.persistedAnalyses.size>64)this.persistedAnalyses.delete(this.persistedAnalyses.values().next().value);
        }
      }
      if(track){const counts=Object.fromEntries(Object.entries(result || {}).filter(([key,value])=>["accepted","changed","inserted","updated","duplicates","rejectedOpen","requestsThisRun"].includes(key)&&Number.isSafeInteger(value)));this.db.prepare("UPDATE pipeline_runs SET completed_at=?,status=?,counts_json=? WHERE run_id=?").run(new Date().toISOString(),["retry","blocked","partial"].includes(result?.status)?"degraded":"healthy",JSON.stringify(counts),runId);}
      return result;
    }catch(error){if(track)this.db.prepare("UPDATE pipeline_runs SET completed_at=?,status='failed',error_code=? WHERE run_id=?").run(new Date().toISOString(),error.code || "STORAGE_COMMAND_FAILED",runId);throw error;}

    });
  }
  recordAnalysis(kind,input,result){
    const at=new Date().toISOString(),id=`analysis-${stableHash([kind,input,result?.semanticRevision || result]).slice(0,40)}`;
    this.db.transaction(()=>{
      this.db.prepare("INSERT OR IGNORE INTO analysis_runs VALUES(?,?,?,?,?,?,?,?)").run(id,kind,result?.methodology?.version || result?.methodVersion || "runtime-v1",result?.generatedAt || result?.calculatedAt || at,result?.inputsAsOf || result?.asOf || result?.calculatedAt || at,result?.inputHash || stableHash([input,result?.seriesRevision,result?.newsCoverage,result?.inputRevisions]),JSON.stringify(result?.quality || {}),JSON.stringify(result));
      const manifest={schemaVersion:'analysis-inputs-v1',methodology:result?.methodology || result?.methodVersion || 'runtime-v1',
        inputsAsOf:result?.inputsAsOf || result?.asOf || result?.calculatedAt || result?.generatedAt || at,
        revisions:result?.inputRevisions || {series:result?.seriesRevision ?? null,news:result?.newsCoverage?.revision ?? result?.meta?.revision ?? null},
        inputs:result?.inputManifest || result?.meta?.analyticalInput || null,coverage:result?.newsCoverage || result?.coverage || null,
        reproducibility:result?.reproducibility || {complete:false,reason:'legacy algorithm does not expose all effective inputs'}};
      this.db.prepare('INSERT OR IGNORE INTO analysis_inputs VALUES(?,?,?)').run(id,JSON.stringify(input ?? null),JSON.stringify(manifest));
      if(result?.instrumentId&&result.indicators){instrumentRow(this.db,result.instrumentId);for(const [name,indicator]of Object.entries(result.indicators))this.db.prepare("INSERT OR IGNORE INTO indicator_values VALUES(?,?,?,?,?,?,?,?)").run(id,result.instrumentId,result.interval || "1day",result.adjustmentMode || result.adjusted || "splits","provider-yahoo",result.seriesRevision || "unknown",name,typeof indicator?.value === "number" ? indicator.value : null);}
    }).immediate();
    return id;
  }
  persistDerived({owner,fence,type,record,checkpoint,jobId,result,candidates,input}={}){
    if(this.analysisOnly)throw new AppError("Persistencia reservada al worker principal.",503,"STORAGE_INVALID_COMMAND");
    if(type === "agent-snapshot"){
      this.agent ||= new AgentRepository(this);
      return this.agent.snapshotWrite(input);
    }
    if(type === "advanced")return this.advancedSnapshots.publish({jobId,result,owner,fence});
    if(type === "portfolio-material" && Array.isArray(candidates))return publicProjection(this.services.alerts.candidates(candidates),2);
    if(type === "analysis" && record && /^(market|indicators|technical|conditions|coupling|forecasts|advanced)\./.test(record.kind)){
      this.recordAnalysis(record.kind,record.input,record.result);return {persisted:true};
    }
    if(type !== "news-projection" || !checkpoint?.persisted || !checkpoint.asOf)throw new AppError("Proyección inválida.",400,"STORAGE_INVALID_COMMAND");
    return this.db.transaction(()=>{
      this.save("news-projection",checkpoint);
      if(record)this.recordAnalysis("news.projection",record.input,record.result);
      this.db.prepare("INSERT INTO pipeline_checkpoints VALUES(?,?,?,?) ON CONFLICT(pipeline_id) DO UPDATE SET updated_at=excluded.updated_at,revision=excluded.revision,payload_json=excluded.payload_json").run("news",checkpoint.asOf,String(checkpoint.revision),JSON.stringify(checkpoint));
      return {persisted:true};
    }).immediate();
  }
  rssCatalog(feeds,batch){
    return feeds.map(feed=>{const url=String(feed.url || feed),previous=this.rssFeedStatuses?.get(url);return {...previous,url,label:feed.label || url,enabled:!feed.disabled,status:feed.disabled?"disabled":previous?.status || "not-polled",queriedInCycle:batch.some(candidate=>String(candidate.url || candidate)===url),error:feed.disabled?feed.reason || "feed-disabled":previous?.error || null};});
  }
  updateRssDiagnostics(snapshot){
    const rss=this.services.rss,meta=rss.canonicalPipeline.snapshot().meta;
    const acquisition=snapshot.meta.acquisition;
    if(acquisition?.attempted && this.newsPipeline){
      this.newsPipeline.diagnostics={...this.newsPipeline.diagnostics,lastAttemptAt:new Date(acquisition.lastAttemptAt).toISOString()};
      this.newsPipeline.observeAcquisition(acquisition);
      this.save('news-collection',this.newsPipeline.diagnostics);
    }
    this.rssDiagnostics={stage:'completed',startedAt:acquisition?.lastAttemptAt?new Date(acquisition.lastAttemptAt).toISOString():null,completedAt:snapshot.generatedAt,
      catalogSize:rss.canonicalCatalog.feeds.length,availableFeedCount:meta.feedStatus.filter(feed=>!feed.disabled).length,
      queriedFeedCount:snapshot.meta.queriedFeedCount,catalogStatus:meta.feedStatus.map(feed=>({...feed,enabled:!feed.disabled})),
      feedStatus:snapshot.meta.feedStatus,acquisition,metrics:meta.metrics};
  }
  async fetchRss(input){
    const rss=this.services.rss,feedIds=rss.registerFeeds(input.feeds || []);
    const options={lane:input.lane || 'editorial',awarenessMode:input.awarenessMode || this.defaultContext.awareness.mode};
    const runId=randomUUID(),startedAt=new Date().toISOString();
    this.db.prepare("INSERT INTO pipeline_runs VALUES(?,?,?,?,?,?,?)").run(runId,'rss',startedAt,null,'running','{}',null);
    try{
      if(options.lane!=='financial' || options.awarenessMode==='visible')for(const feedId of feedIds){
        for(;;){
          const held=this.db.prepare("SELECT kind,payload_json FROM runtime_snapshots WHERE kind GLOB ? ORDER BY kind LIMIT 10").all(`rss-held:${feedId}:*`);
          if(!held.length)break;
          await ingestNewsBatches(this.services.news,held.map(row=>JSON.parse(row.payload_json)),options);
          this.db.transaction(()=>{for(const row of held)this.db.prepare('DELETE FROM runtime_snapshots WHERE kind=?').run(row.kind);}).immediate();
        }
      }
      const snapshot=await this.rssAcquisitionContext.run(options,()=>rss.refresh({feedIds,timeoutMs:input.timeoutMs,maxFeedsPerCycle:this.newsCorpus?.config.rssFeedsPerCycle || 18}));
      checkOperation();
      if(!snapshot.meta.stored && snapshot!==this.persistedRssSnapshot){this.save("rss",snapshot);this.persistedRssSnapshot=snapshot;}
      const feedStatus=snapshot.meta.feedStatus || [];
      this.updateRssDiagnostics(snapshot);
      const catalogStatus=this.rssDiagnostics.catalogStatus;
      if(snapshot.meta.acquisition?.attempted)this.save('rss-feeds',{nextFeedOffset:catalogStatus.filter(feed=>feed.lastAttemptAt && feed.enabled).length%Math.max(1,catalogStatus.filter(feed=>feed.enabled).length),feeds:Object.fromEntries(catalogStatus.filter(feed=>feed.lastAttemptAt).map(feed=>[feed.url,feed]))});
      const healthy=snapshot.meta.acquisition?.successfulChecks>0 && feedStatus.every(feed=>['ok','empty','not-modified'].includes(feed.status));
      this.db.prepare("UPDATE pipeline_runs SET completed_at=?,status=?,counts_json=? WHERE run_id=?").run(new Date().toISOString(),healthy?'healthy':'degraded',JSON.stringify({queriedFeeds:feedStatus.length}),runId);
      return {provider:"rss",articles:snapshot.items || [],sourceMeta:{provider:"rss",feedStatus,
        acquisition:snapshot.meta.acquisition,catalogSize:rss.canonicalCatalog.feeds.length,
        queriedFeedCount:snapshot.meta.queriedFeedCount,
        partial:feedStatus.length<rss.canonicalCatalog.feeds.length,acquisitionOwner:"shared-feed-scheduler"}};
    }catch(error){
      this.db.prepare("UPDATE pipeline_runs SET completed_at=?,status='failed',error_code=? WHERE run_id=?").run(new Date().toISOString(),error.code || 'RSS_FETCH_FAILED',runId);throw error;
    }
  }

  adminHistory(input={}){this.historyProjection ||= new AdminHistoryProjection(this.db);return this.historyProjection.get(input);}
  adminHistoryRevision(input={}){this.historyProjection ||= new AdminHistoryProjection(this.db);return this.historyProjection.revision(input);}
}
