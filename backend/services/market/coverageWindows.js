import {candleIntervalMs} from './canonicalCandle.js';
import {assessClosedCandle} from './candleValidation.js';
import {sessionPolicyResolver} from './sessionPolicyResolver.js';
import {tradingDay,localDate} from './exchangeCalendar.js';
// One bounded historical window. A last timestamp is never a continuity proof.
export function intradayWindowCoverage(bars,instrument,{from,to,interval,asOf=to}) {
  const ms=candleIntervalMs(interval),start=Date.parse(from),end=Date.parse(to),expected=[];
  if(!ms||!(end>start)||end-start>31*86400000)return {complete:false,missingBars:null,reason:'invalid-coverage-window'};
  const cash=['equity','etf','fund','index'].includes(instrument.assetType),step=300000,sessions=new Map();
  for(let time=Math.ceil(start/step)*step;time+ms<=end;time+=step){
    let anchor=0,sessionEnd=Infinity;
    if(cash){const date=localDate(time,instrument.timezone);if(!sessions.has(date))sessions.set(date,tradingDay(instrument,date));const session=sessions.get(date);anchor=Date.parse(session.openTime);sessionEnd=Date.parse(session.closeTime);}
    if((time-anchor)%ms===0&&time+ms<=sessionEnd&&sessionPolicyResolver.resolveCandle(instrument,new Date(time).toISOString()).eligible)expected.push(new Date(time).toISOString());
  }
  const admitted=new Set(bars.filter(b=>assessClosedCandle(b,instrument,asOf).eligible).map(b=>b.openTime));
  const missing=expected.filter(t=>!admitted.has(t));
  return {complete:expected.length>0&&missing.length===0,expectedBars:expected.length,observedBars:expected.length-missing.length,missingBars:missing.length,missing:missing.slice(0,100),reason:!expected.length?'no-expected-session':missing.length?'missing-bars':null};
}
