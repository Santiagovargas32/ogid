// Offline validation using an explicit diagnostic copy of the current database.
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const databasePath=path.resolve(process.argv[2] || "");
if(!databasePath.startsWith("/srv/bitcoin/ogid/diagnostics/") && !databasePath.startsWith("/tmp/ogid-news-")) throw new Error("Usar una copia diagnóstica, nunca la base activa.");
const {default:Database}=await import(`${root}/backend/node_modules/better-sqlite3/lib/index.js`);
const {StorageManager}=await import(`${root}/backend/storage/StorageManager.js`);
const db=new Database(databasePath,{readonly:true});
const instruments=db.prepare("SELECT metadata_json FROM instruments").all().map(row=>JSON.parse(row.metadata_json)).filter(instrument=>instrument.verificationStatus==="verified");
const initialCount=db.prepare("SELECT count(*) AS n FROM articles").get().n;
db.close();
const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath,timeoutMs:30000});
try{
  await manager.start();
  await manager.request("domain.configure",{instruments,rootDir:"/tmp",newsRetentionDays:365,awarenessMode:"visible",news:{providers:[],analyzeLimit:3000,displayLimit:40,candidateWindowHours:36,dayTimeZone:"Europe/Madrid",watchlistCountries:["US","IL","IR","RU","CN","UA","TW","KP","KR","IN","PK","TR","SY","IQ","YE","SD","VE","CO"]},rss:{rssFeeds:[]}});
  for(let i=0;i<2;i++){
    const start=performance.now();
    const result=await manager.request("domain.call",{service:"news",method:"getProjection",args:[{}]});
    assert.ok(result.meta.riskUsesAllDailyCandidates);
    assert.ok(result.news.every(article=>article.publishedAt>=result.meta.dayStart));
    assert.ok(result.news.length<=40);
    console.log(JSON.stringify({iteration:i,ms:Math.round(performance.now()-start),initialCount,corpus:result.meta,countsByCountry:Object.fromEntries(Object.entries(result.riskResult.countries).filter(([,country])=>country.metrics.newsVolume).map(([iso,country])=>[iso,country.metrics.newsVolume])),responseMiB:Buffer.byteLength(JSON.stringify(result))/1048576}));
  }
  assert.equal(manager.getStatus().failed,0);
}finally{await manager.close();}
