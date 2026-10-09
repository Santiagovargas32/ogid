import { fetchAggregatedNews } from "../services/news/newsAggregatorService.js";
import { normalizeAdminArticles } from "../services/normalizeService.js";
import { computeMarketImpact } from "../services/market/impactEngineService.js";
import { generatePredictions } from "../services/market/predictionEngineService.js";
import { generateInsights } from "../services/insightService.js";
import { listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { riskWithPrevious } from "./sqlNewsCorpus.js";
import apiQuotaTracker from "../services/admin/apiQuotaTrackerService.js";

export class SqlNewsPipeline {
  constructor(runtime, archive, corpus, config) { Object.assign(this, {runtime, archive, corpus, config}); this.inFlight=null; this.diagnostics=runtime.load("news-collection"); }
  async collect(options = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight=this.runCollect(options).finally(() => { this.inFlight=null; });
    return this.inFlight;
  }
  async runCollect(options) {
    const previousSuccess=this.diagnostics?.lastSuccessfulAt || null;
    this.runtime.restoreQuotas();
    this.diagnostics={stage:"fetching", startedAt:new Date().toISOString(), providers:options.providers || this.config.providers};
    const result=await fetchAggregatedNews({...this.config, ...options, rssWorkerFetch:input => this.runtime.fetchRss({...input, lane:"editorial"})});
    this.diagnostics.stage="persisting";
    // RSS has already committed every article before its response cap.
    const articles=(result.rawArticles || result.articles || []).filter(article => article.provider!=="rss" && !article.synthetic && article.provider!=="fallback");
    let accepted=0;
    for (let offset=0; offset<articles.length; offset+=100) {
      accepted+=this.archive.ingest(articles.slice(offset,offset+100), {lane:options.queryLane || "editorial", awarenessMode:options.awarenessMode || this.config.awarenessMode || "off"}).accepted;
      await new Promise(resolve => setImmediate(resolve));
    }
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
    const successful=result.sourceMeta?.attempts?.some(attempt=>attempt.rawCount>0 && ["ok","empty"].includes(attempt.status)) || supplemental?.queriedFeeds>0;
    this.diagnostics.lastSuccessfulAt=successful ? this.diagnostics.completedAt : this.diagnostics.lastSuccessfulAt || previousSuccess;
    this.runtime.save("news-collection",this.diagnostics);
    return {articles:[], rawArticles:normalizeAdminArticles((result.rawArticles || []).slice(0,100), result.sourceMeta?.provider), sourceMode:result.sourceMode, sourceMeta:{...result.sourceMeta, acquiredAt:this.diagnostics.completedAt,persistedBeforeAnalysis:true, rawPreviewLimit:100,supplemental}, quotas:providers,supplementalDue:supplementalDue && Boolean(options.deferSupplemental)};
  }
  async collectSupplemental(){
    if(this.supplementalInFlight)return this.supplementalInFlight;
    if(!this.config.rssAggregateIntervalMs || Date.now()<(this.runtime.nextGeneratedCollectAt || 0))return {skipped:true};
    this.supplementalInFlight=this.runSupplemental().finally(()=>{this.supplementalInFlight=null;});
    return this.supplementalInFlight;
  }
  async runSupplemental(){
    const started=performance.now();
    this.supplementalDiagnostics={stage:"fetching-and-archiving",startedAt:new Date().toISOString()};
    try{
      const snapshot=await this.runtime.services.rss.refresh();
      this.runtime.save("rss",this.runtime.services.rss.lastSnapshot);
      this.runtime.persistedRssSnapshot=this.runtime.services.rss.lastSnapshot;
      if(snapshot.meta.totalItems>0 && this.diagnostics){
        this.diagnostics.lastSuccessfulAt=new Date().toISOString();
        this.runtime.save("news-collection",this.diagnostics);
      }
      this.supplementalDiagnostics={...this.supplementalDiagnostics,stage:"completed",completedAt:new Date().toISOString(),generatedAt:snapshot.generatedAt,queriedFeeds:snapshot.meta.queriedFeedCount,storedItems:snapshot.meta.totalItems,durationMs:Math.round(performance.now()-started)};
      return this.supplementalDiagnostics;
    }catch(error){
      this.supplementalDiagnostics={...this.supplementalDiagnostics,stage:"failed",code:error.code || "RSS_SUPPLEMENTAL_FAILED",durationMs:Math.round(performance.now()-started)};
      throw error;
    }finally{
      this.runtime.nextGeneratedCollectAt=Date.now()+this.config.rssAggregateIntervalMs;
      this.runtime.save("rss-generated",{nextOffset:this.runtime.rssGeneratedCursor,nextCollectAt:this.runtime.nextGeneratedCollectAt});
    }
  }
  async getProjection(input = {}) {
    const started=performance.now();
    this.projectionDiagnostics={stage:"reading-corpus",startedAt:new Date().toISOString()};
    const context=this.runtime.context, snapshot=context.snapshot || {};
    const corpus=await this.corpus.read({countries:input.countries || this.config.watchlistCountries || [], awarenessMode:input.awarenessMode || this.config.awarenessMode || "off"});
    this.projectionDiagnostics={...this.projectionDiagnostics,stage:"market-impact",corpusMs:Math.round(performance.now()-started),marketAnalysisCount:corpus.marketSignalCorpus.length};
    const riskResult=riskWithPrevious(corpus.riskResult, snapshot.countries);
    const market=context.selectedInstrumentIds || [], instruments=listVerifiedInstruments().filter(instrument => market.includes(instrument.instrumentId));
    const tickers=input.tickers || instruments.map(instrument => instrument.canonicalSymbol);
    const acquisitionAt=this.diagnostics?.lastSuccessfulAt || corpus.meta.lastIngestAt;
    const age=acquisitionAt ? Date.now()-Date.parse(acquisitionAt) : Infinity;
    const sourceMode=corpus.meta.eligibleCount ? (age <= (this.config.freshnessMs || 600000) ? "live" : "stale") : "unavailable";
    const inputMode=snapshot.market?.sourceMode === "fallback" ? "mixed" : sourceMode;
    const common={articles:corpus.marketSignalCorpus, countries:riskResult.countries, marketQuotes:snapshot.market?.quotes || {}, tickers, instruments, inputMode};
    const impact=computeMarketImpact({...common, countryFilter:input.countries || this.config.watchlistCountries || [], windowMin:input.impactWindowMin || 240, impactHistory:snapshot.impactHistory || [], predictionScores:snapshot.predictions?.predictionScoreByTicker || {}});
    this.projectionDiagnostics.stage="predictions";
    const predictions=generatePredictions(common);
    const insights=generateInsights({countries:riskResult.countries, previousCountries:snapshot.countries || {}, inputMode});
    const meta={...corpus.meta,lastSuccessfulAcquisitionAt:this.diagnostics?.lastSuccessfulAt || null,lastAcquisitionAttemptAt:this.diagnostics?.startedAt || null,freshnessBasis:this.diagnostics?.lastSuccessfulAt ? "provider-collection" : "archive-last-ingest",sourceMode};
    const {displayCandidates, ...projection}=corpus;
    const result={...projection, meta, riskResult, impact, predictions, insights, sourceMode};
    const checkpoint={kind:"news-projection",persisted:true,...meta, collection:this.diagnostics || null};
    this.projectionDiagnostics.stage="saving";
    this.runtime.save("news-projection", checkpoint);
    this.runtime.db.prepare("INSERT INTO pipeline_checkpoints VALUES(?,?,?,?) ON CONFLICT(pipeline_id) DO UPDATE SET updated_at=excluded.updated_at,revision=excluded.revision,payload_json=excluded.payload_json").run("news",corpus.meta.asOf,String(corpus.meta.revision),JSON.stringify(checkpoint));
    this.projectionDiagnostics={...this.projectionDiagnostics,stage:"completed",completedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-started)};
    return result;
  }
  getFeed(options) { return this.corpus.getFeed(options); }
}
