// Isolated acceptance: canonical RSS -> SQLite + maintenance + durable leases.
// Use tests/testSetup.cjs; no operational DB, external provider or model.
import {mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {readMeta,writeMeta,SqlCandleStore} from '../storage/sqlRepositories.js';
import {beginEventIndex} from '../storage/eventIndex.js';
import {StorageManager} from '../storage/StorageManager.js';
import {deriveFeedId} from '../services/news/rssCanonicalCatalog.js';

if(process.env.NODE_ENV!=='test')throw Error('Use --require ./tests/testSetup.cjs');
const output=resolve(process.argv[2]||''),allowed=resolve('../.agent-validation');
if(!process.argv[2]||!output.startsWith(allowed+'/'))throw Error('New isolated output directory required');
mkdirSync(output,{mode:0o700});
const file=join(output,'fixture.sqlite'),N=140000,at=new Date().toISOString(),db=new Database(file);
db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');migrate(db);
const projected=db.prepare("INSERT INTO events VALUES(?,NULL,'legacy',1,NULL,?,'unknown',?)"),canonical=db.prepare("INSERT INTO research_rows VALUES('events',?,?)");
for(let offset=0;offset<N;offset+=1000)db.transaction(()=>{for(let n=offset;n<Math.min(offset+1000,N);n++){
 const row={eventId:`contention-${n}`,identityVersion:'legacy',revision:1,evidence:[],padding:'x'.repeat(2048)},payload=JSON.stringify(row);
 projected.run(row.eventId,at,payload);canonical.run(row.eventId,payload);
}})();
// All seeded legacy events correctly have no instrument impacts. This fixture
// starts on that coherent index and leaves 020's derived audits unfinished.
beginEventIndex(db);writeMeta(db,'events.index',readMeta(db,'events.index.build').fingerprint);db.prepare("DELETE FROM runtime_meta WHERE key='events.index.build'").run();
const candles=new SqlCandleStore(db);
for(let start=0;start<4096;start+=128)candles.append(Array.from({length:128},(_,i)=>{const open=Date.UTC(2026,0,1)+(start+i)*300000;return {instrumentId:'crypto-bitcoin-us-dollar',interval:'5min',openTime:new Date(open).toISOString(),closeTime:new Date(open+300000).toISOString(),open:100,high:102,low:99,close:101,volume:10,adjusted:true,revision:1,source:'fixture'};}));
db.prepare('DELETE FROM candle_validations').run();db.pragma('wal_checkpoint(TRUNCATE)');db.close();
const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});
let server,timer,running=false,work,loadError,feedRequests=0,heartbeatCount=0,commits=0;
const latency=[],samples=[];
const stats=values=>{const a=[...values].sort((x,y)=>x-y);return {N:a.length,p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1)};};
try{
 server=createServer((req,res)=>{
  feedRequests++;const id=req.url.slice(1),items=Array.from({length:70},(_,i)=>`<item><guid>${id}-${i}</guid><title>Fixture world report ${id} ${i}</title><link>https://fixture.invalid/${id}/${i}</link><pubDate>${new Date().toUTCString()}</pubDate><description>Permitted RSS fixture description.</description></item>`).join('');
  res.setHeader('Content-Type','application/rss+xml');res.end(`<rss version="2.0"><channel><title>Fixture</title>${items}</channel></rss>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const feeds=Array.from({length:18},(_,i)=>({sourceId:`fixture-${i}`,name:`Fixture ${i}`,url:`http://127.0.0.1:${server.address().port}/feed-${i}`,topics:['world']}));
 await manager.start();manager.deferEventIndex();
 await manager.request('domain.configure',{rootDir:output,instruments:globalThis.__OGID_TEST_MARKET_INSTRUMENTS__,awarenessMode:'visible',news:{providers:[],rssFeeds:feeds,rssPipelineMode:'canonical',rssFeedsPerCycle:18},rss:{rssFeeds:feeds,pipelineMode:'canonical',globalConcurrency:4,maxFeedsPerCycle:18}});
 await manager.request('agent.call',{method:'enqueue',args:{task:'global_intelligence_brief',model:'llamacpp/fixture',key:randomUUID(),priority:10}});
 const claim=await manager.request('agent.call',{method:'claim',args:{owner:'contention-owner'}});
 const tick=()=>{if(!running)return;work=(async()=>{
  const start=performance.now();await manager.request('agent.call',{method:'heartbeat',args:{jobId:claim.jobId,owner:'contention-owner',fence:claim.fence,renewalId:randomUUID()}});latency.push(performance.now()-start);heartbeatCount++;
  await manager.request('runtime.save',{kind:'contention-fixture-progress',payload:{sequence:++commits}});
  const state=manager.getStatus();samples.push({state:state.state,heartbeatAgeMs:state.worker?.heartbeatAt?Date.now()-Date.parse(state.worker.heartbeatAt):null,index:state.eventIndex});
 })().catch(error=>{loadError=error;running=false;}).finally(()=>{if(running)timer=setTimeout(tick,30);});};
 running=true;tick();
 const acquisition=manager.request('domain.call',{service:'rss',method:'refresh',args:[{force:true,feedIds:feeds.map(f=>deriveFeedId(f.url)),maxFeedsPerCycle:18}]});
 manager.resumeEventIndex({release:true});
 await acquisition;
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){if(loadError)throw loadError;const index=manager.getStatus().eventIndex;if(heartbeatCount>=50&&index.candleValidation?.processed>0&&index.researchProjection?.processed>0)break;await wait(50);}
 running=false;clearTimeout(timer);await work;if(loadError)throw loadError;
 const coverage=await manager.request('domain.call',{service:'news',method:'coverage',args:[]}),status=manager.getStatus(),timing=stats(latency);
 const result={fixture:true,operationalDatabaseAccessed:false,seedEvents:N,seedCandles:4096,feedRequests,expectedArticles:1260,storedArticles:coverage.totalStored,heartbeats:timing,commits,writerState:status.state,readerStates:{analysis:status.analysis.state,queries:status.queries.state},maintenance:status.eventIndex,unconfirmedCommands:status.failure||null,guardTimeoutMs:manager.options.timeoutMs,sqlite:{synchronous:status.synchronous,autoCheckpoint:status.autoCheckpoint},walCheckpoint:status.walCheckpoint,acceptance:status.synchronous===2&&status.autoCheckpoint===0&&status.walCheckpoint.connection.queryOnly&&coverage.totalStored===1260&&feedRequests===18&&heartbeatCount>=50&&timing.p95<=2000&&timing.max<=5000&&status.state==='ready'&&status.eventIndex.candleValidation?.processed>0&&status.eventIndex.researchProjection?.processed>0};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});writeFileSync(join(output,'samples.json'),JSON.stringify(samples,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(result));if(!result.acceptance)process.exitCode=1;
}finally{
 running=false;clearTimeout(timer);await work?.catch(()=>{});await manager.close();if(server)await new Promise(resolve=>server.close(resolve));
 for(const suffix of ['','-wal','-shm'])rmSync(file+suffix,{force:true});
}
