// Isolated P0 acceptance fixture. Never opens or copies the operational DB.
// Run with tests/testSetup.cjs; each output directory must be new.
import {mkdirSync,writeFileSync,rmSync,statfsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {cpus,totalmem,platform,release} from 'node:os';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import express from 'express';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {StorageManager} from '../storage/StorageManager.js';
import {createBusinessAdapters} from '../storage/businessAdapters.js';
import {historyStatus} from '../controllers/historyAdminController.js';

if(process.env.NODE_ENV!=='test')throw Error('Use --require ./tests/testSetup.cjs');
const output=resolve(process.argv[2]||''),allowed=resolve('../.agent-validation');
if(!process.argv[2]||!output.startsWith(allowed+'/'))throw Error('A new .agent-validation subdirectory is required');
mkdirSync(output,{mode:0o700});
const fixtureRoot=resolve(process.argv[3]||output);
if(fixtureRoot!==output&&!fixtureRoot.startsWith('/home/fedora/.local/share/ogid/validation/'))throw Error('Isolated SSD validation directory required');
if(fixtureRoot!==output)mkdirSync(fixtureRoot,{recursive:true,mode:0o700});
const file=join(fixtureRoot,'fixture.sqlite'),db=new Database(file),N=140000,at=new Date().toISOString();
db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');migrate(db);
const insert=db.prepare('INSERT INTO events VALUES(?,NULL,?,1,NULL,?,\'unknown\',?)'),research=db.prepare("INSERT INTO research_rows VALUES('events',?,?)");
const padding=[1024,4096,16384],seedStart=performance.now();
const instrumentId='crypto-bitcoin-us-dollar';
db.prepare('INSERT INTO instruments VALUES(?,?,?,?,?,?)').run(instrumentId,'BTC-USD','crypto','USD','UTC','{}');
const link=db.prepare('INSERT INTO event_index_links VALUES(?,?,?,?)');
db.prepare("INSERT INTO runtime_meta VALUES('events.index.active','\"volume-generation\"')").run();
for(let offset=0;offset<N;offset+=1000)db.transaction(()=>{for(let n=offset;n<Math.min(N,offset+1000);n++){
  const row={eventId:`volume-${String(n).padStart(8,'0')}`,identityVersion:n%17?'source-publication-v2':'legacy',revision:1,evidence:[],padding:'x'.repeat(padding[n%padding.length])},payload=JSON.stringify(row);
  insert.run(row.eventId,row.identityVersion,at,payload);research.run(row.eventId,payload);
  if(n%20===0)link.run('volume-generation',row.eventId,instrumentId,JSON.stringify({instrumentId,score:1}));
}})();
const queryPlans={counts:db.prepare('EXPLAIN QUERY PLAN SELECT identity_version,count(*) FROM events INDEXED BY events_by_identity GROUP BY identity_version').all(),legacy:db.prepare("EXPLAIN QUERY PLAN WITH refs AS MATERIALIZED(SELECT rowid,identity_version FROM events INDEXED BY events_by_identity WHERE identity_version!='source-publication-v2' AND (identity_version,rowid)>('',0) ORDER BY identity_version,rowid LIMIT 101) SELECT e.event_id FROM refs JOIN events e ON e.rowid=refs.rowid").all()};
db.prepare("INSERT INTO runtime_meta VALUES('projection.events.status','\"ready\"')").run();
const seedMs=performance.now()-seedStart;db.pragma('wal_checkpoint(TRUNCATE)');db.close();
const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});
let administrativeProviderRPCs=0;
manager.rpcHandler=()=>{administrativeProviderRPCs++;throw Error('Unexpected provider RPC from administrative read');};
const fixtureInstrument=globalThis.__OGID_TEST_MARKET_INSTRUMENTS__.find(i=>i.instrumentId==='crypto-bitcoin-us-dollar');
const loop=monitorEventLoopDelay({resolution:10});loop.enable();let server,timer,running=false,work=null,commits=0,heartbeats=0,simulatedAcquisitions=0,loadError=null,maxRss=process.memoryUsage().rss;const heartbeatMs=[];
const cold=[],hot=[],eventsCold=[],eventsHot=[],sizes=[];let originalOwner=null;
const stats=values=>{const a=[...values].sort((a,b)=>a-b);return {N:a.length,p50:a[Math.floor((a.length-1)*0.5)],p95:a[Math.ceil(a.length*0.95)-1],max:a.at(-1)};};
try{
  await manager.start();manager.deferEventIndex();
  await manager.request('domain.configure',{rootDir:output,news:{providers:[],rssFeeds:[]},rss:{rssFeeds:[]},instruments:[fixtureInstrument]});
  const business=createBusinessAdapters(manager,{rootDir:output});
  await manager.request('agent.call',{method:'enqueue',args:{task:'global_intelligence_brief',model:'llamacpp/fixture',key:randomUUID(),priority:10}});
  const job=await manager.request('agent.call',{method:'claim',args:{owner:'volume-owner'}});originalOwner=job;
  const heartbeat=async()=>{const start=performance.now();await manager.request('agent.call',{method:'heartbeat',args:{jobId:job.jobId,owner:'volume-owner',fence:job.fence,renewalId:randomUUID()}});heartbeatMs.push(performance.now()-start);heartbeats++;};
  running=true;
  const tick=()=>{if(!running)return;work=(async()=>{
    // Simulated provider response, followed by the real idempotent candle commit
    // path. Revisions change concurrently with administrative reads.
    const openTime=new Date(Date.parse('2026-01-01T00:00:00Z')+simulatedAcquisitions++*300000).toISOString();
    const acquired=await Promise.resolve({instrumentId:fixtureInstrument.instrumentId,interval:'5min',openTime,closeTime:new Date(Date.parse(openTime)+300000).toISOString(),open:100,high:102,low:99,close:101,volume:100,currency:'USD',source:'fixture-provider',dataMode:'observed',quality:'valid',adjusted:true,revision:1});
    const ack=await manager.request('domain.call',{service:'candles',method:'append',args:[[acquired]],requestId:`volume-candle-${simulatedAcquisitions}`});
    if(ack.inserted!==1)throw Error('Synthetic acquisition did not commit');commits++;await heartbeat();maxRss=Math.max(maxRss,process.memoryUsage().rss);
  })().catch(error=>{loadError=error;running=false;}).finally(()=>{if(running)timer=setTimeout(tick,20);});};tick();
  const app=express();app.locals.business=business;app.locals.officialSourceService=business.sources;app.locals.awarenessService={getSnapshot:()=>({sourceStatus:[]})};
  app.get('/api/admin/history',(req,res,next)=>historyStatus(req,res).catch(next));
  app.use((error,_req,res,_next)=>res.status(error.statusCode||500).json({code:error.code}));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}/api/admin/history`;
  for(let n=0;n<50;n++){
    // Cold = freshly reconstructed, ready query worker; filesystem/OS cache is
    // deliberately not flushed. Warm = identical revision immediately reused.
    manager.queryManager.fail(Object.assign(Error('injected reader failure'),{code:'STORAGE_READ_TIMEOUT'}));
    assertWriter();await heartbeat();await manager.recoverReader('queries');
    if(!manager.queryManager.getStatus().queryOnly||!manager.queryManager.getStatus().readOnlyConnection)throw Error('Reader isolation failed');
    for(const cohort of [cold,hot]){
      const start=performance.now(),response=await fetch(url);const bytes=Buffer.from(await response.arrayBuffer());cohort.push(performance.now()-start);sizes.push(bytes.length);
      if(response.status!==200)throw Error(`Administrative HTTP ${response.status}: ${bytes.toString()}`);
      const value=JSON.parse(bytes).data;if(value.eventIdentity.total!==N||value.eventIdentity.legacyRequiresReplay.length>100||bytes.length>262144)throw Error('Count/page/byte contract failed');
    }
    for(const cohort of [eventsCold,eventsHot]){
      const start=performance.now();
      const result=await manager.request('domain.call',{service:'events',method:'search',args:[{instrumentIds:[instrumentId],from:at,limit:20,includeTotal:true}]});
      cohort.push(performance.now()-start);
      if(result.total!==7000||result.events.length!==20)throw Error('Selective event/count contract failed');
    }
  }
  await heartbeat();assertWriter();if(loadError)throw loadError;
  const filesystem=statfsSync(fixtureRoot),result={fixture:true,fixtureRoot,operationalDatabaseAccessed:false,events:N,payloadBytes:padding,seedMs,hardware:{platform:platform(),release:release(),cpus:cpus().length,memoryBytes:totalmem(),filesystemType:filesystem.type,blockSize:filesystem.bsize},cohorts:{cold:stats(cold),hot:stats(hot),eventsCold:stats(eventsCold),eventsHot:stats(eventsHot)},responseBytes:stats(sizes),writer:{state:manager.state,simulatedAcquisitions,commits,heartbeats,heartbeatLatencyMs:stats(heartbeatMs)},administration:{providerRPCs:administrativeProviderRPCs,writesPermitted:false},queries:{readOnly:true,queryOnly:true,recoveries:manager.queryRecoveries},memory:{maxRssBytes:maxRss},eventLoop:{p95Ms:loop.percentile(95)/1e6,maxMs:loop.max/1e6},queryPlans,acceptance:administrativeProviderRPCs===0&&commits>0&&[cold,hot,eventsCold,eventsHot,heartbeatMs].every(a=>a.length>=50&&stats(a).p95<=2000&&stats(a).max<=5000)};
  writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  writeFileSync(join(output,'samples.json'),JSON.stringify({cold,hot,eventsCold,eventsHot,heartbeatMs},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result));if(!result.acceptance)process.exitCode=1;
}finally{
  running=false;clearTimeout(timer);await work?.catch(()=>{});loop.disable();
  if(server)await new Promise(resolve=>server.close(resolve));await manager.close();
  for(const suffix of ['','-wal','-shm'])rmSync(file+suffix,{force:true});
  if(fixtureRoot!==output)rmSync(fixtureRoot,{recursive:true,force:true});
}
function assertWriter(){if(manager.state!=='ready')throw Error(`Writer failed: ${manager.state}; owner ${originalOwner?.jobId}`);}
