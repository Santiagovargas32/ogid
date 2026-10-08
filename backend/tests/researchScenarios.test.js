import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaterialAlertStore } from "../services/research/materialAlertStore.js";
import { ScenarioService } from "../services/research/scenarioService.js";
const id="us-equity-nvidia";
function context(price=105,revision="r1",timestamp="2026-10-08T20:00:00Z") {return {instrumentId:id,snapshotId:revision,seriesRevision:revision,lastClosedCandleAt:timestamp,sampleSize:200,observed:{close:price},indicators:{levels:{value:{support:90,resistance:100}},atr14Wilder:{value:2},relativeVolume:{value:1}},quality:{reason:null,stale:false,synthetic:false}};}
test("persistent scenarios do not repeat transitions, corrections are audited and reads never acknowledge",()=>{
 let now=Date.parse("2026-10-08T22:00:00Z"),ctx=context();const path=join(mkdtempSync(join(tmpdir(),"ogid-scenarios-")),"alerts.json");
 const alerts=new MaterialAlertStore({persistencePath:path,now:()=>now});const service=new ScenarioService({alerts,technicalContext:{get:()=>ctx},eventLedger:{search:()=>({events:[]})},candleStore:{query:()=>[]},now:()=>now});
 assert.equal(service.refresh({instrumentIds:[id]}).changes,3);assert.equal(service.list().scenarios.find(s=>s.role==="favorable").status,"confirmed");
 assert.equal(service.refresh({instrumentIds:[id]}).changes,0);const before=alerts.research.sequence;
 const first=alerts.delta({consumerId:"test",limit:1,maxBytes:65536});assert.equal(first.changes.length,1);assert.equal(alerts.research.consumers.test,undefined);assert.equal(alerts.delta({consumerId:"test",limit:1,maxBytes:65536}).changes[0].changeId,first.changes[0].changeId);
 ctx=context(80,"r2","2026-10-08T20:05:00Z");now+=60000;service.refresh({instrumentIds:[id]});assert.equal(service.list().scenarios.find(s=>s.role==="favorable").status,"invalidated");assert.ok(alerts.research.sequence>before);
 // Snapshot continuation does not include concurrent changes.
 const next=alerts.delta({cursor:first.nextCursor,limit:100,maxBytes:65536});assert.equal(next.changes.length,2);assert.equal(next.throughSequence,before);
 const ack=alerts.acknowledgeChanges({consumerId:"test",checkpointCursor:next.checkpointCursor,expectedSequence:0});assert.equal(ack.sequence,before);assert.equal(ack.deliveryVerified,false);
 assert.throws(()=>alerts.acknowledgeChanges({consumerId:"test",checkpointCursor:next.checkpointCursor,expectedSequence:0}),e=>e.code==="CHECKPOINT_CONFLICT");
 const restored=new MaterialAlertStore({persistencePath:path,now:()=>now});assert.equal(restored.research.consumers.test.sequence,before);assert.equal(restored.delta({cursor:first.nextCursor,limit:100,maxBytes:65536}).changes.length,2);assert.ok(restored.delta({consumerId:"test",maxBytes:65536}).changes.length>0);
 ctx=context(106,"correction","2026-10-08T20:05:00Z");service.refresh({instrumentIds:[id]});const favorable=service.list().scenarios.find(s=>s.role==="favorable");assert.equal(favorable.status,"confirmed");assert.ok(favorable.revisions.some(r=>r.reason==="data-correction"));assert.equal(favorable.targetPrice,null);assert.equal(favorable.probability,null);
 service.remove({scenarioId:favorable.scenarioId,reason:"fixture removal"});assert.equal(alerts.research.changes.at(-1).kind,"scenario-deleted");
});
test("delta retention gap, expiry, byte budgets and filtered acknowledgement are explicit",()=>{
 let now=Date.parse("2026-10-08");const store=new MaterialAlertStore({now:()=>now,maxEntries:2});
 const add=n=>store.researchTransaction(s=>store.appendChange(s,{kind:"test",entityId:`e${n}`,revision:1,snapshot:{instrumentId:id,value:n}}));add(1);const first=store.delta({consumerId:"test"});add(2);add(3);
 assert.throws(()=>store.delta({consumerId:"test"}),e=>e.code==="CHANGE_RETENTION_GAP");
 const all=store.recoverCheckpoint({consumerId:"test",sequence:3,expectedSequence:0,reason:"snapshot reviewed"});assert.equal(all.recovery,true);assert.equal(store.delta({consumerId:"test"}).changes.length,0);
 now+=900001;assert.throws(()=>store.delta({cursor:first.checkpointCursor}),e=>e.code==="CURSOR_EXPIRED");
 const filtered=store.delta({consumerId:"test",instrumentIds:[id]});assert.throws(()=>store.acknowledgeChanges({consumerId:"test",checkpointCursor:filtered.checkpointCursor,expectedSequence:3}),e=>e.code==="FILTERED_CHECKPOINT_FORBIDDEN");
 const large=new MaterialAlertStore({now:()=>now});large.researchTransaction(s=>large.appendChange(s,{kind:"large",entityId:"e",revision:1,snapshot:{text:"x".repeat(10000)}}));
 assert.throws(()=>large.delta({consumerId:"test",maxBytes:4096}),e=>e.code==="SIGNAL_ITEM_TOO_LARGE");assert.equal(large.delta({consumerId:"test",maxBytes:65536}).changes.length,1);
});
test("missing usable candles creates pending-data; expiry never claims a financial outcome",()=>{
 let now=Date.parse("2026-10-08T22:00:00Z");const alerts=new MaterialAlertStore({now:()=>now});const ctx={...context(),quality:{reason:"insufficient_data",stale:true}};
 ctx.lastClosedCandleAt=null;const service=new ScenarioService({alerts,technicalContext:{get:()=>ctx},eventLedger:{search:()=>({events:[]})},candleStore:{query:()=>[]},now:()=>now});service.refresh({instrumentIds:[id]});assert.ok(service.list().scenarios.every(s=>s.status==="pending-data"));now+=60000;assert.equal(service.refresh({instrumentIds:[id]}).changes,0);now+=8*86400000;service.refresh({instrumentIds:[]});assert.ok(service.list().scenarios.every(s=>s.status==="expired"));assert.ok(service.list().scenarios.every(s=>s.probability===null));
});
test("configured benchmark detects relative-return anomaly with volatility normalization and hysteresis",()=>{
 const alerts=new MaterialAlertStore();const ctx=context(100);ctx.indicators.relativeReturn={value:0.05};const service=new ScenarioService({alerts,technicalContext:{get:args=>{assert.equal(args.benchmarkInstrumentId,id);return ctx;}},eventLedger:{search:()=>({events:[]})},candleStore:{query:()=>[]},policy:{benchmarkInstrumentId:id}});
 service.refresh({instrumentIds:[id]});const relative=Object.values(alerts.research.signals).find(s=>s.type==="relative-return-anomaly");assert.equal(relative.metric,2.5);assert.equal(relative.cause,"unknown");assert.equal(relative.active,true);
 ctx.indicators.relativeReturn.value=0.01;service.refresh({instrumentIds:[id]});assert.equal(alerts.research.signals[relative.signalId].active,false);
});
test("anomalies use closed observations and exclude a future open candle",()=>{
 const alerts=new MaterialAlertStore();const ctx=context(100);const candles=[{open:98,close:98,closeTime:"2026-10-07T20:00:00Z"},{open:99,close:100,closeTime:"2026-10-08T20:00:00Z"},{open:100,close:999,closeTime:"2026-10-09T20:00:00Z"}];
 const service=new ScenarioService({alerts,technicalContext:{get:()=>ctx},eventLedger:{search:()=>({events:[]})},candleStore:{query:()=>candles}});service.refresh({instrumentIds:[id]});assert.ok(!Object.values(alerts.research.signals).some(s=>s.type==="return-anomaly"||s.type==="gap-anomaly"));
});
