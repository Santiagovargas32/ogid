// Explicit writes/analysis happen exclusively on a candidate copy.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const databasePath=path.resolve(process.argv[2] || "");
if(!process.argv[2] || databasePath.startsWith("/srv/bitcoin/")&&!databasePath.startsWith("/srv/bitcoin/ogid/diagnostics/"))throw new Error("Usar una copia candidata fuera de producción.");
const {default:Database}=await import(`${root}/backend/node_modules/better-sqlite3/lib/index.js`);
const db=new Database(databasePath,{readonly:true,fileMustExist:true});
const instruments=db.prepare("SELECT metadata_json FROM instruments").all().map(row=>JSON.parse(row.metadata_json)).filter(i=>i.verificationStatus==="verified");
const sample=db.prepare("SELECT payload_json FROM articles ORDER BY last_seen_at DESC LIMIT 100").all().map(row=>JSON.parse(row.payload_json));db.close();
const {StorageManager}=await import(`${root}/backend/storage/StorageManager.js`);
const selection=JSON.parse(readFileSync(`${root}/backend/data/market/watchlist-selection.json`,"utf8"));
const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath,timeoutMs:180000});
const run=async(operation,input)=>{const start=performance.now();const result=await manager.request(operation,input);console.log(JSON.stringify({operation,service:input.service,method:input.method,ms:performance.now()-start,result:operation==="domain.configure"?{configured:result.configured}:result}));};
try{
  await manager.start();await run("domain.configure",{instruments,rootDir:"/tmp",rss:{rssFeeds:[]},newsRetentionDays:365});
  await run("domain.call",{service:"news",method:"ingest",args:[sample]});
  await run("domain.call",{service:"scenarios",method:"refresh",args:[{instrumentIds:selection.selectedInstrumentIds || selection.instrumentIds || []}]});
  await run("domain.call",{service:"signals",method:"recordSnapshot",args:[{meta:{lastRefreshAt:new Date().toISOString()},signalCorpus:sample}, {items:sample}]});
  console.log(JSON.stringify({storage:manager.getStatus()}));
}finally{await manager.close();}
