// Deterministic local fixture; never opens the configured/production database.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
const root=resolve(process.env.OGID_BENCH_ROOT || new URL('..',import.meta.url).pathname);
const {StorageManager}=await import(pathToFileURL(join(root,'storage/StorageManager.js')));
const {default:Database}=await import(pathToFileURL(join(root,'node_modules/better-sqlite3/lib/index.js')));
const dir=mkdtempSync(join(tmpdir(),'ogid-benchmark-')),databasePath=join(dir,'fixture.sqlite');
const durationMs=Number(process.env.OGID_SOAK_MS || 0),count=Number(process.env.OGID_BENCH_ARTICLES || 7200);
const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath,shutdownTimeoutMs:200000});
const lag=monitorEventLoopDelay({resolution:20});lag.enable();
const samples={reads:[],status:[],ingest:[]},memory=[],wal=[],errors=[];let rounds=0,seq=count;
const historicalCount=Number(process.env.OGID_BENCH_HISTORY || 7200),queuePeak={pending:0,bytes:0,analysisPending:0};
const at=Date.now();
function articles(start,n){return Array.from({length:n},(_,i)=>({id:`fixture-${start+i}`,url:`https://fixture.invalid/${start+i}`,title:`Russia military conflict report ${start+i}`,publishedAt:new Date(at-((start+i)%48)*3600000).toISOString(),provider:'rss',sourceId:`fixture-${i%24}`,sourceName:`Fixture ${i%24}`,usagePolicy:'headline-only-link-out'}));}
const call=()=>manager.request('domain.call',{service:'advanced',method:'getSnapshot',args:[{countries:['RU'],windowHours:24}],context:{newsFromStorage:true,snapshot:{},awareness:{mode:'off'}}},{timeoutMs:180000});
const measure=async(key,fn)=>{const start=performance.now();const value=await fn();samples[key].push(performance.now()-start);return value;};
const percentiles=values=>{const a=[...values].sort((a,b)=>a-b);return {n:a.length,p50:a[Math.floor(a.length*.5)]??null,p95:a[Math.min(a.length-1,Math.floor(a.length*.95))]??null,p99:a[Math.min(a.length-1,Math.floor(a.length*.99))]??null,max:a.at(-1)??null};};
try {
 await manager.start();await manager.request('domain.configure',{rootDir:dir,news:{analyzeLimit:3000,displayLimit:40,watchlistCountries:['RU']},rss:{rssFeeds:[]}});
 for(let i=0;i<count;i+=100)await measure('ingest',()=>manager.request('domain.call',{service:'news',method:'ingest',args:[articles(i,Math.min(100,count-i))]}));
 for(let i=0;i<historicalCount;i+=100){const rows=articles(count+i,Math.min(100,historicalCount-i)).map((a,j)=>({...a,id:`history-${i+j}`,url:`https://fixture.invalid/history-${i+j}`,publishedAt:new Date(at-(49+(i+j)%(365*24-49))*3600000).toISOString()}));await measure('ingest',()=>manager.request('domain.call',{service:'news',method:'ingest',args:[rows]}));}
 for(let hour=30*24;hour>=0;hour--){const timestamp=new Date(at-hour*3600000).toISOString();await manager.request('domain.call',{service:'signals',method:'recordSnapshot',args:[{meta:{lastRefreshAt:timestamp},signalCorpus:[{id:`hour-${hour}`,title:'Russia conflict',publishedAt:timestamp,topicTags:['conflict'],countryMentions:['RU']}]}]});}
 const firstStart=performance.now();let first=await call();const firstMs=performance.now()-firstStart;
 const waitStart=Date.now();while(first.lifecycle&&!first.generatedAt){if(first.lifecycle.status==='failed')throw Error(first.lifecycle.errorCode);if(Date.now()-waitStart>180000)throw Error('benchmark wait deadline');await new Promise(r=>setTimeout(r,100));first=await call();}
 const readyMs=Date.now()-waitStart;
 const before=manager.getStatus();
 const begin=Date.now();
 const sampling=setInterval(()=>{const s=manager.getStatus();queuePeak.pending=Math.max(queuePeak.pending,s.queue.pending);queuePeak.bytes=Math.max(queuePeak.bytes,s.queue.bytes);queuePeak.analysisPending=Math.max(queuePeak.analysisPending,s.analysis?.queue.pending || 0);},50);sampling.unref();
 do {
  try {
   await Promise.all([measure('ingest',()=>manager.request('domain.call',{service:'news',method:'ingest',args:[articles(seq++,1)]})),
    ...Array.from({length:20},()=>measure('reads',call)),measure('status',()=>manager.request('storage.status'))]);
   const status=manager.getStatus();memory.push(process.memoryUsage().rss);wal.push(status.walBytes || 0);rounds++;
   if(rounds%10===0)process.stdout.write(JSON.stringify({rounds,elapsedMs:Date.now()-begin,readP95:percentiles(samples.reads).p95,rss:memory.at(-1),wal:wal.at(-1)})+'\n');
  }catch(error){errors.push({code:error.code || error.message,at:new Date().toISOString()});}
  if(durationMs)await new Promise(r=>setTimeout(r,1000));
 }while((Date.now()-begin<durationMs || rounds<3) && errors.length<10);
 clearInterval(sampling);
 await manager.advancedCoordinator?.close();
 const sql=new Database(databasePath,{readonly:true});
 const counts=Object.fromEntries(['articles','article_revisions','analysis_runs','pipeline_runs'].map(t=>[t,sql.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
 const jobs=sql.prepare("SELECT name FROM sqlite_master WHERE name='analysis_jobs'").get()?sql.prepare('SELECT status,count(*) AS n,sum(attempts) AS attempts FROM analysis_jobs GROUP BY status').all():null;
 const duplicatePublications=sql.prepare("SELECT name FROM sqlite_master WHERE name='analysis_latest'").get()?sql.prepare('SELECT count(*) AS n FROM (SELECT calculation_key,count(*) AS n FROM analysis_jobs GROUP BY calculation_key HAVING n>1)').get().n:null;
 sql.close();
 const verify=await manager.request('storage.verify');const after=manager.getStatus();
 const output={node:process.version,root,fixture:{articles:count,historicalArticles:historicalCount,sources:24,hours:48,historicalHours:Math.min(365*24,49+historicalCount),signalHistoryDays:30},durationMs:Date.now()-begin,rounds,firstMs,readyMs,corpus:first.corpus,newsCoverage:first.newsCoverage,
  latency:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,percentiles(v)])),memory:{rssMin:Math.min(...memory),rssMax:Math.max(...memory),firstQuarterMedian:percentiles(memory.slice(0,Math.max(1,Math.floor(memory.length/4)))).p50,lastQuarterMedian:percentiles(memory.slice(Math.floor(memory.length*3/4))).p50},eventLoop:{p95Ms:lag.percentile(95)/1e6,maxMs:lag.max/1e6},wal:{initial:wal[0],last:wal.at(-1),max:Math.max(...wal)},counts,jobs,duplicatePublications,writerCommands:after.completed-before.completed,queue:after.queue,queuePeak,errors,verify};
 const destination=process.env.OGID_BENCH_OUTPUT || join(dir,'result.json');writeFileSync(destination,JSON.stringify(output,null,2));process.stdout.write(JSON.stringify({result:destination,firstMs,readyMs,reads:output.latency.reads,errors:errors.length})+'\n');
}finally{lag.disable();await manager.close();rmSync(dir,{recursive:true,force:true});}
