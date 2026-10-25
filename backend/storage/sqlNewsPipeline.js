import { stableHash } from "../utils/stableHash.js";
import {newsFreshness,NEWS_FRESHNESS_POLICY} from '../services/news/newsFreshness.js';
import { ingestNewsBatches } from "./newsIngestion.js";
import { fetchAggregatedNews } from "../services/news/newsAggregatorService.js";
import { normalizeAdminArticles } from "../services/normalizeService.js";
import { computeMarketImpact } from "../services/market/impactEngineService.js";
import { generatePredictions } from "../services/market/predictionEngineService.js";
import { generateInsights } from "../services/insightService.js";
import { listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { riskWithPrevious } from "./sqlNewsCorpus.js";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";
import { checkOperation, shareOperation } from "../services/shared/operationContext.js";

export class SqlNewsPipeline {
  constructor(runtime, archive, corpus, config) { Object.assign(this, {runtime, archive, corpus, config}); this.inFlight=null; this.diagnostics=runtime.load("news-collection"); }
  async collect(options = {}) {
    if (this.inFlight) return shareOperation(this.inFlight);
    this.inFlight=this.runCollect(options).catch(error=>{this.runtime.progress(`news.${this.diagnostics.stage}`,"failed",{errorCode:error.code || "NEWS_COLLECTION_FAILED"});throw error;}).finally(() => { this.inFlight=null; });
    return shareOperation(this.inFlight);
  }
  async runCollect(options) {
    const previousCollection={...this.diagnostics};
    this.runtime.restoreQuotas();
    this.diagnostics={...previousCollection,stage:"fetching", startedAt:new Date().toISOString(), providers:options.providers || this.config.providers};
    this.runtime.progress("news.acquire","running");
    const result=await fetchAggregatedNews({...this.config, ...options, rssWorkerFetch:input => this.runtime.fetchRss({...input, lane:"editorial"})});
    checkOperation();
    this.runtime.progress("news.acquire",result.sourceMode==="unavailable"||result.sourceMode==="fallback"?"degraded":"completed",{processed:result.rawArticles?.length || 0});
    this.runtime.progress("news.persist","running");
    this.diagnostics.stage="persisting";
    // RSS has already committed every article before its response cap.
    const articles=(result.rawArticles || result.articles || []).filter(article => article.provider!=="rss" && !article.synthetic && article.provider!=="fallback");
    let lastContentChangeAt=null;
    const accepted=await ingestNewsBatches(this.archive,articles,{lane:options.queryLane || "editorial",awarenessMode:options.awarenessMode || this.config.awarenessMode || "off"},(_count,commit)=>{if(commit.changed)lastContentChangeAt=commit.committedAt;});
    this.runtime.progress("news.persist","completed",{processed:accepted});
    let supplemental=null;
    const supplementalDue=Boolean((options.providers || this.config.providers || []).includes("rss") && this.config.rssAggregateIntervalMs && !this.supplementalInFlight && Date.now()>=(this.runtime.nextGeneratedCollectAt || 0));
    if(supplementalDue && !options.deferSupplemental){
      this.diagnostics.stage="rss-supplemental";
      supplemental=await this.collectSupplemental();
    }
    const providers=Object.fromEntries((options.providers || this.config.providers || []).map(provider => [provider, apiQuotaTracker.providers[provider]]).filter(([,value]) => value));
    const previous=this.runtime.load("provider-quota") || {};
    this.runtime.save("provider-quota", {...previous, providers:{...previous.providers, ...providers}});
    this.diagnostics={...this.diagnostics, stage:"completed", completedAt:new Date().toISOString(), acceptedNonRss:accepted, sourceMode:result.sourceMode,supplemental};
    const paidAttempt=result.sourceMeta?.attempts?.some(attempt=>attempt.provider!=="rss" && attempt.status!=="skipped");
    const rssAttempt=result.sourceMeta?.rssAcquisition?.acquisition?.lastAttemptAt;
    const attempts=[previousCollection.lastAttemptAt,this.diagnostics.lastAttemptAt,paidAttempt?this.diagnostics.startedAt:null,rssAttempt?new Date(rssAttempt).toISOString():null].filter(Boolean).sort();
    this.diagnostics.lastAttemptAt=attempts.at(-1) || null;
    const paidSuccess=result.sourceMeta?.attempts?.some(attempt=>attempt.provider!=="rss" && ["ok","empty"].includes(attempt.status));
    this.observeAcquisition(result.sourceMeta?.rssAcquisition?.acquisition);
    if(paidSuccess)this.observeAcquisition({successfulChecks:1,lastSuccessfulCheckAt:this.diagnostics.completedAt,
      lastCommittedAt:this.diagnostics.completedAt,lastContentChangeAt});
    this.runtime.save("news-collection",this.diagnostics);
    return {articles:[], rawArticles:normalizeAdminArticles((result.rawArticles || []).slice(0,100), result.sourceMeta?.provider), sourceMode:result.sourceMode, sourceMeta:{...result.sourceMeta, acquiredAt:this.diagnostics.lastContentChangeAt || null,lastSuccessfulCheckAt:this.diagnostics.lastSuccessfulCheckAt || null,lastAttemptAt:this.diagnostics.lastAttemptAt,persistedBeforeAnalysis:true, rawPreviewLimit:100,supplemental}, quotas:providers,supplementalDue:supplementalDue && Boolean(options.deferSupplemental)};
  }
  async collectSupplemental(){
    if(this.supplementalInFlight)return shareOperation(this.supplementalInFlight);
    if(!this.config.rssAggregateIntervalMs || Date.now()<(this.runtime.nextGeneratedCollectAt || 0))return {skipped:true};
    this.supplementalInFlight=this.runSupplemental().finally(()=>{this.supplementalInFlight=null;});
    return shareOperation(this.supplementalInFlight);
  }
  async runSupplemental(){
    const started=performance.now(),previousCursor=this.runtime.rssGeneratedCursor;let committed=false;
    this.supplementalDiagnostics={stage:"fetching-and-archiving",startedAt:new Date().toISOString()};
    try{
      const rss=this.runtime.services.rss;
      const feeds=rss.feedCatalog?.filter(feed=>feed.generated && !feed.disabled);
      const snapshot=await rss.refresh(feeds?{feedIds:rss.registerFeeds(feeds)}:{});
      checkOperation();
      committed=true;
      this.runtime.save("rss",this.runtime.services.rss.lastSnapshot);
      this.runtime.persistedRssSnapshot=this.runtime.services.rss.lastSnapshot;
      this.diagnostics={...this.diagnostics};
      if(snapshot.meta.acquisition?.lastAttemptAt)this.diagnostics.lastAttemptAt=new Date(snapshot.meta.acquisition.lastAttemptAt).toISOString();
      this.observeAcquisition(snapshot.meta.acquisition);
      this.runtime.save("news-collection",this.diagnostics);
      this.supplementalDiagnostics={...this.supplementalDiagnostics,stage:"completed",completedAt:new Date().toISOString(),generatedAt:snapshot.generatedAt,queriedFeeds:snapshot.meta.queriedFeedCount,acquisition:snapshot.meta.acquisition,storedItems:snapshot.meta.totalItems,durationMs:Math.round(performance.now()-started)};
      return this.supplementalDiagnostics;
    }catch(error){
      this.supplementalDiagnostics={...this.supplementalDiagnostics,stage:"failed",code:error.code || "RSS_SUPPLEMENTAL_FAILED",durationMs:Math.round(performance.now()-started)};
      throw error;
    }finally{
      if(!committed)this.runtime.rssGeneratedCursor=previousCursor;
      this.runtime.nextGeneratedCollectAt=Date.now()+this.config.rssAggregateIntervalMs;
      this.runtime.save("rss-generated",{nextOffset:this.runtime.rssGeneratedCursor,nextCollectAt:this.runtime.nextGeneratedCollectAt});
    }
  }
  observeAcquisition(acquisition){
    if(!acquisition?.successfulChecks)return;
    const latest=(old,value)=>!value?old || null:!old || value>old?value:old;
    this.diagnostics.lastSuccessfulCheckAt=latest(this.diagnostics.lastSuccessfulCheckAt,acquisition.lastSuccessfulCheckAt);
    this.diagnostics.lastSuccessfulAt=this.diagnostics.lastSuccessfulCheckAt;
    this.diagnostics.lastContentChangeAt=latest(this.diagnostics.lastContentChangeAt,acquisition.lastContentChangeAt);
    this.diagnostics.lastCommittedAt=latest(this.diagnostics.lastCommittedAt,acquisition.lastCommittedAt);
  }
  async getProjection(input = {}) {
    this.diagnostics=this.runtime.load("news-collection") || this.diagnostics;
    const started=performance.now();
    this.projectionDiagnostics={stage:"reading-corpus",startedAt:new Date().toISOString()};
    this.runtime.progress("news.projection","running");
    const context=this.runtime.context, snapshot=context.snapshot || {};
    const corpus=await this.corpus.read({countries:input.countries || this.config.watchlistCountries || [], awarenessMode:input.awarenessMode || this.config.awarenessMode || "off"});
    const cacheKey=stableHash([input,corpus.meta.revision,corpus.meta.asOf,context.selectedInstrumentIds,this.diagnostics?.lastSuccessfulCheckAt,this.diagnostics?.lastAttemptAt,snapshot.countries,snapshot.market,snapshot.impactHistory,snapshot.predictions,Math.floor(Date.now()/30000)]);
    if(this.projectionCache?.key===cacheKey){
      this.runtime.progress('news.projection','completed',{processed:this.projectionCache.result.news.length,revision:corpus.meta.revision});
      return structuredClone(this.projectionCache.result);
    }
    this.projectionDiagnostics={...this.projectionDiagnostics,stage:"market-impact",corpusMs:Math.round(performance.now()-started),marketAnalysisCount:corpus.marketSignalCorpus.length};
    const riskResult=riskWithPrevious(corpus.riskResult, snapshot.countries);
    const analytical=await this.corpus.readAnalytical({asOf:corpus.meta.asOf,windowHours:this.config.candidateWindowHours || 36,awarenessMode:input.awarenessMode || this.config.awarenessMode || 'off'});
    const market=context.selectedInstrumentIds || [], instruments=listVerifiedInstruments().filter(instrument => market.includes(instrument.instrumentId));
    const tickers=input.tickers || instruments.map(instrument => instrument.canonicalSymbol);
    const freshnessPolicy={...NEWS_FRESHNESS_POLICY,publicationMs:this.config.freshnessMs||NEWS_FRESHNESS_POLICY.publicationMs,acquisitionMs:this.config.acquisitionFreshnessMs||NEWS_FRESHNESS_POLICY.acquisitionMs};
    const freshness=newsFreshness({...corpus.meta,lastSuccessfulCheckAt:this.diagnostics?.lastSuccessfulCheckAt},Date.now(),freshnessPolicy);
    const sourceMode=freshness.sourceMode;
    const inputMode=snapshot.market?.sourceMode === "fallback" ? "mixed" : sourceMode;
    const common={articles:analytical.marketSignalCorpus, countries:riskResult.countries, marketQuotes:snapshot.market?.quotes || {}, tickers, instruments, inputMode};
    this.runtime.progress("news.impact","running");
    const impact=computeMarketImpact({...common, countryFilter:input.countries || this.config.watchlistCountries || [], windowMin:input.impactWindowMin || 240, impactHistory:snapshot.impactHistory || [], predictionScores:snapshot.predictions?.predictionScoreByTicker || {}});
    this.runtime.progress("news.impact","completed",{processed:impact.items?.length || 0});
    this.runtime.progress("news.predictions","running");
    this.projectionDiagnostics.stage="predictions";
    const predictions=generatePredictions(common);
    const insights=generateInsights({countries:riskResult.countries, previousCountries:snapshot.countries || {}, inputMode});
    this.runtime.progress("news.predictions","completed",{processed:predictions.tickers?.length || 0});
    const meta={...corpus.meta,selectionTruncated:corpus.meta.analysisTruncated,analysisTruncated:analytical.meta.analysisTruncated,truncationReason:analytical.meta.truncationReason,marketAnalysisCount:analytical.marketSignalCorpus.length,analyticalInput:analytical.meta.inputManifest,lastSuccessfulAcquisitionAt:this.diagnostics?.lastContentChangeAt || null,lastSuccessfulCheckAt:this.diagnostics?.lastSuccessfulCheckAt || null,lastCommittedAt:this.diagnostics?.lastCommittedAt || null,lastAcquisitionAttemptAt:this.diagnostics?.lastAttemptAt || null,freshnessBasis:"content-publication",projectionGeneratedAt:corpus.meta.asOf,freshnessPolicy,freshness,staleReasons:freshness.staleReasons,sourceMode};
    const {displayCandidates, ...projection}=corpus;
    const result={...projection, meta, riskResult, impact, predictions, insights, sourceMode};
    const checkpoint={kind:"news-projection",persisted:true,...meta, collection:this.diagnostics || null};
    this.projectionDiagnostics.stage="saving";
    const record={input,result:{meta,riskResult,impact,predictions,insights,sourceMode,methodVersion:'news-projection-v2',generatedAt:meta.asOf,inputsAsOf:meta.asOf,
      inputHash:stableHash([meta.revision,input,snapshot.market?.quotes,snapshot.countries,analytical.meta.inputManifest]),
      reproducibility:{complete:false,reason:'legacy ranking and state context are not versioned in older projections'},coverage:meta}};
    if(this.runtime.analysisOnly)await this.runtime.rpc("analysis.persist",{type:"news-projection",checkpoint,record});
    else this.runtime.persistDerived({type:"news-projection",checkpoint,record});
    this.projectionDiagnostics={...this.projectionDiagnostics,stage:"completed",completedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-started)};
    this.runtime.progress("news.projection","completed",{processed:result.news.length,revision:meta.revision});
    this.projectionCache={key:cacheKey,result:structuredClone(result)};
    return result;
  }
  getFeed(options) { return this.corpus.getFeed(options); }
}
