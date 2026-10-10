// Sólo upstreams falsos. Ejecutar con --expose-gc para muestras comparables tras GC.
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {RssCanonicalPipeline} from '../services/news/rssCanonicalPipeline.js';
import {buildCanonicalRssCatalog} from '../services/news/rssCanonicalCatalog.js';
const rounds=Number(process.env.OGID_SOAK_ROUNDS||60),samples=[];
let clock=Date.now();
const catalog=buildCanonicalRssCatalog({primaryFeeds:Array.from({length:300},(_,i)=>({url:`https://${i<240?'search.test':`host${i%12}.test`}/${i}`,minPollIntervalMs:900000}))});
const pipeline=new RssCanonicalPipeline({catalog,persistencePath:join(await mkdtemp(join(tmpdir(),'ogid-soak-')),'state.json'),now:()=>clock,fetchImpl:async url=>new Response(`<rss><channel><item><title>Fixture conflict ${url}</title><link>${url}/article</link><pubDate>${new Date(clock).toUTCString()}</pubDate></item></channel></rss>`)});
const lag=monitorEventLoopDelay({resolution:10});lag.enable();const cpu=process.cpuUsage(),started=performance.now();
for(let round=0;round<rounds;round++){await pipeline.runCycle();await pipeline.flush();clock+=30000;if(round%10===0||round===rounds-1){globalThis.gc?.();samples.push({round,elapsedMs:performance.now()-started,memory:process.memoryUsage(),queued:pipeline.metrics.queued,inFlight:pipeline.metrics.inFlight,activeSemaphores:[...pipeline.hostSemaphores.values()].reduce((n,s)=>n+s.active,0),handles:process._getActiveHandles().length});}await delay(1000);}
await pipeline.stop();lag.disable();console.log(JSON.stringify({node:process.version,rounds,elapsedMs:performance.now()-started,cpu:process.cpuUsage(cpu),eventLoopP95Ms:lag.percentile(95)/1e6,coverage:pipeline.snapshot().meta.coverage,metrics:pipeline.metrics,persistence:pipeline.writer.metrics,samples},null,2));
