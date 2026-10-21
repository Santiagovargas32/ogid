// Normalize worker telemetry without triggering acquisition or inventing metrics.
export function workerRssStatus(rss) {
 if(!rss)return null;
 const feeds=(rss.catalogStatus||[]).filter(f=>f.enabled!==false),checked=feeds.filter(f=>f.lastAttemptAt),errors=checked.filter(f=>f.status==='error'||f.status==='deadline'||f.error);
 const running=['fetching','persisting'].includes(rss.stage),duration=Date.parse(rss.completedAt)-Date.parse(rss.startedAt);
 return {...rss,availability:rss.stage==='failed'?'failed':running?'running':!checked.length?'not-polled':errors.length?'degraded':checked.length<feeds.length?'partial':'healthy',
  coverage:{checked:checked.length,enabled:rss.availableFeedCount??feeds.length},
  lastSuccessAt:feeds.map(f=>f.lastSuccessAt).filter(Boolean).sort().at(-1)||null,
  metrics:{queued:null,inFlight:running?null:0,deferred:null,hostsLimited:null,
   notModified:checked.filter(f=>f.status==='not-modified').length,errors:errors.length,
   collectedArticles:rss.collectedCount??null,newArticles:null,lastDurationMs:Number.isFinite(duration)&&duration>=0?duration:null}};
}
