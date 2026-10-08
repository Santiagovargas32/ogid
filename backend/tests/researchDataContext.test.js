import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchStore } from "../services/research/researchStore.js";
import { HistoricalAcquisitionService } from "../services/market/historicalAcquisitionService.js";
import { TechnicalContextService, aggregateWeekly, wilderAtr } from "../services/market/technicalContextService.js";
import { EventLedger, comparableSurprise } from "../services/research/eventLedger.js";
import { OfficialSourceService } from "../services/research/officialSources.js";
import { registerCompany } from "../services/research/companyIdentity.js";
import { getInstrumentByCanonicalSymbol, registerInstrument } from "../services/market/instrumentRegistry.js";
import { tradingDay, addDate } from "../services/market/exchangeCalendar.js";
const instrument=getInstrumentByCanonicalSymbol("NVDA");
const now=Date.parse("2026-10-08T22:00:00Z");
function daily(){const bars=[];for(let date="2025-10-01",i=0;date<="2026-10-08";date=addDate(date,1)){const day=tradingDay(instrument,date);if(day.closed)continue;bars.push({instrumentId:instrument.instrumentId,interval:"1day",openTime:day.openTime,closeTime:day.closeTime,open:100+i,high:102+i,low:99+i,close:101+i,volume:100+i,source:"fixture",currency:"USD",adjusted:true,dataMode:"observed",quality:"valid",calendar:day,provenance:{adjustmentMode:"splits"}});i++;}return bars;}
test("standard technical context: long warmup, Wilder version, weekly closed frames and benchmark alignment",()=>{
 const bars=daily();const store={query:({limit})=>bars.slice(-limit)};const service=new TechnicalContextService({store,now:()=>new Date(now)});
 const out=service.get({instrumentId:instrument.instrumentId,benchmarkInstrumentId:instrument.instrumentId});
 assert.ok(out.sampleSize>200);assert.ok(out.indicators.sma200.value>0);assert.equal(out.indicators.relativeStrength.value,0);assert.equal(out.indicators.atr14Wilder.method,"wilder-rma-sma-seed-v1");assert.equal(out.indicators.atr14Simple.method,"simple-mean-true-range-v1");assert.equal(out.indicators.volatility.annualizationFactor,252);
 const weekly=service.get({instrumentId:instrument.instrumentId,interval:"1wk"});assert.ok(weekly.sampleSize>40);assert.ok(Date.parse(weekly.lastClosedCandleAt)<=now);assert.equal(weekly.indicators.sma20.reason,null);assert.equal(weekly.indicators.sma200.reason,"insufficient_data");assert.equal(weekly.indicators.volatility.annualizationFactor,52);
 const prefix=aggregateWeekly(bars.slice(0,-4),instrument,new Date(now-7*86400000).toISOString());assert.ok(prefix.every(c=>Date.parse(c.closeTime)<=now-7*86400000));
 const short=new TechnicalContextService({store:{query:()=>bars.slice(-3)},now:()=>new Date(now)}).get({instrumentId:instrument.instrumentId});assert.equal(short.indicators.sma200.value,null);
 const changed=bars.slice(-20).map((c,i)=>({...c,high:c.high+(i===1?40:0)}));assert.notEqual(wilderAtr(changed).value,out.indicators.atr14Wilder.value);
});
test("history jobs are bounded, reentrant, resumable, idempotent and retain failed windows",async()=>{
 const path=join(mkdtempSync(join(tmpdir(),"ogid-jobs-")),"ledger.json");let clock=now,calls=0,fail=false;
 const ledger=new ResearchStore({persistencePath:path});const provider={async fetchYahooBars(_symbol,options){calls++;assert.ok(Date.parse(options.to)-Date.parse(options.from)<=181*86400000);if(fail)throw Object.assign(new Error("fixture"),{code:"YAHOO_RATE_LIMIT"});return {complete:true,stale:false,persistence:{inserted:1}};}};
 const args={requestId:"fixture-job",instrumentIds:[instrument.instrumentId],targetBars:500,endAt:new Date(now).toISOString()};
 const service=new HistoricalAcquisitionService({ledger,marketDataService:provider,candleStore:{query:()=>[]},now:()=>clock});const first=service.create(args);assert.equal(service.create(args).jobId,first.jobId);assert.throws(()=>service.create({...args,targetBars:600}),e=>e.code==="IDEMPOTENCY_CONFLICT");
 const page=await service.run({jobId:first.jobId,maxRequests:1});assert.equal(calls,1);assert.equal(page.cursor,1);
 const restored=new ResearchStore({persistencePath:path});const resumed=new HistoricalAcquisitionService({ledger:restored,marketDataService:provider,candleStore:{query:()=>[]},now:()=>clock});fail=true;
 const error=await resumed.run({jobId:first.jobId,maxRequests:4});assert.equal(error.cursor,1);assert.equal(error.status,"retry");const before=calls;await resumed.run({jobId:first.jobId});assert.equal(calls,before);clock+=120000;fail=false;
 const done=await resumed.run({jobId:first.jobId,maxRequests:4});assert.equal(done.status,"completed");assert.equal(done.coverage[0].goalMet,false);assert.equal(done.requestsThisRun,4);
});
test("events: wire duplicates share one origin, corrected facts retain revision and rumor is unconfirmed",()=>{
 const path=join(mkdtempSync(join(tmpdir(),"ogid-events-")),"ledger.json");const store=new ResearchStore({persistencePath:path});const ledger=new EventLedger({store,now:()=>now});
 const item={id:"a",wireId:"dispatch-1",title:"NVIDIA earnings and capex",url:"https://example.org/a",publishedAt:"2026-10-08T12:00:00Z",provider:"rss"};
 ledger.ingest([item,{...item,id:"b",url:"https://example.org/b"}],{originGroup:"same-wire"});let result=ledger.search({instrumentIds:[instrument.instrumentId]});assert.equal(result.total,1);assert.equal(result.events[0].independentOriginCount,1);assert.equal(result.events[0].claimStatus,"unconfirmed");assert.ok(result.events[0].impacts[0].mechanisms.some(m=>m.channel==="capex"));assert.ok(result.events[0].impacts[0].mechanisms.every(m=>m.direction==="unknown"));
 const revision=result.events[0].revision;ledger.ingest([{...item,title:"NVIDIA corrected earnings",claimStatus:"rumor"}]);result=ledger.search();assert.equal(result.events[0].revision,revision+1);assert.equal(result.events[0].claimStatus,"rumor");assert.ok(result.events[0].revisions.length);
 const restart=new EventLedger({store:new ResearchStore({persistencePath:path}),now:()=>now});assert.equal(restart.search().events[0].eventId,result.events[0].eventId);
 ledger.ingest([{...item,id:"synthetic",wireId:"fake",synthetic:true}]);assert.equal(ledger.search().total,1);
 assert.equal(comparableSurprise({value:5,unit:"USD",period:"Q1",metric:"eps"},{value:4,unit:"EUR",period:"Q1",metric:"eps",sourceUrl:"https://example.org",observedAt:"2026-10-08T10:00:00Z"},"2026-10-08T12:00:00Z").reason,"non_comparable_metric");
 assert.equal(comparableSurprise(null,null).value,null);
});
test("SEC configurable adapter enforces identifying User-Agent, bounds requests, preserves facts and cooldown",async()=>{
 const company=registerCompany({companyId:"fixture-company",name:"Fixture Company",cik:"0000000001",metadataSource:{url:"https://www.sec.gov/example",verifiedAt:"2026-10-08"}});
 const store=new ResearchStore();const events=new EventLedger({store,now:()=>now});let calls=0;
 const source={sourceId:"fixture-sec",adapter:"sec-submissions",companyId:company.companyId,enabled:true,verifiedAt:"2026-10-08"};
 const fetchImpl=async(url,opts)=>{calls++;assert.match(url,/CIK0000000001.json$/);assert.match(opts.headers["User-Agent"],/@/);return new Response(JSON.stringify({cik:1,filings:{recent:{accessionNumber:["0000000001-26-000001"],form:["10-Q"],acceptanceDateTime:["2026-10-08T12:00:00Z"],primaryDocument:["report.htm"]}}}),{headers:{"content-type":"application/json"}});};
 const service=new OfficialSourceService({store,eventLedger:events,sources:[source],fetchImpl,now:()=>now});assert.equal((await service.run({sourceIds:[source.sourceId]})).results[0].status,"blocked");assert.equal(calls,0);service.userAgent="Fixture fixture@example.org";
 assert.equal((await service.run({sourceIds:[source.sourceId]})).results[0].accepted,1);assert.equal(events.search().events[0].claimStatus,"officially-reported");await service.run({sourceIds:[source.sourceId]});assert.equal(calls,1);
});
test("ETF holdings require dated issuer evidence and preserve ISIN-specific weights",()=>{
 const etf=registerInstrument({...getInstrumentByCanonicalSymbol("QQQ"),instrumentId:"fixture-etf-dated",canonicalSymbol:"FIXETF.DE",aliases:[],providerSymbols:{yahoo:"FIXETF.DE"},isin:"IE0000000001",companyId:null,assetType:"etf"});
 const store=new ResearchStore();const service=new OfficialSourceService({store,now:()=>now});assert.equal(service.holdings({instrumentId:etf.instrumentId}).holdings,null);
 const source={instrumentId:etf.instrumentId,url:"https://example.org/issuer",issuer:"Fixture"};const data={instrumentId:etf.instrumentId,isin:etf.isin,asOf:"2026-10-07",holdings:[{name:"Fixture asset",weight:0.5}],complete:false};
 assert.equal(service.ingestHoldings(source,data,new Date(now).toISOString()),1);assert.equal(service.holdings({instrumentId:etf.instrumentId}).quality.partial,true);
 assert.throws(()=>service.ingestHoldings(source,{...data,isin:"wrong"},new Date(now).toISOString()));
});
