import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createAppServer } from '../server.js';
const nativeFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (url, options) => {
  if (String(url).startsWith('http://127.0.0.1')) return nativeFetch(url, options);
  requests++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(`<rss><channel><title>Fixture</title><item><title>Israel missile strike sanctions conflict cyber</title><link>https://fixture.test/${new URL(url).pathname}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`)), 80);
    options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, {once:true});
  });
};
process.env.NODE_ENV = 'test'; // Sin archivos de otra ejecución ni claves del operador.
const runtime = createAppServer({port:0, disableBackgroundRefresh:true, market:{enabled:false,historyPersist:false}, news:{providers:['rss'],rssFeeds:Array.from({length:18},(_,i)=>({url:`https://host${i%6}.test/${i}`,label:`Fixture ${i}`})),rssAggregateFeedsPerRun:18,rssAggregateMaxItems:900,timeoutMs:900}});
await runtime.start();
const base = `http://127.0.0.1:${runtime.server.address().port}`;
const lag = monitorEventLoopDelay({resolution:10}); lag.enable();
const cpu = process.cpuUsage(); const start = performance.now();
let firstSelectionMs = null; const originalBroadcast = runtime.socketServer.broadcast; runtime.socketServer.broadcast = (type,data,meta) => { if (data?.news?.length && firstSelectionMs === null) firstSelectionMs = performance.now()-start; originalBroadcast(type,data,meta); };
const cycle = runtime.orchestrator.runCycle('benchmark');
const samples = {};
for (const clients of [1,10]) {
  for (const route of ['/', '/admin', '/api/health','/api/intel/snapshot?countries=ALL&limit=100','/api/news/aggregate?stored=1&limit=40','/api/admin/news-raw?dataset=rss-aggregate&stored=1']) {
    const times=[]; let bytes=0;
    for(let j=0;j<10;j++) await Promise.all(Array.from({length:clients},async()=>{const t=performance.now();const r=await nativeFetch(base+route);const body=await r.text(); if(!r.ok)throw Error(`${route}:${r.status}`);bytes=Buffer.byteLength(body);times.push(performance.now()-t);}));
    times.sort((a,b)=>a-b);samples[`${clients}:${route}`]={p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)],bytes};
  }
}
await cycle;
const warmStored={};
for(const clients of [1,10]) {
 for(const route of ['/api/health','/api/intel/snapshot?countries=ALL&limit=100','/api/news/aggregate?stored=1&limit=40','/api/admin/news-raw?dataset=rss-aggregate&stored=1']) {
  const times=[];let bytes=0;
  for(let round=0;round<10;round++)await Promise.all(Array.from({length:clients},async()=>{const t=performance.now();const response=await nativeFetch(base+route);const body=await response.text();if(!response.ok)throw Error(`${route}:${response.status}`);bytes=Buffer.byteLength(body);times.push(performance.now()-t);}));
  times.sort((a,b)=>a-b);warmStored[`${clients}:${route}`]={p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)],bytes};
 }
}
lag.disable();
console.log(JSON.stringify({node:process.version,config:{pipeline:runtime.config.news.rssPipelineMode,feeds:runtime.config.news.rssFeeds.length,global:runtime.config.news.rssGlobalConcurrency,host:runtime.config.news.rssHostConcurrency,deadline:runtime.config.news.rssCycleDeadlineMs,corpus:runtime.app.locals.rssAggregator.corpus.length},samples,warmStored,firstSelectionMs,upstreamRequests:requests,elapsedMs:performance.now()-start,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),eventLoopP95Ms:lag.percentile(95)/1e6,cycle:runtime.orchestrator.newsCycleTelemetry,wsBytes:Buffer.byteLength(JSON.stringify(runtime.orchestrator.buildUpdatePayload(runtime.orchestrator.stateManager.getSnapshot())))},null,2));
await runtime.stop();
