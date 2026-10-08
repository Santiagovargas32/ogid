import path from "node:path";
import { DailyCandleStore } from "./dailyCandleStore.js";
import { normalizeCanonicalCandle } from "./canonicalCandle.js";
import { getInstrumentById } from "./instrumentRegistry.js";
import { expectedDailyGaps } from "./exchangeCalendar.js";
import { stableHash } from "../../utils/stableHash.js";
import { safeUrl } from "../../utils/researchProjection.js";
import { AppError } from "../../utils/error.js";

const invalid = message => new AppError(message, 400, "INVALID_HISTORY_IMPORT");
// CSV acotado, sin fórmulas, rutas de archivos ni solicitudes a URLs aportadas.
function rows(text) {
  if(typeof text!=="string"||Buffer.byteLength(text)>500000)throw invalid("CSV vacío o mayor de 500 kB.");
  const result=[];let row=[],cell="",quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(!cell||quoted)quoted=!quoted;else throw invalid("Comillas CSV inválidas.");}
    else if(!quoted&&(c===","||c==="\n")){row.push(cell.replace(/\r$/, ""));cell="";if(c==="\n"){if(row.some(x=>x.trim()))result.push(row);row=[];}}
    else cell+=c;
    if(result.length>5001)throw invalid("Máximo 5000 velas por importación.");
  }
  if(quoted)throw invalid("CSV con comillas sin cerrar.");
  row.push(cell.replace(/\r$/, ""));if(row.some(x=>x.trim()))result.push(row);
  if(result.length>5001)throw invalid("Máximo 5000 velas por importación.");
  return result;
}

export class HistoricalImportService {
  constructor({ledger,rootDir,now=Date.now}={}) {Object.assign(this,{ledger,rootDir,now});this.stores=new Map();this.inFlight=new Map();}
  datasets() {
    const byId=new Map();
    for(const job of Object.values(this.ledger.state.jobs).filter(j=>j.kind==="csv-import"&&j.status==="completed"))byId.set(job.datasetId,{datasetId:job.datasetId,...job.metadata,lastImportedAt:job.completedAt});
    return [...byId.values()];
  }
  store(datasetId) {
    if(!/^csv-[a-f0-9]{32}$/.test(datasetId)||!this.datasets().some(d=>d.datasetId===datasetId))throw new AppError("Dataset no disponible.",404,"HISTORY_DATASET_NOT_FOUND");
    return this.open(datasetId);
  }
  open(datasetId) {
    if(!this.stores.has(datasetId))this.stores.set(datasetId,new DailyCandleStore({rootDir:path.join(this.rootDir,"imports",datasetId),retentionDays:3650}));
    return this.stores.get(datasetId);
  }
  prepare(input) {
    const {instrumentId,source,sourceUrl,providerSymbol,currency,adjustmentMode,startAt,endAt,csv}=input;
    const instrument=getInstrumentById(instrumentId);
    if(instrument?.verificationStatus!=="verified"||currency!==instrument.currency)throw invalid("Instrumento o moneda incompatibles.");
    if(!/^[a-zA-Z0-9._-]{1,60}$/.test(source||"")||!providerSymbol||providerSymbol.length>80||!safeUrl(sourceUrl)||safeUrl(sourceUrl)!==sourceUrl||!sourceUrl.startsWith("https://"))throw invalid("Declarar fuente, símbolo y URL HTTPS sin credenciales.");
    if(!["splits","none"].includes(adjustmentMode))throw invalid("Declarar el ajuste OHLC; no convertir Adj Close en OHLC ajustado.");
    const start=Date.parse(startAt),end=Date.parse(endAt);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||end>this.now()||end-start>5*365*86400000)throw invalid("Rango inválido; máximo cinco años, sin fechas futuras.");
    if(typeof csv!=="string")throw invalid("CSV requerido.");
    const data=rows(csv.replace(/^\uFEFF/,""));const headers=data.shift()?.map(h=>h.trim().toLowerCase());
    if(!headers||headers.length!==new Set(headers).size||["date","open","high","low","close"].some(h=>!headers.includes(h))||headers.some(h=>!["date","open","high","low","close","volume"].includes(h)))throw invalid("Cabecera requerida: Date,Open,High,Low,Close[,Volume]. Adj Close no es compatible.");
    const bars=new Map();let excluded=0,duplicates=0;
    const number=x=>x!==undefined&&x.trim()!==""&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(x.trim())?Number(x):NaN;
    for(const [index,values] of data.entries()) {
      if(values.length!==headers.length)throw invalid(`Fila ${index+2}: número de columnas inválido.`);
      const row=Object.fromEntries(headers.map((h,i)=>[h,values[i].trim()]));
      if(!/^\d{4}-\d{2}-\d{2}$/.test(row.date)||!Number.isFinite(Date.parse(row.date))||new Date(row.date).toISOString().slice(0,10)!==row.date)throw invalid(`Fila ${index+2}: fecha inválida.`);
      if(row.date<startAt.slice(0,10)||row.date>endAt.slice(0,10)){excluded++;continue;}
      const raw={instrumentId,interval:"1day",date:row.date,open:number(row.open),high:number(row.high),low:number(row.low),close:number(row.close),volume:row.volume?number(row.volume):null,currency};
      const out=normalizeCanonicalCandle(raw,{instrument,source,providerSymbol,adjustmentMode,fetchedAt:new Date(this.now()).toISOString()});
      if(!out.valid||[raw.open,raw.high,raw.low,raw.close].some(x=>x<=0)||raw.volume!=null&&raw.volume<0||Date.parse(out.candle?.closeTime)>this.now())throw invalid(`Fila ${index+2}: OHLCV, sesión o cierre inválidos.`);
      const previous=bars.get(row.date);
      if(previous){if(["open","high","low","close","volume"].some(k=>previous[k]!==out.candle[k]))throw invalid(`Fila ${index+2}: fecha duplicada con valores distintos.`);duplicates++;}
      out.candle.provenance={...out.candle.provenance,sourceUrl,verification:"operator-declared"};
      bars.set(row.date,out.candle);
    }
    const candles=[...bars.values()].sort((a,b)=>a.openTime.localeCompare(b.openTime));if(!candles.length)throw invalid("No hay velas cerradas en el rango.");
    const metadata={instrumentId,source,sourceUrl,providerSymbol,currency,adjustmentMode,admission:"operator-declared; not independently verified"};
    const datasetId=`csv-${stableHash(metadata).slice(0,32)}`;
    return {datasetId,metadata,candles,preview:{datasetId,...metadata,validBars:candles.length,excludedRows:excluded,duplicateRows:duplicates,from:candles[0].openTime,to:candles.at(-1).closeTime,sma200Warmup:candles.length>=200,gaps:expectedDailyGaps(candles,instrument).slice(0,100),warnings:["Imported provenance and adjustment are operator declarations.","Dataset is isolated from Yahoo; no automatic provider stitching or live alerts.","Warmup alone does not certify continuity, freshness or adjustment correctness."]}};
  }
  async import(input) {
    const prepared=this.prepare(input);if(input.dryRun!==false)return {...prepared.preview,dryRun:true};
    if(!input.requestId||input.requestId.length>128)throw invalid("requestId requerido para guardar.");
    const jobId=`csv-import-${stableHash(input.requestId).slice(0,32)}`;
    if(this.inFlight.has(jobId))throw new AppError("Importación en curso; reintentar.",409,"HISTORY_IMPORT_IN_PROGRESS");
    const fingerprint=stableHash({...input,dryRun:false});const prior=this.ledger.state.jobs[jobId];
    if(prior&&prior.fingerprint!==fingerprint)throw new AppError("requestId reutilizado con otros datos.",409,"IDEMPOTENCY_CONFLICT");
    if(prior?.status==="completed")return {...structuredClone(prior.result),replayed:true};
    this.inFlight.set(jobId,true);
    try {
      this.ledger.transact(state=>state.jobs[jobId]={jobId,kind:"csv-import",datasetId:prepared.datasetId,metadata:prepared.metadata,fingerprint,status:"running",createdAt:prior?.createdAt||new Date(this.now()).toISOString()});
      const persistence=await this.open(prepared.datasetId).upsert(prepared.candles,{now:new Date(this.now())});
      const result={...prepared.preview,dryRun:false,jobId,persistence};
      this.ledger.transact(state=>Object.assign(state.jobs[jobId],{status:"completed",completedAt:new Date(this.now()).toISOString(),result}));return result;
    } finally {this.inFlight.delete(jobId);}
  }
  candles({datasetId,instrumentId,adjustmentMode,...query}) {
    const metadata=this.datasets().find(d=>d.datasetId===datasetId);
    if(!metadata||metadata.instrumentId!==instrumentId||metadata.adjustmentMode!==adjustmentMode)throw new AppError("Dataset, instrumento o ajuste incompatibles.",400,"HISTORY_DATASET_MISMATCH");
    return this.store(datasetId).query({instrumentId,adjustmentMode,...query});
  }
}
