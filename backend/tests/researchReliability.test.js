import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tradingDay, cashCalendarSchedule, expectedIntradayGapCount, expectedDailyGaps } from "../services/market/exchangeCalendar.js";
import { normalizeCanonicalCandle } from "../services/market/canonicalCandle.js";
import { TechnicalIndicatorService } from "../services/market/technicalIndicatorService.js";
import { simpleReturn, calculateTechnicalIndicators } from "../services/market/technicalIndicators.js";
import { getInstrumentByCanonicalSymbol } from "../services/market/instrumentRegistry.js";
import { NewsArchive } from "../services/research/newsArchive.js";
import { projectOperation } from "../utils/researchProjection.js";
import { getOperation } from "../contracts/ogidOperations.js";
const us = getInstrumentByCanonicalSymbol("NVDA");
test("historical mourning and Ferragosto closures do not block continuous daily indicators",()=>{
  for(const mic of ["XNAS","XNYS","ARCX","XASE"]){const day=tradingDay({mic},"2025-01-09");assert.equal(day.closed,true);assert.equal(day.openTime,null);assert.equal(day.historicalClosure.reason,"national-day-of-mourning");assert.ok(day.sources.some(url=>url.includes("ETA2025-1")));}
  const at=date=>({openTime:`${date}T12:00:00Z`});
  assert.deepEqual(expectedDailyGaps([at("2025-01-08"),at("2025-01-10")],us),[]);
  for(const date of ["2024-08-15","2025-08-15"]){assert.equal(tradingDay({mic:"XMIL"},date).closed,true);assert.equal(tradingDay({mic:"XAMS"},date).closed,false);}
  assert.deepEqual(expectedDailyGaps([at("2025-08-14"),at("2025-08-18")],{mic:"XMIL",timezone:"Europe/Rome"}),[]);
  assert.deepEqual(expectedDailyGaps([at("2025-01-06"),at("2025-01-08")],us),["2025-01-07"]);
  const records=["2025-01-07","2025-01-08","2025-01-10"].map((date,i)=>({instrumentId:us.instrumentId,interval:"1day",openTime:tradingDay(us,date).openTime,closeTime:tradingDay(us,date).closeTime,open:100+i,high:102+i,low:99+i,close:101+i,source:"fixture",currency:"USD",adjusted:true,provenance:{adjustmentMode:"splits"}}));
  const result=calculateTechnicalIndicators(records,{interval:"1day",instrument:us});assert.equal(result.quality.gapDetected,false);assert.equal(result.indicators.simpleReturn.reason,null);
});
test("calendars: US holiday, early close, DST divergence and European venue hours",()=>{
  assert.equal(tradingDay(us,"2026-07-03").closed,true);
  assert.equal(tradingDay(us,"2026-11-27").closeTime,"2026-11-27T18:00:00.000Z");
  assert.equal(tradingDay(us,"2026-03-06").openTime,"2026-03-06T14:30:00.000Z");
  assert.equal(tradingDay(us,"2026-03-09").openTime,"2026-03-09T13:30:00.000Z");
  const ams={mic:"XAMS",timezone:"Europe/Amsterdam"};
  assert.equal(tradingDay(ams,"2026-03-09").openTime,"2026-03-09T08:00:00.000Z");
  assert.equal(tradingDay(ams,"2026-03-30").openTime,"2026-03-30T07:00:00.000Z");
  assert.equal(tradingDay(ams,"2026-04-06").closed,true);
  assert.equal(tradingDay(ams,"2026-12-24").halfDayPending,true);
  assert.equal(tradingDay({mic:"XETR"},"2026-10-08").closeTime,"2026-10-08T15:30:00.000Z");
  assert.equal(cashCalendarSchedule(us,"2026-11-27T19:00:00Z").eligible,false);
  assert.equal(cashCalendarSchedule(us,"2026-11-27T19:00:00Z").expectedLatestCandleAt,"2026-11-27T18:00:00.000Z");
  assert.equal(cashCalendarSchedule(us,"2026-10-08T12:00:00Z").sessionPhase,"premarket");
  assert.equal(tradingDay(us,"2025-01-02").partial,true);
  const candle=openTime=>({openTime});
  assert.equal(expectedIntradayGapCount(candle("2026-07-02T19:55:00Z"),candle("2026-07-06T13:30:00Z"),us,300000),0);
  assert.equal(expectedIntradayGapCount(candle("2026-07-02T19:50:00Z"),candle("2026-07-06T13:35:00Z"),us,300000),2);
  assert.equal(expectedIntradayGapCount(candle("2026-10-06T19:55:00Z"),candle("2026-10-08T13:30:00Z"),us,300000),78);
  assert.deepEqual(expectedDailyGaps([candle("2026-10-02T00:00:00Z"),candle("2026-10-05T00:00:00Z")],{timezone:"UTC",sessionPolicy:"24x7"}),["2026-10-03","2026-10-04"]);
  const cryptoBars=bars().slice(0,2).map((c,i)=>({...c,interval:"5min",openTime:i?"2026-10-08T00:05:00Z":"2026-10-07T23:55:00Z"}));assert.equal(calculateTechnicalIndicators(cryptoBars,{interval:"5min",instrument:{timezone:"UTC",sessionPolicy:"24x7"}}).quality.gapDetected,true);
});
function bars(){ return Array.from({length:30},(_,i)=>({ instrumentId:us.instrumentId, interval:"1day", openTime:new Date(Date.UTC(2026,0,i+1,14,30)).toISOString(),closeTime:new Date(Date.UTC(2026,0,i+1,21)).toISOString(),open:100+i,high:110+i,low:90+i,close:101+i,volume:100,source:"fixture",currency:"USD",adjusted:true,dataMode:"observed" })); }
test("correction/backfill with identical last timestamp invalidates full-series cache; limits and memory bounded",()=>{
  let series=bars();const service=new TechnicalIndicatorService({store:{query:({limit})=>series.slice(-limit)},now:()=>new Date("2026-06-01"),maxCacheEntries:2});
  const a=service.calculate({instrumentId:us.instrumentId});
  series[15]={...series[15],close:110};const b=service.calculate({instrumentId:us.instrumentId});
  assert.equal(a.lastCandleAt,b.lastCandleAt);assert.notEqual(a.seriesRevision,b.seriesRevision);assert.notEqual(a.indicators.sma.value,b.indicators.sma.value);
  assert.equal(service.calculate({instrumentId:us.instrumentId}),b);
  const c=service.calculate({instrumentId:us.instrumentId,limit:15});assert.equal(c.sampleSize,15);assert.equal(service.cache.size,2);
});
test("null and synthetic candles never become numeric observations",()=>{
  assert.equal(simpleReturn(null,12).value,null);
  const raw={instrumentId:us.instrumentId,interval:"1day",date:"2026-10-08",open:null,high:12,low:0,close:10,volume:3};
  assert.equal(normalizeCanonicalCandle(raw,{instrument:us}).valid,false);
  assert.equal(normalizeCanonicalCandle({...raw,open:10,openTime:"invalid",closeTime:"invalid"},{instrument:us}).valid,false);
  assert.equal(normalizeCanonicalCandle({...raw,open:10,synthetic:true},{instrument:us}).valid,false);
  const lastHour=normalizeCanonicalCandle({...raw,open:10,interval:"1h",openTime:"2026-10-08T19:30:00Z",closeTime:"2026-10-08T20:30:00Z"},{instrument:us});assert.equal(lastHour.candle.closeTime,"2026-10-08T20:00:00.000Z");
  const series=bars();series[1].dataMode="synthetic";assert.equal(calculateTechnicalIndicators(series,{interval:"1day"}).indicators.sma.reason,"synthetic_series");
  series[1].dataMode="observed";series[2].currency="EUR";assert.equal(calculateTechnicalIndicators(series,{interval:"1day"}).indicators.sma.reason,"incompatible_series");
});
test("semantic cursor filters, concurrent arrival, restart and expiry preserve bounded snapshots",()=>{
  let now=Date.parse("2026-10-08T12:00:00Z");const path=join(mkdtempSync(join(tmpdir(),"ogid-news-")),"news.json");
  const archive=new NewsArchive({persistencePath:path,now:()=>now,cursorTtlMs:1000});
  const item=(i)=>({title:`NVIDIA earnings ${i}`,url:`https://example.org/${i}`,provider:"rss",publishedAt:"2026-10-08T11:00:00Z"});
  archive.ingest([item(1),item(2),item(3)]);
  const first=archive.search({symbols:["NVDA"],providers:["rss"],limit:1});
  archive.ingest([item(4)]);
  const next=archive.search({cursor:first.nextCursor,limit:1,providers:["rss"],symbols:["nvda"],timeField:"publishedAt"});
  assert.equal(next.total,3);assert.notEqual(next.articles[0].id,first.articles[0].id);
  assert.equal(archive.search({cursor:next.nextCursor,limit:1}).total,3);
  assert.throws(()=>archive.search({cursor:first.nextCursor,q:"different"}),e=>e.code==="CURSOR_FILTER_MISMATCH");
  const restored=new NewsArchive({persistencePath:path,now:()=>now});assert.equal(restored.search().total,4);
  assert.throws(()=>restored.search({cursor:first.nextCursor}),e=>e.code==="CURSOR_EXPIRED");
  now+=2000;assert.throws(()=>archive.search({cursor:first.nextCursor}),e=>e.code==="CURSOR_EXPIRED");
});
test("quote MCP projection omits legacy global series and large unrequested objects",()=>{
  const data={tickers:["NVDA"],quotes:{NVDA:{price:12,changePct:1}},timeseries:{NVDA:Array(10000).fill(1)},market:{timeseries:{OTHER:Array(10000).fill(2)}}};
  const out=projectOperation(getOperation("market.quotes"),data);assert.equal(out.market,undefined);assert.equal(out.timeseries,undefined);assert.ok(Buffer.byteLength(JSON.stringify(out))<4096);
});
