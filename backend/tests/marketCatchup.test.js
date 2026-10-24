import test from 'node:test';
import assert from 'node:assert/strict';
import {registerInstruments} from '../services/market/instrumentRegistry.js';
import {expectedPublicableCandle,assessClosedCandle} from '../services/market/candleValidation.js';
import {sessionPolicyResolver} from '../services/market/sessionPolicyResolver.js';
import {HistoricalAcquisitionService} from '../services/market/historicalAcquisitionService.js';
import {IntradayCandleService} from '../services/market/intradayCandleService.js';
import {MarketDataStoreAdapter} from '../services/marketData/marketDataStore.js';
import {MarketConditionsService} from '../services/market/marketConditionsService.js';
import {resolveClosedSeries} from '../services/market/closedSeries.js';
import {intradayWindowCoverage} from '../services/market/coverageWindows.js';
import {TechnicalContextService} from '../services/market/technicalContextService.js';

const instrument={instrumentId:'fixture-xetra-fund',canonicalSymbol:'FIX.DE',assetType:'etf',exchange:'Xetra',mic:'XETR',currency:'EUR',timezone:'Europe/Berlin',verificationStatus:'verified',enabled:true,refreshTier:'hot',sessionPolicy:'exchange-hours',providerSymbols:{yahoo:'FIX.DE'}};
registerInstruments([instrument]);
function candle(at,interval='5min'){return {instrumentId:instrument.instrumentId,interval,openTime:new Date(at).toISOString(),closeTime:new Date(at+300000).toISOString(),open:100,high:102,low:99,close:101,volume:100,currency:'EUR',source:'yahoo',dataMode:'observed',quality:'valid',adjusted:true,revision:1};}
test('provider availability distinguishes close time, DE/AS delay and MI delay across the DST weekend',()=>{
  const before=expectedPublicableCandle(instrument,'5min','2026-10-23T15:40:00Z');assert.ok(Date.parse(before.expectedLatestCandleAt)<Date.parse('2026-10-23T15:30:00Z'));
  for(const suffix of ['DE','AS','MI']){
    const i={...instrument,providerSymbols:{yahoo:`FIX.${suffix}`}};
    const target=expectedPublicableCandle(i,'5min','2026-10-24T12:00:00Z');assert.equal(target.expectedLatestCandleAt,'2026-10-23T15:30:00.000Z');assert.equal(target.delayMs,suffix==='MI'?1200000:900000);
  }
  assert.equal(expectedPublicableCandle(instrument,'5min','2026-10-26T17:00:00Z').expectedLatestCandleAt,'2026-10-26T16:30:00.000Z');
});
test('closed partial chart tails are preserved but rejected as regular historical candles',()=>{
  assert.equal(assessClosedCandle(candle(Date.parse('2026-10-23T09:50:16Z')),instrument,'2026-10-24').reason,'unaligned-candle');
  assert.equal(assessClosedCandle(candle(Date.parse('2026-10-23T09:50:00Z')),instrument,'2026-10-24').eligible,true);
});
test('daily quality requires the official complete session rather than any closed OHLCV row',()=>{
  const valid={...candle(Date.parse('2026-10-23T07:00:00Z'),'1day'),closeTime:'2026-10-23T15:30:00.000Z'};
  assert.equal(assessClosedCandle(valid,instrument,'2026-10-24').eligible,true);
  assert.equal(assessClosedCandle({...valid,closeTime:'2026-10-23T15:00:00Z'},instrument,'2026-10-24').reason,'unaligned-daily-session');
  const weekend={...valid,openTime:'2026-10-24T07:00:00Z',closeTime:'2026-10-24T15:30:00Z'};
  assert.equal(assessClosedCandle(weekend,instrument,'2026-10-25').eligible,false);
  const ledger={state:{jobs:{}}},history=new HistoricalAcquisitionService({ledger,candleStore:{query:()=>[valid,weekend]},now:()=>Date.parse('2026-10-25')});
  assert.equal(history.coverage(instrument.instrumentId).validBars,1);
});
test('late startup catches up through durable jobs and a Saturday restart makes zero redundant requests',async()=>{
  let now=Date.parse('2026-10-23T18:00:00Z'),calls=0;const bars=[];
  const store={enabled:true,query:({from,to,limit=10000})=>bars.filter(c=>(!from||c.openTime>=from)&&(!to||c.openTime<=to)).slice(-limit),latest:()=>bars.at(-1)||null,coverageSummary:()=>[{instrumentId:instrument.instrumentId,localCandleCount:bars.length,lastClosedCandleAt:bars.at(-1)?.closeTime||null}]};
  const ledger={state:{jobs:{}},transact(fn){return structuredClone(fn(this.state)??null);}};
  const history=new HistoricalAcquisitionService({ledger,candleStore:store,now:()=>now,marketDataService:{fetchYahooBars:async(_s,{from,to,awaitPersistence})=>{
    assert.equal(awaitPersistence,true);calls++;
    for(let at=Date.parse(from);at+300000<=Date.parse(to);at+=300000)if(sessionPolicyResolver.resolveCandle(instrument,new Date(at).toISOString()).eligible&&!bars.some(c=>c.openTime===new Date(at).toISOString()))bars.push(candle(at));
    bars.sort((a,b)=>a.openTime.localeCompare(b.openTime));return {complete:true,persistence:{committed:true,pending:false}};
  }}});
  const config={provider:'yahoo',watchlistService:{selectedInstruments:()=>[instrument]},intradayCandles:{enabled:true,interval:'5min',pollIntervalMs:900000}};
  const service=new IntradayCandleService({store,history,marketConfig:config,now:()=>new Date(now)});
  for(let n=0;n<12&&!history.coverageState({instrumentId:instrument.instrumentId,interval:'5min'}).coverageThrough;n++){await service.runScheduled();now+=900000;}
  const state=history.coverageState({instrumentId:instrument.instrumentId,interval:'5min'});
  assert.equal(state.coverageThrough,'2026-10-23T15:30:00.000Z');assert.ok(calls>0);const completedCalls=calls;
  now=Date.parse('2026-10-24T12:00:00Z');
  const restarted=new IntradayCandleService({store,history,marketConfig:config,now:()=>new Date(now)});
  assert.equal((await restarted.runScheduled()).status,'up-to-date');assert.equal(calls,completedCalls);
  assert.ok(restarted.getMetrics().instrumentStates[0].localCandleCount>0);
});
test('a deferred persistence receipt cannot acknowledge success before its own commit',async()=>{
  let release;const gate=new Promise(r=>{release=r;});
  const adapter=new MarketDataStoreAdapter({persistAsync:true,candleStore:{upsert:async()=>{await gate;return {inserted:1};}}});
  const result=await adapter.upsertBars([{symbol:'FIX.DE',timestamp:'2026-10-23T09:50:00Z',source:'yahoo',open:100,high:102,low:99,close:101,volume:1}],{symbol:'FIX.DE',interval:'5m'});
  assert.equal(result.persistence.pending,true);let confirmed=false;
  const ack=adapter.waitForPersistence(result.persistence).then(value=>{confirmed=true;return value;});await Promise.resolve();assert.equal(confirmed,false);
  release();assert.equal((await ack).committed,true);assert.equal(adapter.getPersistenceStatus().failed,0);
});
test('shared hourly series derives current base candles instead of selecting an old hourly row',()=>{
  const values=Array.from({length:36},(_,i)=>candle(Date.parse('2026-10-23T07:00:00Z')+i*300000));values.push(candle(Date.parse('2026-10-23T07:00:16Z')));let requested;
  const result=resolveClosedSeries({query:args=>{requested=args;return values;}},{instrument,interval:'1h',limit:2,asOf:'2026-10-23T12:00:00Z'});
  assert.equal(requested.interval,'5min');assert.ok(requested.limit>=24);assert.equal(result.candles.length,2);assert.equal(result.lineage.baseInterval,'5min');
  assert.equal(result.quality.rejectedCandles,1);assert.equal(result.quality.gapDetected,false);
});
test('last-close Conditions remains explicitly anchored while live stays market closed',()=>{
  const values=Array.from({length:6},(_,i)=>candle(Date.parse('2026-10-23T15:00:00Z')+i*300000));
  const service=new MarketConditionsService({candleStore:{query:()=>values},stateManager:{getSnapshot:()=>({market:{quotes:{}}}),getMarketSignalCorpus:()=>[]},marketWatchlistService:{selectedInstruments:()=>[instrument]},now:()=>Date.parse('2026-10-24T12:00:00Z'),intradayCandlesEnabled:true});
  const live=service.getSnapshot({windowMin:15});assert.equal(live.symbols[0].availability.analyzable,false);
  const closed=service.getSnapshot({windowMin:15,anchor:'last-close'});assert.equal(closed.anchor,'last-close');assert.equal(closed.symbols[0].sessionAsOf,'2026-10-23T15:30:00.000Z');assert.equal(closed.symbols[0].availability.sessionState,'closed');assert.equal(closed.symbols[0].availability.analyzable,true);
  values.splice(0,values.length-1);
  const insufficient=service.getSnapshot({windowMin:15,anchor:'last-close'});assert.equal(insufficient.symbols[0].availability.analyzable,false);assert.equal(insufficient.symbols[0].availability.primaryReason,'warming_up');
});
test('last-close retains the completed session during the next opening, with the same technical cut and no look-ahead',()=>{
  let now=Date.parse('2026-10-24T12:00:00Z');
  const values=[...Array.from({length:6},(_,i)=>candle(Date.parse('2026-10-23T15:00:00Z')+i*300000)),...Array.from({length:6},(_,i)=>({...candle(Date.parse('2026-10-26T09:00:00Z')+i*300000),close:102}))];
  const store={query:()=>values},service=new MarketConditionsService({candleStore:store,stateManager:{getSnapshot:()=>({market:{quotes:{}}}),getMarketSignalCorpus:()=>[]},marketWatchlistService:{selectedInstruments:()=>[instrument]},now:()=>now,intradayCandlesEnabled:true});
  const technical=new TechnicalContextService({store,now:()=>new Date(now)});
  const after=service.getSnapshot({windowMin:15,anchor:'last-close'}),tAfter=technical.get({instrumentId:instrument.instrumentId,interval:'5min',anchor:'last-close'});
  now=Date.parse('2026-10-26T10:00:00Z');
  const open=service.getSnapshot({windowMin:15,anchor:'last-close'}),tOpen=technical.get({instrumentId:instrument.instrumentId,interval:'5min',anchor:'last-close'});
  assert.equal(open.symbols[0].availability.sessionState,'open');
  assert.equal(open.symbols[0].sessionAsOf,after.symbols[0].sessionAsOf);assert.deepEqual(open.symbols[0].metrics,after.symbols[0].metrics);
  assert.equal(tOpen.sessionAsOf,open.symbols[0].sessionAsOf);assert.equal(tOpen.dataAsOf,tAfter.dataAsOf);assert.equal(tOpen.snapshotId,tAfter.snapshotId);assert.equal(tOpen.observed.close,101);assert.equal(tOpen.quality.stale,false);
  assert.equal(technical.get({instrumentId:instrument.instrumentId,interval:'5min'}).observed.close,102);
});
test('hourly coverage uses the US session grid across the EU/US DST mismatch and excludes terminal half-hours',()=>{
  const us={...instrument,assetType:'equity',exchange:'NYSE',mic:'XNYS',timezone:'America/New_York',sessionPolicy:'nyse-equities',providerSymbols:{yahoo:'FIX'}};
  for(const [date,openHour]of [['2026-10-23',13],['2026-10-26',13],['2026-11-02',14]]){
    const start=Date.parse(`${date}T${openHour}:30:00Z`),bars=Array.from({length:6},(_,i)=>({...candle(start+i*3600000,'1h'),closeTime:new Date(start+(i+1)*3600000).toISOString()}));
    const range={from:new Date(start).toISOString(),to:new Date(start+6.5*3600000).toISOString(),interval:'1h'};
    const full=intradayWindowCoverage(bars,us,range);assert.equal(full.expectedBars,6);assert.equal(full.complete,true);assert.equal(intradayWindowCoverage(bars.slice(1),us,range).missingBars,1);
  }
});
test('a cancellation during the durable continuity read fences a late successful catch-up result',async()=>{
  let entered,release,queries=0;const waiting=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const ledger={state:{jobs:{}},transact(fn){return structuredClone(fn(this.state)??null);}},now=Date.parse('2026-10-23T18:00:00Z');
  const history=new HistoricalAcquisitionService({ledger,now:()=>now,candleStore:{query:async()=>{if(++queries===1)return [];entered();return gate;}},marketDataService:{fetchYahooBars:async()=>({complete:true,persistence:{committed:true,pending:false}})}});
  const scope={instrumentId:instrument.instrumentId,interval:'5min'},job=history.ensureCatchup({...scope,from:'2026-10-23T09:00:00.000Z',to:'2026-10-23T09:05:00.000Z'});
  const run=history.run({jobId:job.jobId,maxRequests:1});await waiting;history.cancel({jobId:job.jobId});release([candle(Date.parse('2026-10-23T09:00:00Z'))]);
  assert.equal((await run).status,'cancelled');assert.equal(history.coverageState(scope).coverageThrough,null);assert.equal(ledger.state.jobs[job.jobId].cursor,0);
});
test('rate-limited windows retain debt and Retry-After without another request before eligibility',async()=>{
  let calls=0;const ledger={state:{jobs:{}},transact(fn){return structuredClone(fn(this.state)??null);}},now=Date.parse('2026-10-24T12:00:00Z');
  const history=new HistoricalAcquisitionService({ledger,now:()=>now,candleStore:{query:()=>[]},marketDataService:{fetchYahooBars:async()=>{calls++;throw Object.assign(Error('rate limited'),{code:'YAHOO_RATE_LIMITED',retryAfterMs:600000});}}});
  const scope={instrumentId:instrument.instrumentId,interval:'5min'},job=history.ensureCatchup({...scope,from:'2026-10-23T09:00:00.000Z',to:'2026-10-23T09:05:00.000Z'});
  assert.equal((await history.run({jobId:job.jobId,maxRequests:1})).status,'retry');assert.equal(history.coverageState(scope).coverageThrough,null);
  assert.ok(Date.parse(history.coverageState(scope).nextEligibleAt)>=now+600000);
  assert.equal((await history.run({jobId:job.jobId,maxRequests:1})).requestsThisRun,0);assert.equal(calls,1);
});
