// Controlled fixture traffic only. It never edits operator JSON or an existing database.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { StateSynchronizer } from '../../frontend/js/stateSync.js';
createRequire(import.meta.url)('../tests/testSetup.cjs');process.env.LOG_LEVEL='error';
const durationMs=Number(process.env.OGID_SOAK_DURATION_MS || 1_800_000),directory=await mkdtemp(join(process.env.OGID_SOAK_ROOT || tmpdir(),'ogid-p0-soak-'));
const databasePath=join(directory,'candidate.sqlite');
if(process.env.OGID_SOAK_SOURCE_DB)await copyFile(process.env.OGID_SOAK_SOURCE_DB,databasePath);
let selectedSymbols=['GD','BA'],selectedInstrumentIds=[],storedCandleCounts={},fixtureInstruments=new Map();
if(process.env.OGID_SOAK_SOURCE_DB){
 const source=new Database(databasePath,{readonly:true});
 const persisted=source.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='market'").get();
 const saved=persisted?JSON.parse(persisted.payload_json):null;
 const ids=Object.values(saved?.quotes || {}).map(q=>q.instrumentId).filter(Boolean);
 const universe=source.prepare("SELECT instrument_id,metadata_json FROM instruments").all().filter(r=>ids.includes(r.instrument_id)).map(r=>JSON.parse(r.metadata_json));
 if(universe.length){fixtureInstruments=new Map(universe.map(i=>[i.providerSymbols?.yahoo || i.canonicalSymbol,i]));globalThis.__OGID_TEST_MARKET_INSTRUMENTS__=universe;selectedSymbols=universe.map(i=>i.canonicalSymbol);selectedInstrumentIds=universe.map(i=>i.instrumentId);}
 storedCandleCounts=Object.fromEntries(source.prepare("SELECT instrument_id,count(*) AS n FROM candles GROUP BY instrument_id").all().filter(r=>ids.includes(r.instrument_id)).map(r=>[r.instrument_id,r.n]));source.close();
}
const {createAppServer}=await import('../server.js');const {default:stateManager}=await import('../state/stateManager.js');
let fixtureRound=0,feedRequests=0;
const feedServer=createServer((req,res)=>{
 feedRequests++;res.setHeader('Content-Type','application/rss+xml');
 res.end(`<rss><channel>${Array.from({length:20},(_,i)=>`<item><title>Fixture Israel conflict sanctions ${fixtureRound}-${i}</title><link>http://127.0.0.1/story/${fixtureRound}/${req.url}/${i}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join('')}</channel></rss>`);
});feedServer.listen(0,'127.0.0.1');await once(feedServer,'listening');
const feeds=Array.from({length:18},(_,i)=>({url:`http://127.0.0.1:${feedServer.address().port}/rss-${i}`,label:`Fixture ${i}`}));
const storage={enabled:true,businessEnabled:true,databasePath,timeoutMs:30000,queueTimeoutMs:30000};
const options={port:0,host:'0.0.0.0',disableBackgroundRefresh:true,wsHeartbeatMs:1000,storage,
 news:{providers:['rss'],rssFeeds:feeds,sourceAllowlist:[],domainAllowlist:[],rssAggregateIntervalMs:0,rssPollIntervalMs:1,analyzeLimit:3000,displayLimit:40},
 market:{provider:'yahoo',enabled:true,initialTickers:selectedSymbols,tickers:selectedSymbols,historyDir:directory,historyPersist:false,dailyCandles:{enabled:false},intradayCandles:{enabled:false}},
 marketDataService:{fetchQuotes:async symbols=>symbols.map(symbol=>({symbol,price:100,previousClose:99,changePercent:1,high:101,low:98,volume:1000,currency:fixtureInstruments.get(symbol)?.currency || 'USD',exchange:fixtureInstruments.get(symbol)?.exchange || 'NYSE',timezone:fixtureInstruments.get(symbol)?.timezone || 'America/New_York',timestamp:new Date().toISOString(),marketState:'CLOSED'}))},awareness:{mode:'off'},ai:{provider:'none',mode:'off'}};
let runtime=createAppServer(options),base,wsBytes=0,httpSyncBytes=0,unexpectedCloses=0,forcedCloses=0,cycles=0;
const clients=[],latencies=[],advancedLatencies=[],samples=[],errors=[];let result;
const timings=status=>({queueMs:status.lastQueueMs ?? null,executionMs:status.lastExecutionMs ?? null,totalMs:status.lastTotalMs ?? null,cpuMs:status.lastCpuMs ?? null});
const start=performance.now(),cpu=process.cpuUsage(),elu=performance.eventLoopUtilization(),lag=monitorEventLoopDelay({resolution:10});lag.enable();
const fetchJson=async(path,signal)=>{const response=await fetch(base+path,{signal});const text=await response.text();httpSyncBytes+=Buffer.byteLength(text);if(!response.ok)throw Object.assign(Error(`HTTP ${response.status}`),{status:response.status});return JSON.parse(text).data;};
async function connectClient(slot){
 const client=clients[slot] ||= {updates:{},sync:null,socket:null,expected:false};
 client.expected=false;client.sync ||= new StateSynchronizer({api:{getSyncSnapshot:(p={},o={})=>fetchJson('/api/intel/sync?'+new URLSearchParams(p),o.signal)},onUpdate:update=>Object.assign(client.updates,update),onStatus:(status,error)=>{if(error)errors.push({component:'sync',code:error.code || error.message});}});
 const socket=client.socket=new WebSocket(base.replace('http:','ws:')+'/ws',{origin:base});
 socket.on('message',raw=>{wsBytes+=raw.length;const m=JSON.parse(raw);if(['ws:ready:v2','state:revision:v2','resync:required:v2'].includes(m.type))client.sync.accept(m);});
 socket.on('error',e=>errors.push({component:'ws',code:e.code || e.message}));
 socket.on('close',()=>{if(client.expected)forcedCloses++;else unexpectedCloses++;});await once(socket,'open');return client;
}
async function disconnect(slot){const c=clients[slot];c.expected=true;const closed=once(c.socket,'close');c.socket.close(1000,'controlled-reconnect');await closed;}
async function synchronized(){const deadline=performance.now()+30000;while(clients.some(c=>c.sync.task||c.sync.timer||c.sync.epoch!==runtime.socketServer.sync.epoch||Object.entries(runtime.socketServer.sync.manifest().resources).some(([k,v])=>c.sync.applied[k]!==v))){if(performance.now()>deadline)throw Error('synchronization-deadline');await delay(25);}}
try{
 await runtime.start();base=`http://127.0.0.1:${runtime.server.address().port}`;
 stateManager.state.transportFixture={text:'x'.repeat(11_000_000),id:'large-http-bootstrap'};
 await Promise.all(Array.from({length:10},(_,i)=>connectClient(i)));await synchronized();
 if(clients.some(c=>c.updates.transportFixture?.text.length!==11_000_000))throw Error('large-bootstrap-loss');
 const startupMs=performance.now()-start,bootstrapHttpBytes=httpSyncBytes;
 const until=performance.now()+durationMs;
 while(performance.now()<until){
   fixtureRound++;
   const refresh=Promise.all([runtime.orchestrator.runNewsCycle('soak',{allowExhaustedProviders:true}),runtime.orchestrator.runMarketCycle('soak')]);
   await Promise.all(Array.from({length:10},async(_,i)=>{const t=performance.now();const response=await fetch(base+(i%2?'/api/health':'/api/market/quotes'));await response.arrayBuffer();if(!response.ok)throw Error(`interactive HTTP ${response.status}`);latencies.push(performance.now()-t);}));
   await refresh;
   for(const stage of ['news','market']){
     const status=runtime.app.locals.pipelineMonitor.snapshot()[stage];
     if(status && ['degraded','blocked','failed'].includes(status.status))errors.push({component:stage,cycle:cycles,status:status.status,code:status.errorCode,reason:status.reason});
   }
   // Conditions/Advanced run concurrently with the next interactive sample.
   if(cycles%10===0){const t=performance.now();const analysis=Promise.all(['/api/intel/advanced-snapshot?countries=US','/api/market/conditions?countries=US'].map(async path=>{const r=await fetch(base+path,{signal:AbortSignal.timeout(30000)});await r.arrayBuffer();if(!r.ok)throw Error(`analysis HTTP ${r.status}`);}));
     const health=await fetch(base+'/api/health');await health.arrayBuffer();await analysis;advancedLatencies.push(performance.now()-t);
   }
   await synchronized();cycles++;
   if(cycles===2){await disconnect(0);await runtime.orchestrator.runNewsCycle('reconnect-news',{allowExhaustedProviders:true});await connectClient(0);await synchronized();}
   if(cycles===4){await disconnect(1);await delay(500);await connectClient(1);await synchronized();}
   if(cycles===6){
     for(let i=0;i<clients.length;i++)await disconnect(i);await runtime.stop();
     runtime=createAppServer(options);await runtime.start();base=`http://127.0.0.1:${runtime.server.address().port}`;
     stateManager.state.transportFixture={text:'x'.repeat(11_000_000),id:'large-http-bootstrap'};
     await Promise.all(clients.map((_,i)=>connectClient(i)));await synchronized();
   }
   if(!samples.length||performance.now()-start-samples.at(-1).elapsedMs>=60000){
     globalThis.gc?.();const s=runtime.storageManager.getStatus();samples.push({elapsedMs:performance.now()-start,memory:process.memoryUsage(),clients:runtime.socketServer.clientCount(),queue:s.queue,analysisQueue:s.analysis?.queue,storageTimings:timings(s),analysisTimings:s.analysis?timings(s.analysis):null,databaseBytes:s.databaseBytes,walBytes:s.walBytes,pipelines:runtime.app.locals.pipelineMonitor.snapshot()});
     await writeFile(join(directory,'progress.json'),JSON.stringify({cycles,elapsedMs:performance.now()-start,unexpectedCloses,forcedCloses,wsBytes,httpSyncBytes,last:samples.at(-1)},null,2));
   }
   await delay(Math.min(2000,Math.max(0,until-performance.now())));
 }
 const address=Object.values(networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal)?.address;
 let lan=false;if(address){const c=new WebSocket(`ws://${address}:${runtime.server.address().port}/ws`,{origin:`http://${address}:${runtime.server.address().port}`});await once(c,'open');c.close(1000,'lan-smoke');await once(c,'close');lan=true;}
 const verify=await runtime.storageManager.request('storage.verify');
 const db=new Database(databasePath,{readonly:true});const events=db.prepare('SELECT count(*) AS n FROM events').get().n;db.close();
 const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)] || null;
 result={selectedSymbols,selectedInstrumentIds,storedCandleCounts,node:process.version,durationMs,elapsedMs:performance.now()-start,startupMs,cycles,feedRequests,unexpectedCloses,forcedCloses,wsBytes,httpSyncBytes,bootstrapHttpBytes,largeBootstrapBytes:11_000_000,lan,events,integrity:verify.integrity,foreignKeys:verify.foreignKeys,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),eventLoopUtilization:performance.eventLoopUtilization(elu),eventLoopDelayMs:{p95:lag.percentile(95)/1e6,p99:lag.percentile(99)/1e6,max:lag.max/1e6},httpMs:{samples:latencies.length,p50:percentile(latencies,.5),p95:percentile(latencies,.95),p99:percentile(latencies,.99)},analysisMs:{samples:advancedLatencies.length,p50:percentile(advancedLatencies,.5),p95:percentile(advancedLatencies,.95),max:Math.max(...advancedLatencies)},websocket:runtime.socketServer.getHealth().metrics,storage:runtime.storageManager.getStatus().queue,analysisQueue:runtime.storageManager.getStatus().analysis?.queue,errors,samples};
 if(unexpectedCloses||errors.length||verify.foreignKeys.length||verify.integrity[0].integrity_check!=='ok')process.exitCode=1;
}catch(error){process.exitCode=1;result={failure:error.code || error.message,cycles,elapsedMs:performance.now()-start,unexpectedCloses,errors};}
finally{
 for(const c of clients){c.expected=true;c.sync.close();c.socket?.terminate();}
 await runtime.stop().catch(e=>{result.shutdownError=e.code || e.message;process.exitCode=1;});lag.disable();await new Promise(resolve=>feedServer.close(resolve));
 await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,samples:undefined,artifact:join(directory,'result.json')},null,2));
}
