import {readFileSync} from 'node:fs';
import {providerRuntime} from '../providers/providerRuntime.js';
import {Semaphore} from '../shared/cancellableSemaphore.js';
import {readBoundedBody} from '../shared/boundedResponse.js';
import {AtomicJsonWriter} from '../shared/atomicJsonWriter.js';
import {classifyRssArticle} from './rssClassifier.js';
import {deduplicateRssArticles} from './rssDeduplicator.js';
import {hasFeedEnvelope,parseFeedArticles} from './providers/rssProvider.js';
import {articleIdentity} from './articleIdentity.js';
import {performance} from 'node:perf_hooks';
import {shareOperation,operationContext,checkOperation} from '../shared/operationContext.js';
import {stableHash} from '../../utils/stableHash.js';
function initialState(){return {etag:null,lastModified:null,lastAttemptAt:null,lastSuccessAt:null,nextEligibleAt:null,cooldownUntil:null,consecutiveErrors:0,healthStatus:'unknown',articles:[],status:'unqueried'};}
export class RssCanonicalPipeline {
  constructor({catalog,fetchImpl,now=Date.now,random=Math.random,persistencePath=null,globalConcurrency=4,hostConcurrency=1,maxFeedsPerCycle=18,cycleDeadlineMs=25_000,timeoutMs=8_000,maxCorpusItems=900,maxResponseBytes=2_000_000,maxItemsPerFeed=200,onCollected=null}={}){
    Object.assign(this,{catalog,fetchImpl,now,random,persistencePath,globalConcurrency,hostConcurrency,cycleDeadlineMs,timeoutMs,maxCorpusItems,maxResponseBytes,maxItemsPerFeed,onCollected});
    this.maxFeedsPerCycle=Math.max(1,Math.min(18,maxFeedsPerCycle));this.states=new Map();this.hostSemaphores=new Map();this.corpus=[];this.inFlight=null;this.controller=null;
    this.metrics={cycles:0,externalRequests:0,notModified:0,errors:0,staleServed:0,duplicates:0,latencyMs:0,lastDurationMs:0,deferred:0,queued:0,inFlight:0,newArticles:0,lastParseMs:0,lastClassifyMs:0,lastDedupeMs:0,lastArchiveMs:0};this.hostCooldowns=new Map();
    this.hydrate();this.writer=new AtomicJsonWriter(persistencePath,()=>({version:1,states:Object.fromEntries(this.states),corpus:this.corpus,metrics:this.metrics}));
  }
  state(id){if(!this.states.has(id))this.states.set(id,initialState());return this.states.get(id);}
  hostSemaphore(host){if(!this.hostSemaphores.has(host))this.hostSemaphores.set(host,new Semaphore(this.hostConcurrency));return this.hostSemaphores.get(host);}
  selectEligible(nowMs=this.now(),{feedIds=null,maxFeedsPerCycle=this.maxFeedsPerCycle}={}){
    const allowed=feedIds?new Set(feedIds):null;maxFeedsPerCycle=Math.min(this.maxFeedsPerCycle,maxFeedsPerCycle);
    for(const feed of this.catalog.feeds){const until=this.states.get(feed.feedId)?.hostCooldownUntil;if(until>nowMs){const host=new URL(feed.canonicalUrl).host;this.hostCooldowns.set(host,Math.max(until,this.hostCooldowns.get(host) || 0));}}
    const eligible=this.catalog.feeds.filter(f=>!f.disabled && (!allowed || allowed.has(f.feedId))).filter(f=>{const s=this.state(f.feedId);return (!s.nextEligibleAt||s.nextEligibleAt<=nowMs)&&(!s.cooldownUntil||s.cooldownUntil<=nowMs)&&(!this.hostCooldowns.get(new URL(f.canonicalUrl).host)||this.hostCooldowns.get(new URL(f.canonicalUrl).host)<=nowMs);})
      .sort((a,b)=> (this.state(a.feedId).nextEligibleAt||0)-(this.state(b.feedId).nextEligibleAt||0)||b.priority-a.priority||a.feedId.localeCompare(b.feedId));
    // Round-robin por host: una cola de búsquedas no impide empezar publishers libres.
    const hosts=new Map();for(const f of eligible){const host=new URL(f.canonicalUrl).host;if(!hosts.has(host))hosts.set(host,[]);hosts.get(host).push(f);}
    const selected=[];while(hosts.size&&selected.length<maxFeedsPerCycle){for(const [host,queue] of hosts){selected.push(queue.shift());if(!queue.length)hosts.delete(host);if(selected.length===maxFeedsPerCycle)break;}}
    return selected;
  }
  runCycle(options={}){if(this.inFlight)return shareOperation(this.inFlight);this.inFlight=this.collect(options).finally(()=>{this.inFlight=null;});return shareOperation(this.inFlight);}
  async collect(options={}){
    const started=this.now(),deadline=started+this.cycleDeadlineMs,timeoutMs=Math.min(options.timeoutMs || this.timeoutMs,this.timeoutMs),selected=this.selectEligible(started,options),global=new Semaphore(this.globalConcurrency);
    this.controller=new AbortController();const signal=AbortSignal.any([this.controller.signal,...(operationContext.getStore()?.signal?[operationContext.getStore().signal]:[])]);const timer=setTimeout(()=>this.controller.abort(new DOMException('RSS cycle deadline','TimeoutError')),this.cycleDeadlineMs);
    this.metrics.queued=selected.length;this.metrics.deferred=0;const known=new Set([...this.corpus,...[...this.states.values()].flatMap(s=>s.articles||[])].map(articleIdentity));
    const before={states:new Map(selected.map(feed=>[feed.feedId,structuredClone(this.state(feed.feedId))])),corpus:this.corpus,generatedAt:this.generatedAt};
    this.metrics.lastParseMs=0;this.metrics.lastClassifyMs=0;
    try {
      const results=await Promise.all(selected.map(async feed=>{
        let startedFeed=false;const host=new URL(feed.canonicalUrl).host;
        try{return await this.hostSemaphore(host).use(()=>global.use(async()=>{
          signal.throwIfAborted();if(this.now()>=deadline||this.hostCooldowns.get(host)>this.now())return {feedId:feed.feedId,status:'deferred',articles:[]};
          startedFeed=true;this.metrics.queued--;this.metrics.inFlight++;
          try{return await this.pollFeed(feed,deadline,signal,timeoutMs);}finally{this.metrics.inFlight--;}
        },signal),signal);}catch(error){if(!startedFeed)return {feedId:feed.feedId,status:'deferred',articles:[]};throw error;}
        finally{if(!startedFeed)this.metrics.queued--;}
      }));
      checkOperation();
      this.metrics.deferred=results.filter(r=>r.status==='deferred').length;
      const incoming=results.filter(r=>r.status==='ok'||r.status==='empty').flatMap(r=>r.acquiredArticles || r.articles || []);
      this.metrics.newArticles=new Set(incoming.map(articleIdentity).filter(id=>!known.has(id))).size;
      // Un callback por lote; 304/fallo/deferred no reingieren el corpus antiguo.
      const archiveStarted=performance.now();
      if(incoming.length)await this.onCollected?.(incoming);
      this.metrics.lastArchiveMs=performance.now()-archiveStarted;
      for(const result of results)if(['ok','empty','not-modified'].includes(result.status))this.state(result.feedId).lastCommittedAt=this.now();
      const dedupeStarted=performance.now();
      const merged=deduplicateRssArticles([...this.corpus,...results.flatMap(r=>r.articles||[])],{maxItems:this.maxCorpusItems});
      this.metrics.lastDedupeMs=performance.now()-dedupeStarted;
      this.corpus=merged.items;this.metrics.cycles++;this.metrics.lastDurationMs=Math.max(0,this.now()-started);this.metrics.latencyMs+=this.metrics.lastDurationMs;
      this.generatedAt=new Date(this.now()).toISOString();await this.persist(selected.map(feed=>feed.feedId));
      const successful=results.filter(r=>['ok','empty','not-modified'].includes(r.status));
      const changed=selected.filter(f=>this.state(f.feedId).lastContentChangeAt && this.state(f.feedId).contentHash!==before.states.get(f.feedId)?.contentHash);
      this.lastAcquisition={attempted:results.filter(r=>r.status!=='deferred').length,successfulChecks:successful.length,
        contentChanges:changed.length,notModified:results.filter(r=>r.status==='not-modified').length,
        lastAttemptAt:selected.map(f=>this.state(f.feedId).lastAttemptAt).filter(Boolean).sort((a,b)=>a-b).at(-1) || null,
        lastSuccessfulCheckAt:successful.length?new Date(Math.max(...successful.map(r=>this.state(r.feedId).lastSuccessAt))).toISOString():null,
        lastContentChangeAt:changed.length?new Date(Math.max(...changed.map(f=>this.state(f.feedId).lastContentChangeAt))).toISOString():null,
        lastCommittedAt:successful.length?this.generatedAt:null};
      return { ...this.snapshot(selected.length), selectedFeedIds: selected.map(f=>f.feedId) };
    }catch(error){
      // A 200 response must not leave a new ETag behind when its articles failed
      // to commit: a subsequent 304 would otherwise hide the unarchived change.
      for(const [id,state]of before.states)this.states.set(id,state);
      this.corpus=before.corpus;this.generatedAt=before.generatedAt;throw error;
    }finally{clearTimeout(timer);this.controller=null;this.metrics.queued=0;}
  }
  snapshot(selectedFeedCount=0){
    const feedStatus=this.catalog.feeds.map(feed=>{const s=this.state(feed.feedId);const iso=n=>n?new Date(n).toISOString():null;return {feedId:feed.feedId,label:feed.label,url:feed.canonicalUrl,disabled:feed.disabled,status:feed.disabled?"skipped":s.status,healthStatus:s.healthStatus,count:s.articles.length,acquiredCount:s.acquiredCount ?? null,previewTruncated:s.previewTruncated || false,lastAttemptAt:iso(s.lastAttemptAt),lastSuccessAt:iso(s.lastSuccessAt),lastSuccessfulCheckAt:iso(s.lastSuccessAt),lastContentChangeAt:iso(s.lastContentChangeAt),lastCommittedAt:iso(s.lastCommittedAt),outcome:s.outcome || null,httpStatus:s.lastHttpStatus || null,nextEligibleAt:iso(s.nextEligibleAt),cooldownUntil:iso(s.cooldownUntil),consecutiveErrors:s.consecutiveErrors,error:feed.disabled?feed.reason:s.error||null,hasEtag:Boolean(s.etag),hasLastModified:Boolean(s.lastModified)};});
    const enabled=feedStatus.filter(f=>!f.disabled),checked=enabled.filter(f=>f.lastAttemptAt).length;
    return {generatedAt:this.generatedAt||null,items:this.corpus,meta:{provider:'rss-canonical',selectedFeedCount,feedStatus,acquisition:this.lastAcquisition || {attempted:0,successfulChecks:0,contentChanges:0},metrics:{...this.metrics,hostsLimited:[...this.hostCooldowns.values()].filter(t=>t>this.now()).length,persistence:{...this.writer?.metrics,error:this.writer?.lastError?.message||null}},catalogStats:this.catalog.stats,coverage:{enabled:enabled.length,checked,unqueried:enabled.length-checked},availability:this.corpus.length?(enabled.some(f=>f.healthStatus!=='healthy')?'degraded':'healthy'):'no-recoverable-data'}};
  }
  async pollFeed(feed,deadline,cycleSignal,timeoutMs=this.timeoutMs){
    const state=this.state(feed.feedId),host=new URL(feed.canonicalUrl).host,now=this.now();
    state.lastAttemptAt=now;state.nextEligibleAt=now+feed.minPollIntervalMs*(0.95+this.random()*.1);
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,cycleSignal]);
    const timer=setTimeout(()=>controller.abort(new DOMException('RSS feed timeout','TimeoutError')),Math.min(timeoutMs,Math.max(1,deadline-now)));
    const headers={'User-Agent':'ogid/1.0',Accept:'application/rss+xml, application/atom+xml, application/xml'};
    if(state.etag)headers['If-None-Match']=state.etag;if(state.lastModified)headers['If-Modified-Since']=state.lastModified;
    try{
      this.metrics.externalRequests++;
      const options={headers,signal,retries:0,timeoutMs:Math.min(timeoutMs,deadline-now),bufferResponse:true,maxResponseBytes:this.maxResponseBytes,circuitKey:`rss:${host}`};
      const response=await (this.fetchImpl?this.fetchImpl(feed.canonicalUrl,options):providerRuntime.fetch('rss',feed.canonicalUrl,options));
      signal.throwIfAborted();state.lastHttpStatus=response.status;
      if(response.status===304){this.metrics.notModified++;state.lastSuccessAt=this.now();state.healthStatus='healthy';state.consecutiveErrors=0;state.cooldownUntil=null;state.error=null;state.status='not-modified';state.outcome='not-modified';return {feedId:feed.feedId,status:'not-modified',articles:state.articles.map(a=>({...a,dataMode:'observed',provenance:{...a.provenance,stale:false}}))};}
      if(!response.ok){await response.body?.cancel();const error=Error(`rss-upstream-${response.status}`);const retry=response.headers.get('retry-after');error.retryAfterMs=/^\d+$/.test(retry||'')?Number(retry)*1000:Math.max(0,Date.parse(retry)-this.now());if([429,503].includes(response.status)&&error.retryAfterMs){state.hostCooldownUntil=this.now()+error.retryAfterMs;this.hostCooldowns.set(host,state.hostCooldownUntil);}throw error;}
      const body=await readBoundedBody(response,{signal,maxBytes:this.maxResponseBytes});signal.throwIfAborted();const xml=body.toString('utf8');
      if(!hasFeedEnvelope(xml)||!(/<\/(?:[\w.-]+:)?(?:rss|feed)\s*>/i.test(xml)||/<(?:[\w.-]+:)?(?:rss|feed)\b[^>]*\/\s*>/i.test(xml)) || ((xml.match(/<(?:[\w.-]+:)?(?:item|entry)\b/g)||[]).length !== (xml.match(/<\/(?:[\w.-]+:)?(?:item|entry)\s*>/g)||[]).length))throw Error('rss-malformed-xml');
      const fetchedAt=new Date(this.now()).toISOString();
      const parseStarted=performance.now();
      // The response byte budget bounds acquisition; per-feed item limits only bound the retained preview.
      const parsed=parseFeedArticles(xml,feed.label,feed,Number.MAX_SAFE_INTEGER);
      this.metrics.lastParseMs+=performance.now()-parseStarted;
      const classifyStarted=performance.now();
      const contentHash=stableHash(parsed.map(a=>[a.url,a.title,a.description,a.content,a.publishedAt,a.updatedAt]));
      const articles=parsed.map(a=>classifyRssArticle({...a,id:articleIdentity(a),receivedAt:fetchedAt,provenance:{...a.provenance,feedId:feed.feedId,sourceId:feed.sourceId,sourceType:feed.type,queryProvider:feed.queryProvider,canonicalUrl:feed.canonicalUrl,fetchedAt,pipeline:'canonical-rss',stale:false}}));
      this.metrics.lastClassifyMs+=performance.now()-classifyStarted;
      signal.throwIfAborted();
      if (this.now() >= Math.min(deadline, now + timeoutMs)) throw new DOMException('RSS parse budget exceeded','TimeoutError');
      if(state.contentHash!==contentHash && (parsed.length || state.contentHash)){state.lastContentChangeAt=this.now();}
      state.outcome=!parsed.length?'empty':state.contentHash===contentHash?'unchanged':'changed';
      state.contentHash=contentHash;
      state.etag=response.headers.get('etag')||null;state.lastModified=response.headers.get('last-modified')||null;state.lastSuccessAt=this.now();state.consecutiveErrors=0;state.healthStatus='healthy';state.cooldownUntil=null;state.error=null;state.articles=articles.slice(0,this.maxItemsPerFeed);state.acquiredCount=articles.length;state.previewTruncated=articles.length>state.articles.length;state.status=articles.length?'ok':'empty';
      return {feedId:feed.feedId,status:state.status,articles:state.articles,acquiredArticles:articles};
    }catch(error){
      state.outcome=/malformed/.test(error.message)?'contract-error':/circuit/.test(error.message)?'circuit-open':'transport-error';
      state.consecutiveErrors++;state.healthStatus=state.consecutiveErrors>=3?'unhealthy':'degraded';state.error=error.message;
      state.cooldownUntil=this.now()+Math.max(error.retryAfterMs||0,Math.min(6*3600_000,900_000*2**(state.consecutiveErrors-1)));this.metrics.errors++;
      state.status=state.articles.length?'stale':'error';const articles=state.articles.map(a=>({...a,dataMode:'stale',provenance:{...a.provenance,stale:true}}));this.metrics.staleServed+=articles.length;
      return {feedId:feed.feedId,status:state.status,articles};
    }finally{clearTimeout(timer);}
  }
  persist(){this.writer.mark();}
  async flush(){await this.writer.flush();}
  async stop(){this.controller?.abort(new DOMException('RSS shutdown','AbortError'));await this.inFlight;await this.flush();}
  hydrate(){if(!this.persistencePath)return false;try{const data=JSON.parse(readFileSync(this.persistencePath,'utf8'));if(data.version!==1||!Array.isArray(data.corpus))throw Error('invalid-rss-state');this.states=new Map(Object.entries(data.states||{}));this.corpus=data.corpus;this.metrics={...this.metrics,...data.metrics,queued:0,inFlight:0};this.generatedAt=[...this.states.values()].reduce((latest,s)=>Math.max(latest,s.lastAttemptAt||0),0);this.generatedAt=this.generatedAt?new Date(this.generatedAt).toISOString():null;return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
  rollback(){return {mode:'legacy',corpusPreserved:this.corpus.length,statePreserved:this.states.size};}
}
export function projectCanonicalToProvider(snapshot){const ids=new Set(snapshot.selectedFeedIds||[]);return {provider:'rss',articles:snapshot.items||[],sourceMeta:{provider:'rss',totalResults:snapshot.items?.length||0,feedStatus:(snapshot.meta?.feedStatus||[]).filter(f=>ids.has(f.feedId)),acquisition:snapshot.meta?.acquisition,canonical:true,metrics:snapshot.meta?.metrics||{}}};}
export function compareRssSnapshots(legacy,canonical){const keys=items=>new Set(items.map(a=>`${a.url||''}|${a.title||''}`.toLowerCase()));const l=keys(legacy?.articles||[]),c=keys(canonical?.items||[]),overlap=[...l].filter(k=>c.has(k)).length;return {legacyCount:l.size,canonicalCount:c.size,overlap,coverage:l.size?overlap/l.size:1,crossPipelineDuplicates:overlap};}
