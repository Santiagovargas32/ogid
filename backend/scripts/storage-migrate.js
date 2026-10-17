import { RUNTIME_POLICY } from "../config/runtimePolicy.js";
import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupLegacy, verifyLegacyBackup, checkStorageVolume } from "../storage/legacyBackup.js";
import { StorageManager } from "../storage/StorageManager.js";
import { readConfig } from "../server.js";
import { loadResearchSources, } from "../services/research/officialSources.js";
import { listVerifiedInstruments,registerInstruments } from "../services/market/instrumentRegistry.js";

const backendDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
dotenv.config({path:path.join(backendDir,".env"),quiet:true});
const args=process.argv.slice(2);
if(!args.includes("--db") || !args[args.indexOf("--db")+1])throw new Error("Se requiere --db con una candidata nueva; no activa producción.");
const databasePath=path.resolve(args[args.indexOf("--db")+1]);
if(existsSync(databasePath))throw new Error("La candidata debe ser nueva; no sobrescribir una base existente.");
await checkStorageVolume(databasePath);
if(args.some((arg,index)=>!["--db","--check"].includes(arg)&&args[index-1]!=="--db"))throw new Error("Uso: storage:migrate [--db ruta] [--check]");
let active=false;
try{active=execFileSync("systemctl",["--user","is-active","ogid.service"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim()==="active";}catch{/* no active unit */}
if(active&&!args.includes("--check"))throw new Error("Detener ogid.service antes de importar para evitar un corte con datos cambiando.");
if(args.includes("--check")&&(!args.includes("--db")||existsSync(databasePath)||databasePath.startsWith("/srv/bitcoin/ogid/db/")))throw new Error("--check requiere --db con una ruta de candidato nueva, fuera de la base de producción.");
if(databasePath.startsWith("/srv/bitcoin/"))execFileSync("mountpoint",["-q","/srv/bitcoin"]);
const config=readConfig(),researchSources=loadResearchSources(process.env.RESEARCH_SOURCES_FILE);
const resolve=(variable,fallback)=>path.resolve(backendDir,process.env[variable] || fallback);
const selection=path.join(config.market.historyDir,"watchlist-selection.json");
if(existsSync(selection))registerInstruments(JSON.parse(readFileSync(selection,"utf8")).instruments || []);
const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath,timeoutMs:RUNTIME_POLICY.storage.maintenanceTimeoutMs,shutdownTimeoutMs:RUNTIME_POLICY.storage.maintenanceTimeoutMs});
try{
  await manager.start();await manager.request("domain.configure",{instruments:listVerifiedInstruments(),researchSources,rootDir:config.market.historyDir,rss:{rssFeeds:[]},signalPolicy:{}});
  const paths={
    news:resolve("RESEARCH_NEWS_ARCHIVE_FILE","data/intel/research-news.json"),research:resolve("RESEARCH_LEDGER_FILE","data/intel/research-ledger.json"),alerts:resolve("RESEARCH_ALERT_STATE_FILE","data/intel/research-alerts.json"),candlesDir:config.market.historyDir,
    snapshots:{awareness:config.awareness.snapshotPath,ai:config.ai.stateFile,"ai-budget":config.ai.budgetStateFile,signals:resolve("OGID_SIGNAL_HISTORY_FILE","data/intel/signal-history.json"),"rss-canonical":config.news.rssCanonicalStateFile,"provider-quota":resolve("PROVIDER_QUOTA_STATE_FILE","data/provider-quota-state.json"),market:path.join(config.market.historyDir,config.market.snapshotFile)},
    audits:{"awareness-audit":config.awareness.auditPath,"awareness-poll":config.awareness.pollAuditPath}
  };
  const manifest=await backupLegacy(paths,`${databasePath}.legacy-backup`);
  const result=await manager.request("storage.import",{paths});
  const backup=await verifyLegacyBackup(manifest);
  console.log(JSON.stringify({checkOnly:args.includes("--check"),backup,...result},null,2));
  await manager.request("storage.checkpoint");
}finally{await manager.close();}
