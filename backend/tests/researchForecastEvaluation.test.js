import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForecastEvaluationService, purgedWalkForward } from "../services/research/forecastEvaluationService.js";
import { ResearchStore } from "../services/research/researchStore.js";
import { getInstrumentByCanonicalSymbol } from "../services/market/instrumentRegistry.js";
import { tradingDay } from "../services/market/exchangeCalendar.js";
const instrument=getInstrumentByCanonicalSymbol("NVDA");
const peer=getInstrumentByCanonicalSymbol("MSFT");
function bar(id,date,close){const session=tradingDay(instrument,date);return {instrumentId:id,interval:"1day",openTime:session.openTime,closeTime:session.closeTime,fetchedAt:new Date(Date.parse(session.closeTime)+300000).toISOString(),open:close,high:close+1,low:close-1,close,volume:100,currency:"USD",source:"fixture-offline",adjusted:true,dataMode:"observed",provenance:{adjustmentMode:"splits"}};}
function setup(){let now=Date.parse("2026-10-01T22:00:00Z");const rows=[bar(instrument.instrumentId,"2026-10-01",100),bar(instrument.instrumentId,"2026-10-02",104),bar(peer.instrumentId,"2026-10-01",100),bar(peer.instrumentId,"2026-10-02",102)];const path=join(mkdtempSync(join(tmpdir(),"ogid-forecast-")),"ledger.json");const store=new ResearchStore({persistencePath:path});const candleStore={query:({instrumentId})=>rows.filter(r=>r.instrumentId===instrumentId)};const service=new ForecastEvaluationService({store,candleStore,now:()=>now});const input={forecastId:"offline-f1",instrumentId:instrument.instrumentId,benchmarkInstrumentId:peer.instrumentId,target:"return",horizonHours:1,modelVersion:"fixture-v1",predictedValue:0.03,evidence:[{id:"known",availableAt:"2026-10-01T18:00:00Z"}],costs:{commissionBps:1,spreadBps:2,slippageBps:1}};return {service,store,rows,input,path,candleStore,setNow:value=>now=Date.parse(value)};}
test("forecast registry is prospective, durable, idempotent and rejects future or missing availability",()=>{
 const {service,input,rows,path,candleStore,setNow}=setup();
 assert.throws(()=>service.record({...input,issuedAt:"2026-09-30T22:00:00Z"}),{code:"FORECAST_BACKDATING_FORBIDDEN"});
 assert.throws(()=>service.record({...input,evidence:[{availableAt:"2026-10-02T12:00:00Z"}]}),{code:"FUTURE_INFORMATION"});
 const origin=rows[0];origin.fetchedAt="2026-10-02T22:00:00Z";assert.throws(()=>service.record(input),{code:"FORECAST_DATA_UNAVAILABLE"});origin.fetchedAt="2026-10-01T20:05:00Z";
 const registered=service.record(input);assert.equal(registered.originCandle.close,100);assert.equal(registered.probability,null);assert.equal(service.evaluate().results[0].status,"pending-outcome");
 assert.throws(()=>service.record({...input,forecastId:"duplicate"}),{code:"FORECAST_DUPLICATE"});
 assert.throws(()=>service.record({...input,predictedValue:0.2}),{code:"IDEMPOTENCY_CONFLICT"});
 assert.throws(()=>service.record({...input,forecastId:"constructor"}),{code:"INVALID_FORECAST"});
 setNow("2026-10-02T22:00:00Z");assert.deepEqual(service.record(input),registered);
 const restart=new ForecastEvaluationService({store:new ResearchStore({persistencePath:path}),candleStore,now:()=>Date.parse("2026-10-02T22:00:00Z")});assert.equal(restart.evaluate().sampleSize,1);
 const result=service.evaluate();assert.equal(result.status,"insufficient-evaluation");assert.equal(result.sampleSize,1);assert.ok(Math.abs(result.metrics.mae-0.01)<1e-10);assert.ok(Math.abs(result.metrics.meanObservedRelativeReturn-0.02)<1e-10);assert.ok(Math.abs(result.metrics.meanNetReturn-0.0394)<1e-10);assert.equal(result.metrics.brier,null);assert.equal(result.calibration,null);
 assert.throws(()=>service.evaluate({asOf:"2026-10-03T22:00:00Z"}),{code:"FUTURE_INFORMATION"});
 const historical=service.evaluate({asOf:"2026-10-01T22:00:00Z"});assert.equal(historical.sampleSize,0);assert.equal(historical.results[0].status,"pending-outcome");
 rows[0].close=99;assert.equal(service.evaluate().results[0].status,"data-revision-review-required");
});
test("only actual probabilities produce Brier; unknown costs and late outcomes remain explicit",()=>{
 const {service,input,rows,setNow}=setup();const direction={...input,target:"direction",direction:"up",predictedValue:undefined,costs:undefined,probability:0.8,probabilityModelVersion:"offline-prob-model"};
 assert.throws(()=>service.record({...direction,probabilityModelVersion:null}),{code:"INVALID_PROBABILITY"});service.record(direction);setNow("2026-10-02T22:00:00Z");rows[1].fetchedAt="2026-10-03T01:00:00Z";assert.equal(service.evaluate().results[0].status,"outcome-data-unavailable");rows[1].fetchedAt="2026-10-02T20:05:00Z";
 const result=service.evaluate();assert.ok(Math.abs(result.metrics.brier-0.04)<1e-10);assert.equal(result.results[0].netReturn,null);assert.equal(result.results[0].costReason,"cost-spread-slippage-not-specified");assert.equal(result.calibration,null);
});
test("walk forward purges overlapping horizons and outcomes unavailable at test origin",()=>{
 const rows=Array.from({length:42},(_,i)=>({forecastId:String(i),issuedAt:new Date(Date.UTC(2026,0,i+1)).toISOString(),expiresAt:new Date(Date.UTC(2026,0,i+4)).toISOString(),outcomeAt:new Date(Date.UTC(2026,0,i+4)).toISOString(),outcomeAvailableAt:new Date(Date.UTC(2026,0,i+5)).toISOString()}));const folds=purgedWalkForward(rows);assert.equal(folds.length,2);assert.ok(folds[0].purged>=3);assert.equal(folds[0].testIds[0],"30");assert.ok(folds.every(f=>f.trainIds.every(id=>Date.parse(rows[+id].outcomeAt)<Date.parse(f.testFrom)&&Date.parse(rows[+id].outcomeAvailableAt)<=Date.parse(f.testFrom))));
});
