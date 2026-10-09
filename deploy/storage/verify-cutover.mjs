// Smoke/performance check against an imported candidate, never the live database.
import path from "node:path";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const databasePath=path.resolve(process.argv[2] || "");
if(!process.argv[2] || databasePath.startsWith("/srv/bitcoin/ogid/db/"))throw new Error("Indicar una base candidata fuera de la ruta de producción.");
const {default:Database}=await import(`${root}/backend/node_modules/better-sqlite3/lib/index.js`);
const db=new Database(databasePath,{readonly:true});
const instruments=db.prepare("SELECT metadata_json FROM instruments").all().map(r=>JSON.parse(r.metadata_json)).filter(i=>i.verificationStatus==="verified");
const counts=Object.fromEntries(["articles","events","candles","quote_observations"].map(table=>[table,db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));db.close();
process.env.NODE_ENV="test";process.env.STORAGE_REQUIRE_IMPORT="1";process.env.DISABLE_BACKGROUND_REFRESH="1";
const {registerInstruments}=await import(`${root}/backend/services/market/instrumentRegistry.js`);registerInstruments(instruments);
const {createAppServer}=await import(`${root}/backend/server.js`),dir=mkdtempSync(path.join(tmpdir(),"ogid-cutover-http-"));
const runtime=createAppServer({host:"127.0.0.1",port:0,disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath,timeoutMs:60000},news:{providers:[],rssFeeds:[]},market:{enabled:false,historyPersist:false,initialTickers:[],tickers:[],historyDir:dir},awareness:{mode:"off"},ai:{mode:"off",provider:"none"}});
try{
  await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const timed=async(endpoint)=>{const start=performance.now(),response=await fetch(base+endpoint,{signal:AbortSignal.timeout(60000)}),body=await response.json();if(!response.ok)throw new Error(`${endpoint}: ${response.status} ${body.error?.code}`);return {ms:performance.now()-start,body};};
  const start=performance.now(),query=timed("/api/news/search?limit=20");
  const health=[];for(let i=0;i<30;i++){health.push((await timed("/api/health")).ms);await new Promise(resolve=>setTimeout(resolve,20));}
  const news=await query,events=await timed("/api/research/event-impact?limit=20"),candles=instruments.length?await timed(`/api/market/candles?instrumentId=${encodeURIComponent(instruments[0].instrumentId)}&limit=100`):null;
  health.sort((a,b)=>a-b);
  console.log(JSON.stringify({counts,elapsedMs:performance.now()-start,newsMs:news.ms,newsTotal:news.body.data.total,eventsMs:events.ms,candlesMs:candles?.ms,healthP95Ms:health[Math.floor(health.length*.95)],healthMaxMs:health.at(-1),processRssMiB:Math.round(process.memoryUsage().rss/1048576),storage:runtime.storageManager.getStatus()},null,2));
}finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
