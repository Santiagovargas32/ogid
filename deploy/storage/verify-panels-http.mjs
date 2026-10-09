// Offline HTTP exercise against a diagnostic SQLite copy and temporary port.
import path from "node:path";
import {fileURLToPath} from "node:url";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import assert from "node:assert/strict";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const databasePath=path.resolve(process.argv[2] || "");
if(!databasePath.startsWith("/srv/bitcoin/ogid/diagnostics/"))throw new Error("Usar una copia en diagnostics, nunca la base activa.");
const {default:Database}=await import(`${root}/backend/node_modules/better-sqlite3/lib/index.js`);
const {registerInstruments}=await import(`${root}/backend/services/market/instrumentRegistry.js`);
const db=new Database(databasePath,{readonly:true});registerInstruments(db.prepare("SELECT metadata_json FROM instruments").all().map(row=>JSON.parse(row.metadata_json)).filter(i=>i.verificationStatus==="verified"));db.close();
const {StorageManager}=await import(`${root}/backend/storage/StorageManager.js`);
const {createAppServer}=await import(`${root}/backend/server.js`);
const selection=JSON.parse(readFileSync(`${root}/backend/data/market/watchlist-selection.json`,"utf8"));
const snapshot=JSON.parse(readFileSync(process.argv[3],"utf8"));
const context={snapshot,newsFromStorage:true,awareness:snapshot.awareness || {},selectedInstrumentIds:selection.selectedInstrumentIds,intradayMetrics:{}};
const scratch=mkdtempSync(path.join(tmpdir(),"ogid-panel-http-"));
const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath,timeoutMs:30000});
const call=(service,options)=>manager.request("domain.call",{service,method:"getSnapshot",args:[options],context});
const runtime=createAppServer({port:0,storageManager:manager,disableBackgroundRefresh:true,news:{providers:[],rssFeeds:[]},market:{enabled:false,provider:"",fallbackProvider:"",historyPersist:false,historyDir:scratch,initialTickers:[],tickers:[],watchlistSelectionFile:path.join(scratch,"selection.json")},marketConditionsService:{getSnapshot:options=>call("conditions",options)},advancedIntelligenceService:{getSnapshot:options=>call("advanced",options)}});
try{
  await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const paths=[... [15,60,240,1440].map(window=>`/api/market/conditions?windowMin=${window}&countries=US,IL,IR`),"/api/intel/advanced-snapshot?countries=US,IL,IR",`/api/market/candles?instrumentId=${selection.selectedInstrumentIds[0]}&interval=1day&adjusted=splits&limit=240`];
  const work=Promise.all(paths.map(async route=>{const started=performance.now();const response=await fetch(base+route),body=await response.json();assert.equal(response.status,200,`${route}: ${JSON.stringify(body.error)}`);assert.equal(body.ok,true);return {route,status:response.status,ms:Math.round(performance.now()-started),symbols:body.data.symbols?.length};}));
  const started=performance.now();const health=await (await fetch(base+"/api/health")).json();const healthMs=performance.now()-started;
  const results=await work;assert.equal(manager.getStatus().failed,0);assert.equal(manager.state,"ready");
  console.log(JSON.stringify({httpProbe:{results,healthMs,healthStatus:health.data.status,failed:manager.getStatus().failed,rssMiB:process.memoryUsage().rss/1048576}}));
}finally{await runtime.stop();rmSync(scratch,{recursive:true,force:true});}
