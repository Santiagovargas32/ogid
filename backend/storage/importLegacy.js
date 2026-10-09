import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { readMeta, writeMeta, SqlResearchStore, SqlCandleStore, instrumentRow } from "./sqlRepositories.js";
import { listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { AppError } from "../utils/error.js";
const checksum=text=>createHash("sha256").update(text).digest("hex");
function files(directory){return existsSync(directory)?readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(directory,e.name)):e.isFile()&&e.name.endsWith(".jsonl")?[path.join(directory,e.name)]:[]):[];}

// Offline cutover only. Original files are read, never modified or removed.
export function importLegacy(db,runtime,{paths={}}={}){
  if(!runtime.services)throw new AppError("Configurar repositorios antes de importar.",503,"STORAGE_NOT_READY");
  if(readMeta(db,"import.ready",false))return {replayed:true,manifests:db.prepare("SELECT source_kind,status,counts_json FROM import_manifests ORDER BY import_id").all()};
  const {news,alerts}=runtime.services,store=new SqlResearchStore(db),results=[];
  function importFile(kind,file,apply){
    if(file&&!existsSync(file)&&["news","research"].includes(kind))throw new AppError("Falta un archivo principal de la migración; revisar las rutas y conservar los originales.",503,"STORAGE_IMPORT_SOURCE_MISSING");
    if(!file||!existsSync(file)){results.push({kind,status:"absent"});return;}
    const text=readFileSync(file,"utf8"),digest=checksum(text),id=`legacy:${checksum(file).slice(0,32)}`;
    const previous=db.prepare("SELECT * FROM import_manifests WHERE import_id=?").get(id);
    if(previous){if(previous.source_checksum!==digest)throw new AppError("El origen cambió después de una importación parcial; restaurar el candidato o empezar con otra base.",409,"STORAGE_IMPORT_SOURCE_CHANGED");results.push({kind,status:"replayed",...JSON.parse(previous.counts_json)});return;}
    const counts=db.transaction(()=>{
      const value=apply(text);
      const now=new Date().toISOString();db.prepare("INSERT INTO import_manifests VALUES(?,?,?,?,?,?,?,?)").run(id,kind,digest,"legacy-verified-v1","complete",now,now,JSON.stringify(value));return value;
    }).immediate();results.push({kind,status:"complete",...counts});
  }
  importFile("news",paths.news,text=>{
    const data=JSON.parse(text);if(data.schemaVersion!=="news-archive-v1"||!Array.isArray(data.articles))throw new AppError("Archivo de noticias inválido.",503,"ARCHIVE_RECOVERY_FAILED");
    for(const article of data.articles) {if(!article.id||!article.title||!article.receivedAt||!article.archiveLastSeenAt)throw new AppError("Artículo inválido; conservar original.",503,"ARCHIVE_RECOVERY_FAILED");news.save(article);}
    for(const row of data.history || [])news.history.set(row.bucket,row);
    for(const key of ["revision","startedAt","lastIngestAt","capacityPrunedAt"])if(data[key]!==undefined)news[key]=data[key];news.persist();return {articles:data.articles.length,contexts:(data.history || []).length};
  });
  importFile("research",paths.research,text=>{
    const data=JSON.parse(text);if(data.schemaVersion!=="research-ledger-v1"||!Number.isInteger(data.revision))throw new AppError("Ledger inválido.",503,"RESEARCH_RECOVERY_FAILED");
    const counts={};store.transact(state=>{for(const collection of ["events","jobs","holdings","companyFacts","sourceStates","forecasts"]){if(!data[collection]||Array.isArray(data[collection]))throw new AppError("Tabla inválida.",503,"RESEARCH_RECOVERY_FAILED");for(const [id,row]of Object.entries(data[collection]))state[collection][id]=row;counts[collection]=Object.keys(data[collection]).length;}});writeMeta(db,"research.revision",data.revision);return counts;
  });
  importFile("alerts",paths.alerts,text=>{
    const data=JSON.parse(text);if(!["material-alerts-v1","material-alerts-v2"].includes(data.schemaVersion))throw new AppError("Alertas inválidas.",503,"ALERT_RECOVERY_FAILED");
    alerts.observed=new Map(data.observed || []);alerts.acknowledged=new Map(data.acknowledged || []);if(data.research)alerts.research=data.research;alerts.persist();return {observed:alerts.observed.size,acknowledged:alerts.acknowledged.size,changes:alerts.research.changes.length};
  });
  for(const [kind,file]of Object.entries(paths.snapshots || {}))importFile(kind,file,text=>{const data=JSON.parse(text);runtime.save(kind,data);return {snapshots:1};});
  for(const [kind,file]of Object.entries(paths.audits || {}))importFile(kind,file,text=>{
    let rows=0;for(const line of text.split(/\r?\n/)){if(!line.trim())continue;const row=JSON.parse(line);runtime.save(kind,{...row,recordedAt:row.recordedAt || row.timestamp || new Date().toISOString()});rows++;}return {rows};
  });
  for(const file of files(paths.candlesDir || "")){
    const relative=path.relative(paths.candlesDir,file),datasetId=relative.startsWith(`imports${path.sep}`)?relative.split(path.sep)[1]:"provider-yahoo";
    if(!relative.includes(`${path.sep}candles${path.sep}`)&&!relative.startsWith(`candles${path.sep}`))continue;
    importFile(`candles:${relative}`,file,text=>{
      const candles=text.split(/\r?\n/).filter(x=>x.trim()).map(line=>JSON.parse(line));
      if(candles.some(c=>c.schemaVersion!==1))throw new AppError("Formato de vela desconocido.",503,"STORAGE_IMPORT_CANDLE_SCHEMA");
      const candleStore=new SqlCandleStore(db,{datasetId});const persistence=candleStore.upsert(candles,{importing:true});return {rows:candles.length,...persistence};
    });
  }
  const historyDirectory=path.join(paths.candlesDir || "", "history");
  for(const file of files(historyDirectory))importFile(`quotes:${path.basename(file)}`,file,text=>{
    const symbol=path.basename(file,".jsonl"),instrument=listVerifiedInstruments().find(i=>String(i.canonicalSymbol || "").replace(/[^A-Za-z0-9._-]/g,"_")===symbol);
    if(!instrument)throw new AppError("Instrumento de histórico de cotizaciones no resuelto; revisar el registro antes del corte.",503,"STORAGE_IMPORT_QUOTE_IDENTITY");
    instrumentRow(db,instrument.instrumentId);let rows=0;
    for(const line of text.split(/\r?\n/).filter(x=>x.trim())){const point=JSON.parse(line);if(!point.timestamp||!Number.isFinite(Number(point.price)))throw new AppError("Cotización histórica inválida.",503,"STORAGE_IMPORT_QUOTE_SCHEMA");
      const id=`quote-${checksum(JSON.stringify([instrument.instrumentId,point.timestamp,point.price,point.source])).slice(0,40)}`;
      db.prepare("INSERT OR IGNORE INTO quote_observations VALUES(?,?,?,?,?,?,?,?)").run(id,instrument.instrumentId,point.timestamp,point.timestamp,point.source || "legacy-provider-observed",point.dataMode || "legacy-observed",Number(point.price),JSON.stringify(point));rows++;}
    return {rows};
  });
  const integrity=db.pragma("integrity_check"),foreignKeys=db.pragma("foreign_key_check");
  if(integrity.length!==1||integrity[0].integrity_check!=="ok"||foreignKeys.length)throw new AppError("Validación de migración fallida.",503,"STORAGE_IMPORT_VERIFY_FAILED");
  writeMeta(db,"import.ready",true);writeMeta(db,"import.result",results);return {replayed:false,results,integrity,foreignKeys};
}
