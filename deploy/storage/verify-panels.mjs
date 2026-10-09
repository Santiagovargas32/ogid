// Reproduce panel calculations on an explicit diagnostic copy, never the live DB.
import path from "node:path";
import {fileURLToPath} from "node:url";
import {readFileSync} from "node:fs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const databasePath=path.resolve(process.argv[2] || "");
if(!databasePath.startsWith("/srv/bitcoin/ogid/diagnostics/")&&!databasePath.startsWith("/tmp/ogid-panel-"))throw new Error("Usar una copia en diagnostics, nunca la base activa.");
const {default:Database}=await import(`${root}/backend/node_modules/better-sqlite3/lib/index.js`);
const {BusinessRuntime}=await import(`${root}/backend/storage/businessRuntime.js`);
const {cacheStatements}=await import(`${root}/backend/storage/statementCache.js`);
const db=new Database(databasePath);db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");db.pragma("foreign_keys=ON");cacheStatements(db);
const runtime=new BusinessRuntime(db,()=>{throw new Error("Offline probe must not call providers");});
const instruments=db.prepare("SELECT metadata_json FROM instruments").all().map(r=>JSON.parse(r.metadata_json)).filter(i=>i.verificationStatus==="verified");
const selection=JSON.parse(readFileSync(`${root}/backend/data/market/watchlist-selection.json`,"utf8"));
const snapshot=JSON.parse(readFileSync(process.argv[3],"utf8"));
const context={snapshot,signalCorpus:snapshot.news || [],marketSignalCorpus:snapshot.news || [],awareness:snapshot.awareness || {},selectedInstrumentIds:selection.selectedInstrumentIds,intradayMetrics:{}};
try{
  const start=performance.now();runtime.configure({instruments,rootDir:"/tmp",rss:{rssFeeds:[]},newsRetentionDays:365,intradayEnabled:true});console.log(JSON.stringify({configureMs:performance.now()-start,selected:context.selectedInstrumentIds.length}));
  for(const [service,args] of [["conditions",{windowMin:240}],["conditions",{windowMin:240}],["advanced",{stored:true,countries:[],windowHours:24}]]){
    const start=performance.now();try{const result=await runtime.call({service,method:"getSnapshot",args:[args],context});console.log(JSON.stringify({service,ms:performance.now()-start,generatedAt:result.generatedAt,quality:result.quality}));}catch(error){console.log(JSON.stringify({service,ms:performance.now()-start,code:error.code,message:error.message,stack:error.stack}));}
  }
}finally{runtime.close();db.close();}
