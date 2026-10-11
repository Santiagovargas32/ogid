// No external traffic or operator data. Default: thirty real minutes.
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('../tests/testSetup.cjs');
process.env.LOG_LEVEL='error';
const { createAppServer } = await import('../server.js');
const nativeFetch=globalThis.fetch;
let externalRequests=0, marketRequests=0;
globalThis.fetch=async (url,options)=>{
  if(new URL(String(url)).hostname==='127.0.0.1')return nativeFetch(url,options);
  externalRequests++;
  await delay(20,undefined,{signal:options?.signal});
  const items=Array.from({length:20},(_,i)=>`<item><title>Fixture Israel conflict sanctions ${i}</title><link>https://fixture.test/${encodeURIComponent(String(url))}/${i}</link><pubDate>Sun, 11 Oct 2026 12:00:00 GMT</pubDate></item>`).join('');
  return new Response(`<rss><channel>${items}</channel></rss>`);
};
const durationMs=Number(process.env.OGID_SOAK_DURATION_MS||1_800_000);
const directory=await mkdtemp(join(tmpdir(),'ogid-runtime-soak-'));
const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,wsHeartbeatMs:1_000,
  news:{providers:['rss'],rssFeeds:Array.from({length:18},(_,i)=>({url:`https://publisher${i%6}.test/${i}`,label:`Fixture ${i}`})),rssAggregateIntervalMs:2_000,rssAggregateFeedsPerRun:18,rssAggregateMaxItems:900,rssCanonicalStateFile:join(directory,'rss.json')},
  market:{provider:'yahoo',enabled:true,tickers:['GD','BA'],historyPersist:false,dailyCandles:{enabled:false},intradayCandles:{enabled:false}},
  marketDataService:{fetchQuotes:async symbols=>{
    marketRequests++;
    // Regular outages exercise stale data without synthesizing a current quote.
    if(marketRequests%5===0)throw Object.assign(Error('fixture-upstream'),{status:503});
    return symbols.map(symbol=>({symbol,price:100,previousClose:99,changePercent:1,high:101,low:98,volume:1000,currency:'USD',exchange:'NYSE',timezone:'America/New_York',timestamp:new Date().toISOString(),marketState:'CLOSED'}));
  }},awareness:{mode:'off'},ai:{provider:'none',mode:'off'}});
const started=performance.now(),cpu=process.cpuUsage(),elu=performance.eventLoopUtilization();
const lag=monitorEventLoopDelay({resolution:10});lag.enable();
const clients=[],samples=[],latencies=[];
let unexpectedCloses=0,wsMessages=0,wsBytes=0,cycles=0;
let result;
try {
  await runtime.start();
  if(runtime.config.market.tickers.length!==2)throw Error('fixture-watchlist-not-loaded');
  const startupMs=performance.now()-started;
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  for(let i=0;i<10;i++){
    const client=new WebSocket(base.replace('http:','ws:')+'/ws',{origin:base});
    client.on('message',raw=>{wsMessages++;wsBytes+=raw.length;});
    client.on('close',()=>{unexpectedCloses++;});
    await new Promise((resolve,reject)=>{client.once('open',resolve);client.once('error',reject);});
    clients.push(client);
  }
  const until=performance.now()+durationMs;
  while(performance.now()<until){
    const refresh=Promise.all([runtime.orchestrator.runCycle('soak'),runtime.orchestrator.runMarketCycle('soak')]);
    await Promise.all(Array.from({length:10},async(_,i)=>{
      const t=performance.now();const response=await nativeFetch(base+(i%2?'/api/health':'/api/intel/snapshot?countries=ALL&limit=100'));
      await response.arrayBuffer();if(!response.ok)throw Error(`HTTP ${response.status}`);
      latencies.push(performance.now()-t);if(latencies.length>10_000)latencies.shift();
    }));
    await refresh;cycles++;
    if(!samples.length||performance.now()-started-samples.at(-1).elapsedMs>=60_000){
      globalThis.gc?.();
      samples.push({elapsedMs:performance.now()-started,memory:process.memoryUsage(),pending:runtime.orchestrator.pendingCycles.size,clients:runtime.socketServer.clientCount(),rss:runtime.app.locals.rssAggregator.canonicalPipeline.snapshot().meta.metrics});
    }
    await delay(Math.min(2_000,Math.max(0,until-performance.now())));
  }
  latencies.sort((a,b)=>a-b);
  const at=p=>latencies[Math.min(latencies.length-1,Math.ceil(latencies.length*p)-1)];
  result={node:process.version,durationMs,elapsedMs:performance.now()-started,startupMs,cycles,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),eventLoopUtilization:performance.eventLoopUtilization(elu),eventLoopDelayMs:{p50:lag.percentile(50)/1e6,p95:lag.percentile(95)/1e6,p99:lag.percentile(99)/1e6,max:lag.max/1e6},httpMs:{samples:latencies.length,p50:at(.5),p95:at(.95),p99:at(.99)},externalRequests,marketRequests,unexpectedCloses,wsMessages,wsBytes,websocket:runtime.socketServer.getHealth().metrics,samples};
} finally {
  for(const client of clients)client.removeAllListeners('close');
  await Promise.all(clients.map(client=>new Promise(resolve=>{if(client.readyState===WebSocket.CLOSED)return resolve();client.once('close',resolve);client.close(1000,'soak-complete');})));
  await runtime.stop();lag.disable();globalThis.fetch=nativeFetch;
}
if(result){
  await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,artifact:join(directory,'result.json')},null,2));
  if(result.unexpectedCloses||result.eventLoopDelayMs.p95>=100||result.samples.some(s=>s.pending||s.clients!==10))process.exitCode=1;
}
