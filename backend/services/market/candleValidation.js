import {candleIntervalMs,resolveDailyCandleTimes} from './canonicalCandle.js';
import {tradingDay,localDate,adjacentTradingDay,CALENDAR_VERSION} from './exchangeCalendar.js';
import {sessionPolicyResolver} from './sessionPolicyResolver.js';
export const CANDLE_VALIDATION_VERSION='closed-candle-grid-v1';
export function providerPublicationPolicy(instrument={},config={}) {
  const symbol=instrument.providerSymbols?.yahoo||instrument.canonicalSymbol||'';
  const minutes=/\.MI$/i.test(symbol)?20:/\.(DE|AS)$/i.test(symbol)?15:instrument.sessionPolicy==='24x7'?0:15;
  return {delayMs:minutes*60000,graceMs:config.publicationGraceMs??120000,basis:/\.(MI|DE|AS)$/i.test(symbol)?'yahoo-published-exchange-delay':'conservative-internal-policy',sessionType:'regular',calendarVersion:CALENDAR_VERSION};
}
export function expectedPublicableCandle(instrument,interval,now,config={}) {
  const policy=providerPublicationPolicy(instrument,config),at=new Date(+new Date(now)-policy.delayMs-policy.graceMs);
  let expected=sessionPolicyResolver.resolve(instrument,at,{intervalMs:candleIntervalMs(interval)}).expectedLatestCandleAt||null;
  if(expected&&['equity','etf','fund','index'].includes(instrument.assetType)&&['15min','30min','1h'].includes(interval)){
    const session=tradingDay(instrument,localDate(Date.parse(expected)-1,instrument.timezone)),open=Date.parse(session.openTime),ms=candleIntervalMs(interval);
    if(Number.isFinite(open))expected=new Date(open+Math.floor((Date.parse(expected)-open)/ms)*ms).toISOString();
  }
  return {...policy,expectedLatestCandleAt:expected};
}
// An explicit session-close view stays on the previous completed session while
// today's session is open. Publication delay/grace do not change that anchor.
export function lastPublicableSessionClose(instrument,now,config={}) {
  const policy=providerPublicationPolicy(instrument,config),available=+new Date(now)-policy.delayMs-policy.graceMs;
  let expectedLatestCandleAt=null;
  if(instrument.sessionPolicy==='24x7')expectedLatestCandleAt=new Date(Math.floor(available/86400000)*86400000).toISOString();
  else if(['equity','etf','fund','index'].includes(instrument.assetType)){
    const date=localDate(available,instrument.timezone),day=tradingDay(instrument,date);
    if(!day.halfDayPending){const last=!day.closed&&Date.parse(day.closeTime)<=available?day:adjacentTradingDay(instrument,date,-1);expectedLatestCandleAt=last?.closeTime||null;}
  }
  return {...policy,expectedLatestCandleAt,anchor:'last-close'};
}
export function assessClosedCandle(candle,instrument,asOf=new Date()) {
  let reason=null;const open=Date.parse(candle.openTime),close=Date.parse(candle.closeTime),ms=candleIntervalMs(candle.interval),now=+new Date(asOf);
  if(![open,close,now].every(Number.isFinite)||!ms||close<=open)reason='invalid-candle-time';
  else if(![candle.open,candle.high,candle.low,candle.close].every(x=>typeof x==='number'&&Number.isFinite(x))||candle.high<Math.max(candle.open,candle.close,candle.low)||candle.low>Math.min(candle.open,candle.close,candle.high)||candle.volume!=null&&(!Number.isFinite(candle.volume)||candle.volume<0))reason='invalid-ohlcv';
  else if(close>now)reason='candle-open';
  else if(candle.synthetic||candle.provenance?.synthetic||['synthetic','fallback','seeded'].includes(candle.dataMode))reason='synthetic-candle';
  else if(candle.interval==='1day'){
    const session=instrument&&resolveDailyCandleTimes(localDate(open,instrument.timezone),instrument);
    if(!session)reason='unverified-daily-session';
    else if(open!==Date.parse(session.openTime)||close!==Date.parse(session.closeTime))reason='unaligned-daily-session';
  }
  else if(!['1day','1wk','1mo'].includes(candle.interval)){
    const cash=['equity','etf','fund','index'].includes(instrument?.assetType);
    const session=cash?tradingDay(instrument,localDate(open,instrument.timezone)):null;
    const anchor=cash?Date.parse(session.openTime):0;
    if(!sessionPolicyResolver.resolveCandle(instrument||{},candle.openTime).eligible)reason='outside-regular-session';
    else if(!Number.isFinite(anchor)||(open-anchor)%ms!==0)reason='unaligned-candle';
    else if(close-open!==ms)reason='partial-session-bucket';
    else if(cash&&close>Date.parse(session.closeTime))reason='partial-session-bucket';
    const granularity=candle.provenance?.chart?.dataGranularity;
    if(granularity&&({'5min':'5m','15min':'15m','30min':'30m','1h':'1h'}[candle.interval])!==granularity)reason='provider-granularity-mismatch';
  }
  return {eligible:reason===null,reason,methodVersion:CANDLE_VALIDATION_VERSION,calendarVersion:CALENDAR_VERSION};
}
export function chartProvenance(meta) {
  if(!meta||typeof meta!=='object')return null;
  const iso=v=>v!=null&&Number.isFinite(+new Date(v))?new Date(v).toISOString():null;
  const rows=Array.isArray(meta.tradingPeriods)?meta.tradingPeriods.flat():meta.tradingPeriods?.regular?.flat()||(meta.currentTradingPeriod?.regular?[meta.currentTradingPeriod.regular]:[]);
  return {dataGranularity:typeof meta.dataGranularity==='string'?meta.dataGranularity.slice(0,12):null,regularMarketTime:iso(meta.regularMarketTime),firstTradeDate:meta.firstTradeDate?iso(meta.firstTradeDate):null,exchangeTimezoneName:typeof meta.exchangeTimezoneName==='string'?meta.exchangeTimezoneName.slice(0,80):null,tradingPeriods:rows.slice(-64).map(r=>({start:iso(r.start),end:iso(r.end)})),tradingPeriodsTruncated:rows.length>64,sessionType:'regular'};
}
