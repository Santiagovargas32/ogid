import { getInstrumentById } from "./instrumentRegistry.js";
import { expectedDailyGaps, CALENDAR_VERSION } from "./exchangeCalendar.js";
import { stableHash } from "../../utils/stableHash.js";
import { AppError } from "../../utils/error.js";
const DAY=86400000;
export class HistoricalAcquisitionService {
  constructor({ ledger, marketDataService, candleStore, now=Date.now }={}) { Object.assign(this,{ledger,marketDataService,candleStore,now});this.inFlight=new Map(); }
  create({ requestId, instrumentIds, targetBars=500, startAt=null, endAt=null }) {
    const id=`history-${stableHash(requestId).slice(0,32)}`; const prior=this.ledger.state.jobs[id]; endAt=endAt || prior?.endAt || new Date(this.now()).toISOString();
    const ids=[...new Set(instrumentIds)].sort();if(!ids.length||ids.length>20||ids.some(id=>getInstrumentById(id)?.verificationStatus!=="verified")) throw new AppError("Instrumentos no verificados.",400,"INVALID_INSTRUMENTS");
    if(!Number.isInteger(targetBars)||targetBars<30||targetBars>2500||!Number.isFinite(Date.parse(endAt))||Date.parse(endAt)>this.now()) throw new AppError("Objetivo o ventana inválida.",400,"INVALID_HISTORY_JOB");
    if(startAt&&(!Number.isFinite(Date.parse(startAt))||Date.parse(startAt)>=Date.parse(endAt)||Date.parse(endAt)-Date.parse(startAt)>5*365*DAY))throw new AppError("Rango inválido; máximo cinco años.",400,"INVALID_HISTORY_JOB");
    const fingerprint=stableHash({ids,targetBars,endAt,...(startAt?{startAt}:{})});
    if(prior) { if(prior.fingerprint!==fingerprint) throw new AppError("requestId reutilizado con otra ventana.",409,"IDEMPOTENCY_CONFLICT");return structuredClone(prior); }
    const end=Date.parse(endAt);const start=startAt?Date.parse(startAt):end-Math.min(5*365,Math.ceil(targetBars*1.65)+35)*DAY;const chunks=[];
    for(const instrumentId of ids) for(let cursor=end;cursor>start;cursor-=180*DAY) chunks.push({instrumentId,from:new Date(Math.max(start,cursor-181*DAY)).toISOString(),to:new Date(cursor).toISOString(),attempts:0,status:"pending",nextRetryAt:null});
    const job={jobId:id,fingerprint,targetBars,instrumentIds:ids,startAt:new Date(start).toISOString(),endAt,createdAt:new Date(this.now()).toISOString(),status:"pending",cursor:0,chunks,methodVersion:"history-job-v2",provider:"yahoo",adjustmentMode:"splits",estimatedRequests:chunks.length,warnings:["Yahoo web-delayed; split-adjusted OHLCV is not total return.","No independent reconciliation source configured."]};
    return this.ledger.transact(state=>state.jobs[id]=job);
  }
  get(jobId) { const job=this.ledger.state.jobs[jobId];if(!job||job.kind==="csv-import") throw new AppError("Job inexistente.",404,"HISTORY_JOB_NOT_FOUND");return {...structuredClone(job),coverage:job.instrumentIds.map(id=>this.coverage(id,job.targetBars,job.startAt,job.endAt))}; }
  coverage(instrumentId,targetBars=500,from=null,to=null) {
    const instrument=getInstrumentById(instrumentId);const bars=this.candleStore.query({instrumentId,interval:"1day",adjustmentMode:"splits",from,to,limit:10000});const valid=bars.filter(c=>!c.synthetic&&!['synthetic','fallback','seeded'].includes(c.dataMode)&&[c.open,c.high,c.low,c.close].every(x=>typeof x==="number"&&Number.isFinite(x))&&Date.parse(c.closeTime)<=this.now());
    return {instrumentId,targetBars,validBars:valid.length,goalMet:valid.length>=targetBars,oldest:valid[0]?.openTime||null,newest:valid.at(-1)?.closeTime||null,seriesRevision:stableHash(valid),gaps:instrument?expectedDailyGaps(valid,instrument).slice(0,100):[],calendarVersion:CALENDAR_VERSION,reconciliation:"single-provider-only",totalReturnAvailable:false};
  }
  async run({jobId,maxRequests=1}) {
    if(this.inFlight.has(jobId)) return this.inFlight.get(jobId);
    const task=this.execute(jobId,Math.min(4,Math.max(1,maxRequests)));this.inFlight.set(jobId,task);try{return await task;}finally{this.inFlight.delete(jobId);}
  }
  async execute(jobId,budget) {
    let job=this.get(jobId);let requests=0;
    while(job.cursor<job.chunks.length&&requests<budget) {
      const chunk=job.chunks[job.cursor];if(chunk.nextRetryAt&&Date.parse(chunk.nextRetryAt)>this.now()) break;
      if(chunk.attempts>=3) {this.ledger.transact(state=>{const row=state.jobs[jobId];row.status="blocked";row.chunks[row.cursor].status="blocked";row.chunks[row.cursor].failureCode="HISTORY_ATTEMPTS_EXHAUSTED";});break;}
      const instrument=getInstrumentById(chunk.instrumentId);if(!instrument) throw new AppError("Identidad retirada; no continuar adquisición.",409,"UNRESOLVED_INSTRUMENT");
      // Claim persistido antes de HTTP; reinicio reintenta de forma idempotente la misma ventana.
      this.ledger.transact(state=>{const row=state.jobs[jobId];row.status="running";row.chunks[row.cursor].attempts++;});requests++;
      try {
        const data=await this.marketDataService.fetchYahooBars(instrument.providerSymbols.yahoo,{period:"1y",interval:"1d",from:chunk.from,to:chunk.to,force:true,allowStale:false,providerRetries:0});
        if(data.stale||data.complete===false||data.error) throw Object.assign(new Error("incomplete"),{code:"HISTORY_PARTIAL"});
        this.ledger.transact(state=>{const row=state.jobs[jobId];const current=row.chunks[row.cursor];current.status="complete";current.completedAt=new Date(this.now()).toISOString();current.persistence=data.persistence||null;row.cursor++;row.status=row.cursor===row.chunks.length?"completed":"pending";});
      } catch(error) { this.ledger.transact(state=>{const row=state.jobs[jobId];const current=row.chunks[row.cursor];current.status=current.attempts>=3?"blocked":"retry";current.failureCode=/^[A-Z0-9_]{1,64}$/.test(error.code||"")?error.code:"HISTORY_SOURCE_ERROR";const retryAfter=Number(error.retryAfterMs||error.details?.retryAfterMs)||0;current.nextRetryAt=new Date(this.now()+Math.max(retryAfter,Math.min(3600000,30000*2**current.attempts))).toISOString();row.status=current.status;});break; }
      job=this.get(jobId);
    }
    return {...this.get(jobId),requestsThisRun:requests};
  }
}
