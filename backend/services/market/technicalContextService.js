import { getInstrumentById } from "./instrumentRegistry.js";
import { calculateTechnicalIndicators, sma, atr } from "./technicalIndicators.js";
import { stableHash } from "../../utils/stableHash.js";
import { CALENDAR_VERSION, addDate, tradingDay, localDate, zonedBoundary, expectedDailyGaps } from "./exchangeCalendar.js";
import { candleIntervalMs } from "./canonicalCandle.js";
import { AppError } from "../../utils/error.js";
const nd=(reason,sampleSize=0)=>({value:null,reason,sampleSize});
const ok=(value,sampleSize)=>({value,reason:null,sampleSize});
const mean=v=>v.reduce((a,b)=>a+b,0)/v.length;
const finite=v=>typeof v==="number"&&Number.isFinite(v);
export function wilderAtr(bars,period=14) {
  if(bars.length<period+1||bars.some(c=>![c.high,c.low,c.close].every(finite))) return nd("insufficient_data",bars.length);
  const ranges=bars.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-bars[i].close),Math.abs(c.low-bars[i].close)));
  let value=mean(ranges.slice(0,period));for(const tr of ranges.slice(period)) value=(value*(period-1)+tr)/period;return {...ok(value,bars.length),method:"wilder-rma-sma-seed-v1"};
}
export function aggregateWeekly(daily,instrument,asOf) {
  const groups=new Map();for(const bar of daily) {const date=localDate(bar.openTime,instrument.timezone);const day=new Date(`${date}T12:00:00Z`).getUTCDay();const monday=addDate(date,-((day+6)%7));if(!groups.has(monday)) groups.set(monday,[]);groups.get(monday).push(bar);}
  const result=[];for(const [monday,bars] of groups) {
    const expected=Array.from({length:5},(_,i)=>tradingDay(instrument,addDate(monday,i))).filter(d=>!d.closed);
    if(expected.some(d=>!d.closeTime)||!expected.length||Date.parse(expected.at(-1).closeTime)>Date.parse(asOf)) continue;
    const dates=new Set(bars.map(c=>localDate(c.openTime,instrument.timezone)));const missing=expected.filter(d=>!dates.has(d.date)).map(d=>d.date);
    if(missing.some(date=>date<localDate(daily[0].openTime,instrument.timezone)))continue;
    result.push({...bars[0],interval:"1wk",closeTime:expected.at(-1).closeTime,open:bars[0].open,high:Math.max(...bars.map(c=>c.high)),low:Math.min(...bars.map(c=>c.low)),close:bars.at(-1).close,volume:bars.every(c=>finite(c.volume))?bars.reduce((s,c)=>s+c.volume,0):null,
      methodVersion:"weekly-from-daily-v1",quality:missing.length?"partial":"valid",missingSessions:missing,provenance:{...bars[0].provenance,derivedFrom:"1day",seriesRevision:stableHash(bars)},calendar:{methodVersion:CALENDAR_VERSION,partial:expected.some(d=>d.partial)}});
  } return result;
}
function movingAverage(bars,period) {const closes=bars.map(c=>c.close);const value=sma(closes,period);if(value.value==null)return value;const prior=sma(closes.slice(0,-5),period);return {...value,distanceFraction:closes.at(-1)/value.value-1,slopePerBar:prior.value==null?null:(value.value-prior.value)/5,slopeWindow:5};}
function levels(bars,window=60) {const sample=bars.slice(-window-1,-1);if(sample.length<20)return nd("insufficient_data",sample.length);return {...ok({support:Math.min(...sample.map(c=>c.low)),resistance:Math.max(...sample.map(c=>c.high))},sample.length),method:"prior-closed-window-extrema-v1",window,excludedLatest:true};}
function relativeStrength(bars,benchmark) {
  if(!benchmark.length)return nd("benchmark_unavailable");
  const byTime=new Map(benchmark.map(c=>[c.closeTime,c]));const pairs=bars.map(c=>[c,byTime.get(c.closeTime)]).filter(([,b])=>b).slice(-21);
  if(pairs.length<21)return nd("insufficient_aligned_benchmark",pairs.length);
  const a=pairs.at(0),b=pairs.at(-1);if(![a[0].close,a[1].close,b[0].close,b[1].close].every(x=>finite(x)&&x>0))return nd("invalid_values",pairs.length);
  return {...ok(b[0].close/a[0].close-b[1].close/a[1].close,pairs.length),unit:"return-fraction",alignment:"exact-closed-time; no FX conversion",window:20};
}
function relativeVolume(bars,instrument,interval) {
  const last=bars.at(-1);if(!last||!finite(last.volume))return nd("volume_unavailable");
  let sample=bars.slice(0,-1);if(interval!=="1day"&&interval!=="1wk") {
    const zone=instrument.timezone;const minute=c=>{const f=Object.fromEntries(new Intl.DateTimeFormat("en",{timeZone:zone,hourCycle:"h23",hour:"2-digit",minute:"2-digit"}).formatToParts(new Date(c.openTime)).map(p=>[p.type,p.value]));return +f.hour*60+ +f.minute;};
    const target=minute(last);sample=sample.filter(c=>minute(c)===target&&localDate(c.openTime,zone)!==localDate(last.openTime,zone));
  }sample=sample.slice(-20);if(sample.length<5||!sample.every(c=>finite(c.volume)))return nd("insufficient_comparable_volume",sample.length);
  const average=mean(sample.map(c=>c.volume));return average>0?{...ok(last.volume/average,sample.length),method:interval==="1day"?"prior-20-session-mean-v1":interval==="1wk"?"prior-20-weeks-mean-v1":"same-exchange-local-slot-prior-20-sessions-v1",unit:"ratio"}:nd("zero_volume_baseline",sample.length);
}
export class TechnicalContextService {
  constructor({store,now=()=>new Date()}={}){this.store=store;this.now=now;}
  get({instrumentId,interval="1day",adjusted="splits",package:packageId="standard-v1",benchmarkInstrumentId,limit=500}={}) {
    const instrument=getInstrumentById(instrumentId);if(!instrument||instrument.verificationStatus!=="verified")throw new AppError("Instrumento no verificado.",400,"UNRESOLVED_INSTRUMENT");
    if(packageId!=="standard-v1"||!["1day","1wk","1h","30min","15min","5min"].includes(interval)||!["splits","none"].includes(adjusted))throw new AppError("Paquete técnico inválido.",400,"INVALID_TECHNICAL_PARAMETERS");
    const asOf=this.now().toISOString();const query=(id)=>this.store.query({instrumentId:id,interval:interval==="1wk"?"1day":interval,adjustmentMode:adjusted,limit:interval==="1wk"?Math.min(10000,limit*7):limit}).filter(c=>Date.parse(c.closeTime)<=Date.parse(asOf));
    const daily=query(instrumentId);const bars=interval==="1wk"?aggregateWeekly(daily,instrument,asOf).slice(-limit):daily;
    const base=calculateTechnicalIndicators(bars,{interval,instrument:interval==="1day"?instrument:null,calculatedAt:asOf});
    const invalid=base.quality.reason||base.quality.gapDetected&&"gaps_detected"||bars.some(c=>c.quality==="partial")&&"partial_series";
    const protect=value=>invalid?nd(invalid,bars.length):value;const last=bars.at(-1);
    let benchmark=[];let benchmarkReason=null;
    if(benchmarkInstrumentId){const b=getInstrumentById(benchmarkInstrumentId);if(!b||b.verificationStatus!=="verified")throw new AppError("Benchmark no verificado.",400,"UNRESOLVED_INSTRUMENT");benchmark=query(b.instrumentId);if(interval==="1wk")benchmark=aggregateWeekly(benchmark,b,asOf);const bBase=calculateTechnicalIndicators(benchmark,{interval,calculatedAt:asOf});benchmarkReason=bBase.quality.reason||bBase.quality.gapDetected&&"benchmark_gaps";}
    const perYear=interval==="1day"?252:interval==="1wk"?52:null;const vol=base.indicators.realizedVolatility;
    const sessionBars=last&&!["1day","1wk"].includes(interval)?bars.filter(c=>localDate(c.openTime,instrument.timezone)===localDate(last.openTime,instrument.timezone)):[];
    const volume=sessionBars.reduce((s,c)=>s+(finite(c.volume)?c.volume:0),0);const vwap=volume>0&&sessionBars.every(c=>finite(c.volume))?ok(sessionBars.reduce((s,c)=>s+(c.high+c.low+c.close)/3*c.volume,0)/volume,sessionBars.length):nd("intraday_volume_unavailable",sessionBars.length);
    return {instrumentId,companyId:instrument.companyId||null,interval,adjusted,package:packageId,methodVersion:"technical-context-v1",asOf,snapshotId:stableHash({bars,benchmark,interval,adjusted}),seriesRevision:stableHash(bars),sampleSize:bars.length,lastClosedCandleAt:last?.closeTime||null,
      warmup:{sma200:200,rsi14:15,macd12269:34,atr14:15,relativeStrength:21,complete:bars.length>=200},parameters:{smaPeriods:[20,50,200],slopeWindow:5,rsiPeriod:14,macd:[12,26,9],bollinger:[20,2],atrPeriod:14,volatilityPeriod:20,levelsWindow:60},
      indicators:{...base.indicators,sma20:protect(movingAverage(bars,20)),sma50:protect(movingAverage(bars,50)),sma200:protect(movingAverage(bars,200)),atr14Simple:{...protect(atr(bars,14)),method:"simple-mean-true-range-v1"},atr14Wilder:protect(wilderAtr(bars)),volatility:{...protect(vol),unit:"log-return-standard-deviation-per-bar",annualizationFactor:perYear,annualized:!invalid&&vol.value!=null&&perYear?vol.value*Math.sqrt(perYear):null,annualizedReason:perYear?null:"intraday_annualization_not_assumed"},
      relativeStrength:protect(benchmarkReason?nd(benchmarkReason,benchmark.length):relativeStrength(bars,benchmark)),relativeVolume:protect(relativeVolume(bars,instrument,interval)),levels:protect(levels(bars)),vwapApprox:{...protect(vwap),method:"typical-price-times-bar-volume-v1",approximate:true,unit:instrument.currency,coverage:sessionBars.length?{from:sessionBars[0].openTime,sessionOpenObserved:sessionBars[0].openTime===zonedBoundary(localDate(last.openTime,instrument.timezone),tradingDay(instrument,localDate(last.openTime,instrument.timezone)).openMinute,instrument.timezone)}:null}},
      quality:{...base.quality,reason:invalid||null,stale:bars.some(c=>c.dataMode==="stale"||c.provenance?.stale),calendarPartial:daily.some(c=>c.calendar?.partial||c.calendar==null),synthetic:bars.some(c=>c.synthetic||["synthetic","fallback","seeded"].includes(c.dataMode)),provider: [...new Set(bars.map(c=>c.source))],delay:"web-delayed-or-provider-history",currency:instrument.currency},
      coverage:{from:bars[0]?.openTime||null,to:last?.closeTime||null,gaps:interval==="1day"?expectedDailyGaps(bars,instrument).slice(0,100):[]},warnings:["Correlated indicators are not independent confirmations.","Relative strength aligns exact closes, without timezone or FX interpolation.","Weekly frames derive from complete daily sessions; historical exceptional calendars may be partial."]};
  }
}
