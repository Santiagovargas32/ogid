// Yahoo HTTP acquisition and SQL/analysis load on an explicit diagnostic copy.
import path from "node:path";
import {fileURLToPath} from "node:url";
import {readFileSync,mkdtempSync,rmSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import assert from "node:assert/strict";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const databasePath=realpathSync(process.argv[2] || "");
if(!databasePath.startsWith("/srv/bitcoin/ogid/diagnostics/"))throw new Error("Usar una copia consistente en diagnostics, nunca la base activa.");
const {default:dotenv}=await import(`${root}/backend/node_modules/dotenv/lib/main.js`);
dotenv.config({path:`${root}/backend/.env`});
process.env.NODE_ENV="test";process.env.LOG_LEVEL="warn";
const nativeFetch=globalThis.fetch;
globalThis.fetch=(target,options)=>{
  const url=new URL(target instanceof Request?target.url:String(target));
  if(!["127.0.0.1","localhost","::1"].includes(url.hostname) && !url.hostname.endsWith(".yahoo.com"))throw new Error("El ensayo sólo permite localhost y Yahoo.");
  return nativeFetch(target,options);
};
const {default:Database}=await import(`${root}/backend/node_modules/better-sqlite3/lib/index.js`);
const {registerInstruments,getInstrumentByProviderSymbol}=await import(`${root}/backend/services/market/instrumentRegistry.js`);
const db=new Database(databasePath,{readonly:true,fileMustExist:true});
const instruments=db.prepare("SELECT metadata_json FROM instruments").all().map(row=>JSON.parse(row.metadata_json)).filter(i=>i.verificationStatus==="verified");
const initialArticles=db.prepare("SELECT count(*) AS n FROM articles").get().n;
db.close();registerInstruments(instruments);
const {StorageManager}=await import(`${root}/backend/storage/StorageManager.js`);
const {createAppServer}=await import(`${root}/backend/server.js`);
const scratch=mkdtempSync(path.join(tmpdir(),"ogid-yahoo-load-"));
const selection=JSON.parse(readFileSync(`${root}/backend/data/market/watchlist-selection.json`,"utf8"));
const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath,timeoutMs:30000});
const runtime=createAppServer({port:0,host:"127.0.0.1",storageManager:manager,disableBackgroundRefresh:true,market:{provider:"yahoo",enabled:true,dailyCandles:{enabled:true},historyDir:scratch,historyPersist:false,initialTickers:selection.selectedInstrumentIds}});
let sample,maxCpu=0,lastSample=0;
try{
  await runtime.start();
  sample=setInterval(()=>{
    const status=manager.getStatus();maxCpu=Math.max(maxCpu,status.queue.cpuInFlight);
    if(Date.now()-lastSample>5000){lastSample=Date.now();console.log(JSON.stringify({progress:{state:status.state,queue:status.queue,active:status.activeCommands,projection:status.worker?.news?.projection,lastCompleted:status.worker?.lastCompletedCommand}}));}
  },20);
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const measure=async route=>{
    const started=performance.now(),response=await fetch(base+route),body=await response.json();
    assert.equal(response.status,200,`${route}: ${JSON.stringify(body.error)}`);
    assert.equal(body.ok,true);
    return {route,status:response.status,ms:Math.round(performance.now()-started),...(body.data.candles?{candles:body.data.candles.length,source:body.data.source,persistence:body.data.persistence}: {})};
  };
  const projectionStart=performance.now();
  const projection=manager.request("domain.call",{service:"news",method:"getProjection",args:[{countries:runtime.config.watchlistCountries,tickers:runtime.config.market.tickers}],context:{snapshot:runtime.orchestrator.stateManager.getAnalysisSnapshot(),selectedInstrumentIds:runtime.app.locals.marketWatchlistService.selectedInstrumentIds}}, {timeoutMs:90000}).then(result=>({ms:Math.round(performance.now()-projectionStart),news:result.news.length,dailyCandidates:result.meta.dailyCandidateCount}));
  const routes=[...[15,60,240,1440].map(window=>`/api/market/conditions?windowMin=${window}&countries=US,IL,IR`),"/api/intel/advanced-snapshot?countries=US,IL,IR"];
  const panels=Promise.all(routes.map(measure));
  const charts=Promise.all(["NVDA","MSFT"].map(symbol=>{
    const instrument=getInstrumentByProviderSymbol("yahoo",symbol);assert.ok(instrument,`${symbol} must be verified in the copy`);
    return measure(`/api/market/candles?instrumentId=${instrument.instrumentId}&interval=1day&source=yahoo&adjusted=splits&limit=240`);
  }));
  const health=await measure("/api/health");
  const [chartResults,panelResults,newsProjection]=await Promise.all([charts,panels,projection]);
  await runtime.app.locals.marketDataService.store.flushPersistence();
  assert.equal(manager.getStatus().failed,0);assert.equal(manager.state,"ready");assert.equal(maxCpu,1);
  assert.ok(chartResults.every(result=>result.candles>0));
  const copy=new Database(databasePath,{readonly:true});
  const persisted=copy.prepare("SELECT kind,count(*) AS n FROM analysis_runs WHERE kind='indicators.calculate' GROUP BY kind").all();copy.close();
  console.log(JSON.stringify({diagnostic:"yahoo-direct-and-sql-load",initialArticles,instruments:instruments.length,health,charts:chartResults,panels:panelResults,newsProjection,maxCpu,worker:manager.state,failed:manager.getStatus().failed,archive:runtime.app.locals.marketDataService.store.getPersistenceStatus(),persisted}));
}finally{
  clearInterval(sample);
  if(runtime.server.listening)await runtime.stop();else await manager.close();
  rmSync(scratch,{recursive:true,force:true});
}
