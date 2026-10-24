import { getInstrumentById } from "./instrumentRegistry.js";
import { expectedDailyGaps, CALENDAR_VERSION,tradingDay,addDate } from "./exchangeCalendar.js";
import { stableHash } from "../../utils/stableHash.js";
import { AppError } from "../../utils/error.js";
import {randomUUID} from 'node:crypto';
import {intradayWindowCoverage} from './coverageWindows.js';
import {checkOperation} from '../shared/operationContext.js';
import {assessClosedCandle} from './candleValidation.js';
const DAY=86400000;
export class HistoricalAcquisitionService {
  constructor({ ledger, marketDataService, candleStore, now=Date.now }={}) { Object.assign(this,{ledger,marketDataService,candleStore,now});this.inFlight=new Map(); }
  create({ requestId, instrumentIds, targetBars=500, startAt=null, endAt=null,interval='1day',kind='history',adjustmentMode='splits',sessionType='regular' }) {
    const id=`history-${stableHash(requestId).slice(0,32)}`; const prior=this.ledger.state.jobs[id]; endAt=endAt || prior?.endAt || new Date(this.now()).toISOString();
    const ids=[...new Set(instrumentIds)].sort();if(!ids.length||ids.length>20||ids.some(id=>getInstrumentById(id)?.verificationStatus!=="verified")) throw new AppError("Instrumentos no verificados.",400,"INVALID_INSTRUMENTS");
    if(!Number.isInteger(targetBars)||targetBars<30||targetBars>2500||!Number.isFinite(Date.parse(endAt))||Date.parse(endAt)>this.now()) throw new AppError("Objetivo o ventana inválida.",400,"INVALID_HISTORY_JOB");
    if(startAt&&(!Number.isFinite(Date.parse(startAt))||Date.parse(startAt)>=Date.parse(endAt)||Date.parse(endAt)-Date.parse(startAt)>5*365*DAY))throw new AppError("Rango inválido; máximo cinco años.",400,"INVALID_HISTORY_JOB");
    if(!['1day','5min','15min','30min','1h'].includes(interval)||adjustmentMode!=='splits'||sessionType!=='regular')throw new AppError('Contrato histórico incompatible.',400,'INVALID_HISTORY_JOB');
    const fingerprint=stableHash({ids,targetBars,endAt,...(startAt?{startAt}:{}),...(interval!=='1day'?{interval,kind,adjustmentMode,sessionType}:{})});
    if(prior) { if(prior.fingerprint!==fingerprint) throw new AppError("requestId reutilizado con otra ventana.",409,"IDEMPOTENCY_CONFLICT");return structuredClone(prior); }
    const end=Date.parse(endAt);const start=startAt?Date.parse(startAt):end-Math.min(5*365,Math.ceil(targetBars*1.65)+35)*DAY;const chunks=[];
    if(interval!=='1day'&&end-start>30*DAY)throw new AppError('Máximo treinta días por rango intradía.',400,'INVALID_HISTORY_JOB');
    if(interval==='1day')for(const instrumentId of ids)for(let cursor=end;cursor>start;cursor-=180*DAY)chunks.push({instrumentId,from:new Date(Math.max(start,cursor-181*DAY)).toISOString(),to:new Date(cursor).toISOString(),attempts:0,status:'pending',nextRetryAt:null});
    else for(const instrumentId of ids)for(let cursor=start;cursor<end;cursor+=DAY)chunks.push({instrumentId,from:new Date(cursor).toISOString(),to:new Date(Math.min(end,cursor+DAY)).toISOString(),attempts:0,status:'pending',nextRetryAt:null});
    const job={jobId:id,fingerprint,targetBars,instrumentIds:ids,startAt:new Date(start).toISOString(),endAt,createdAt:new Date(this.now()).toISOString(),status:"pending",cursor:0,chunks,methodVersion:"history-job-v2",provider:"yahoo",adjustmentMode:"splits",estimatedRequests:chunks.length,warnings:["Yahoo web-delayed; split-adjusted OHLCV is not total return.","No independent reconciliation source configured."]};
    Object.assign(job,{interval,kind,adjustmentMode,sessionType,calendarVersion:CALENDAR_VERSION});
    return this.ledger.transact(state=>state.jobs[id]=job);
  }
  coverageKey({instrumentId,interval='5min',adjustmentMode='splits'}){return `coverage-${stableHash([instrumentId,interval,adjustmentMode,'regular',CALENDAR_VERSION]).slice(0,32)}`;}
  coverageState(input){return this.ledger.state.jobs[this.coverageKey(input)]||{instrumentId:input.instrumentId,coverageThrough:null,pendingJobId:null,status:'unknown',missingBars:null};}
  coverageStates(inputs=[]){return inputs.slice(0,100).map(input=>({...this.coverageState(input),instrumentId:input.instrumentId}));}
  ensureCatchup({instrumentId,interval,adjustmentMode='splits',from,to}){
    const input={instrumentId,interval,adjustmentMode},previous=this.coverageState(input),pending=previous.pendingJobId&&this.ledger.state.jobs[previous.pendingJobId];
    if(pending&&['pending','running','retry'].includes(pending.status))return structuredClone(pending);
    if(previous.coverageThrough&&Date.parse(previous.coverageThrough)>=Date.parse(to))return {status:'completed',jobId:null,coverageThrough:previous.coverageThrough};
    const job=this.create({requestId:`catchup-${stableHash([input,from,to,CALENDAR_VERSION])}`,instrumentIds:[instrumentId],startAt:from,endAt:to,interval,adjustmentMode,kind:'intraday-catchup'});
    this.ledger.transact(state=>state.jobs[this.coverageKey(input)]={...previous,jobId:this.coverageKey(input),kind:'market-coverage',instrumentIds:[instrumentId],...input,createdAt:previous.createdAt||new Date(this.now()).toISOString(),pendingJobId:job.jobId,status:job.status,...(previous.coverageThrough&&Date.parse(previous.coverageThrough)<Date.parse(from)-900000?{unrecoverableDebt:{from:previous.coverageThrough,to:from,reason:'outside-local-retention-window'}}:{})});
    return job;
  }
  cancel({jobId}){return this.ledger.transact(state=>{const job=state.jobs[jobId];if(job&&!['completed','cancelled'].includes(job.status)){job.status='cancelled';job.cancelledAt=new Date(this.now()).toISOString();}return {cancelled:job?.status==='cancelled'};});}
  get(jobId) { const job=this.ledger.state.jobs[jobId];if(!job||job.kind==="csv-import") throw new AppError("Job inexistente.",404,"HISTORY_JOB_NOT_FOUND");return {...structuredClone(job),executionCompleted:job.status==='completed',coverage:job.interval&&job.interval!=='1day'?{continuity:job.status==='completed'?'continuous':'pending',coverageThrough:job.status==='completed'?job.endAt:null}:job.instrumentIds.map(id=>this.coverage(id,job.targetBars,job.startAt,job.endAt))}; }
  repairPlan({instrumentId}){
    const instrument=getInstrumentById(instrumentId);if(!instrument)return null;
    const coverage=this.coverage(instrumentId),dates=coverage.gaps.filter(date=>!tradingDay(instrument,date).partial&&(!instrument.listingDate||date>=instrument.listingDate));
    if(!dates.length)return {instrumentId,repair:null,reason:coverage.gaps.length?'unverified-historical-calendar':'no-known-gap'};
    const date=dates[0],from=`${addDate(date,-1)}T00:00:00.000Z`,to=new Date(Math.min(this.now(),Date.parse(`${addDate(date,2)}T00:00:00Z`))).toISOString();
    return {instrumentId,repair:{requestId:`daily-gap-${stableHash([instrumentId,date,CALENDAR_VERSION])}`,instrumentIds:[instrumentId],startAt:from,endAt:to,targetBars:30},reason:'verified-calendar-gap; provider-availability-unconfirmed'};
  }
  coverage(instrumentId,targetBars=500,from=null,to=null) {
    const instrument=getInstrumentById(instrumentId);const bars=this.candleStore.query({instrumentId,interval:"1day",adjustmentMode:"splits",from,to,limit:10000});const valid=bars.filter(c=>assessClosedCandle(c,instrument,new Date(this.now())).eligible);
    const gaps=instrument?expectedDailyGaps(valid,instrument):[],partial=valid.some(c=>c.calendar?.partial),truncated=bars.length>=10000;
    return {instrumentId,targetBars,validBars:valid.length,countsAreLowerBounds:truncated,goalMet:valid.length>=targetBars,quantityGoalMet:valid.length>=targetBars,continuity:gaps.length?'gaps':partial||truncated?'unknown':'continuous',technicalEligibility:valid.length>=targetBars&&!gaps.length&&!partial&&!truncated,oldest:valid[0]?.openTime||null,newest:valid.at(-1)?.closeTime||null,seriesRevision:stableHash(valid),gaps:gaps.slice(0,100),gapsTruncated:gaps.length>100,scannedLimit:10000,calendarVersion:CALENDAR_VERSION,reconciliation:"single-provider-only",totalReturnAvailable:false};
  }
  async run({jobId,maxRequests=1}) {
    if(this.inFlight.has(jobId)) return this.inFlight.get(jobId);
    const task=this.execute(jobId,Math.min(4,Math.max(1,maxRequests)));this.inFlight.set(jobId,task);try{return await task;}finally{this.inFlight.delete(jobId);}
  }
  async execute(jobId,budget) {
    let job=this.get(jobId);let requests=0,inspected=0;
    while(job.cursor<job.chunks.length&&requests<budget&&inspected++<Math.max(4,budget*4)) {
      checkOperation();if(['cancelled','completed','blocked'].includes(job.status))break;
      const chunk=job.chunks[job.cursor];if(chunk.nextRetryAt&&Date.parse(chunk.nextRetryAt)>this.now()) break;
      if(chunk.attempts>=3) {this.ledger.transact(state=>{const row=state.jobs[jobId];row.status="blocked";row.chunks[row.cursor].status="blocked";row.chunks[row.cursor].failureCode="HISTORY_ATTEMPTS_EXHAUSTED";});break;}
      const instrument=getInstrumentById(chunk.instrumentId);if(!instrument) throw new AppError("Identidad retirada; no continuar adquisición.",409,"UNRESOLVED_INSTRUMENT");
      if(job.interval&&job.interval!=='1day'){
        const stored=await this.candleStore.query({instrumentId:chunk.instrumentId,interval:job.interval,adjustmentMode:job.adjustmentMode,from:chunk.from,to:chunk.to,limit:10000});
        const covered=intradayWindowCoverage(stored,instrument,{...chunk,interval:job.interval});
        if(covered.complete){this.ledger.transact(state=>{const row=state.jobs[jobId];if(row.status==='cancelled'||row.cursor!==job.cursor)return;row.chunks[row.cursor].status='complete';row.chunks[row.cursor].reason='persisted-continuity-verified';row.cursor++;row.status=row.cursor===row.chunks.length?'completed':'pending';});job=this.get(jobId);continue;}
      }
      if(job.interval&&job.interval!=='1day'&&intradayWindowCoverage([],instrument,{...chunk,interval:job.interval}).reason==='no-expected-session'){
        this.ledger.transact(state=>{const row=state.jobs[jobId];if(row.status==='cancelled'||row.cursor!==job.cursor)return;row.chunks[row.cursor].status='complete';row.chunks[row.cursor].reason='outside-regular-session';row.cursor++;row.status=row.cursor===row.chunks.length?'completed':'pending';});job=this.get(jobId);continue;
      }
      // Claim persistido antes de HTTP; reinicio reintenta de forma idempotente la misma ventana.
      const attemptId=randomUUID(),position=job.cursor;
      this.ledger.transact(state=>{const row=state.jobs[jobId];row.status="running";row.chunks[row.cursor].attempts++;row.chunks[row.cursor].attemptId=attemptId;});requests++;
      try {
        const data=await this.marketDataService.fetchYahooBars(instrument.providerSymbols.yahoo,{period:'1y',interval:({'1day':'1d','5min':'5m','15min':'15m','30min':'30m','1h':'1h'}[job.interval||'1day']),from:chunk.from,to:chunk.to,force:job.kind!=='intraday-catchup',allowStale:false,providerRetries:0,awaitPersistence:true});
        checkOperation();
        const live=this.ledger.state.jobs[jobId];if(live.status==='cancelled'||live.cursor!==position||live.chunks[position].attemptId!==attemptId)break;
        if(data.persistence?.pending||data.persistence?.committed===false)throw Object.assign(Error('Commit no confirmado'),{code:'HISTORY_COMMIT_NOT_CONFIRMED'});
        if(data.stale||data.complete===false||data.error) throw Object.assign(new Error("incomplete"),{code:"HISTORY_PARTIAL"});
        let continuity=null;
        if(job.interval&&job.interval!=='1day'){
          const bars=await this.candleStore.query({instrumentId:chunk.instrumentId,interval:job.interval,adjustmentMode:job.adjustmentMode,from:chunk.from,to:chunk.to,limit:10000});
          continuity=intradayWindowCoverage(bars,instrument,{...chunk,interval:job.interval});
          if(!continuity.complete&&continuity.reason!=='no-expected-session')throw Object.assign(Error('Cobertura parcial'),{code:'HISTORY_PARTIAL',coverage:continuity});
        }
        this.ledger.transact(state=>{const row=state.jobs[jobId];if(row.status==='cancelled'||row.cursor!==position||row.chunks[position].attemptId!==attemptId)return;const current=row.chunks[row.cursor];current.status="complete";current.completedAt=new Date(this.now()).toISOString();current.persistence=data.persistence||null;row.cursor++;row.status=row.cursor===row.chunks.length?"completed":"pending";});
      } catch(error) { this.ledger.transact(state=>{const row=state.jobs[jobId];if(row.status==='cancelled'||row.cursor!==position||row.chunks[position].attemptId!==attemptId)return;const current=row.chunks[row.cursor];current.status=current.attempts>=3?"blocked":"retry";current.failureCode=/^[A-Z0-9_]{1,64}$/.test(error.code||"")?error.code:"HISTORY_SOURCE_ERROR";current.coverage=error.coverage||null;const retryAfter=Number(error.retryAfterMs||error.details?.retryAfterMs)||0;current.nextRetryAt=new Date(this.now()+Math.max(retryAfter,Math.min(3600000,30000*2**current.attempts))).toISOString();row.status=current.status;});break; }
      job=this.get(jobId);
    }
    if(job.kind==='intraday-catchup')this.ledger.transact(state=>{const row=state.jobs[jobId],key=this.coverageKey({instrumentId:row.instrumentIds[0],interval:row.interval,adjustmentMode:row.adjustmentMode}),prior=state.jobs[key];state.jobs[key]={...prior,jobId:key,kind:'market-coverage',instrumentIds:row.instrumentIds,createdAt:prior?.createdAt||row.createdAt,status:row.status,pendingJobId:row.status==='completed'?null:jobId,coverageThrough:row.status==='completed'?row.endAt:prior?.coverageThrough||null,lastAttemptAt:new Date(this.now()).toISOString(),lastSuccessAt:row.status==='completed'?new Date(this.now()).toISOString():prior?.lastSuccessAt||null,nextEligibleAt:row.chunks[row.cursor]?.nextRetryAt||null,missingBars:row.status==='completed'?0:row.chunks[row.cursor]?.coverage?.missingBars??null};});
    return {...this.get(jobId),requestsThisRun:requests};
  }
}
