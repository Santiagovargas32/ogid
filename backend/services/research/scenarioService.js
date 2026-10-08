import { readFileSync } from "node:fs";
import { stableHash } from "../../utils/stableHash.js";
import { AppError } from "../../utils/error.js";
import { getInstrumentById } from "../market/instrumentRegistry.js";
export const SIGNAL_POLICY = Object.freeze({methodVersion:"scenario-signals-v1",breakoutAtr:0.25,anomalyAtr:1.5,relativeVolume:2,hysteresis:0.75,cooldownMs:1800000,expiryMs:7*86400000});
export function loadSignalPolicy(file) {
  if(!file)return {};
  const value=JSON.parse(readFileSync(file,"utf8"));
  const allowed=new Set([...Object.keys(SIGNAL_POLICY),"benchmarkInstrumentId"]);
  if(!value||Array.isArray(value)||Object.keys(value).some(k=>!allowed.has(k))||value.methodVersion!=null&&!/^[A-Za-z0-9._-]{1,80}$/.test(value.methodVersion))throw new Error("invalid-signal-policy-file");
  return value;
}
const roles=["favorable","central","adverse"];
const terminal=new Set(["invalidated","expired"]);
function compactContext(c){return {snapshotId:c.snapshotId,seriesRevision:c.seriesRevision,lastClosedCandleAt:c.lastClosedCandleAt,sampleSize:c.sampleSize,observed:c.observed,levels:c.indicators.levels,atr:c.indicators.atr14Wilder,relativeVolume:c.indicators.relativeVolume,relativeReturn:c.indicators.relativeReturn,benchmarkInstrumentId:c.benchmarkInstrumentId,quality:c.quality};}
export class ScenarioService {
  constructor({alerts,technicalContext,eventLedger,candleStore,now=Date.now,policy={}}={}){Object.assign(this,{alerts,technicalContext,eventLedger,candleStore,now});this.policy={...SIGNAL_POLICY,...policy};for(const key of ["breakoutAtr","anomalyAtr","relativeVolume","hysteresis","cooldownMs","expiryMs"])if(typeof this.policy[key]!=="number"||!Number.isFinite(this.policy[key])||this.policy[key]<=0)throw new Error("invalid-signal-policy");if(this.policy.hysteresis>=1)throw new Error("invalid-signal-hysteresis");}
  refresh({instrumentIds=[]}={}) {
    if(instrumentIds.length>50)throw new AppError("Universo demasiado grande.",400,"INVALID_INSTRUMENTS");
    const contexts=instrumentIds.map(id=>{if(!getInstrumentById(id))throw new AppError("Instrumento no verificado.",400,"UNRESOLVED_INSTRUMENT");return this.technicalContext.get({instrumentId:id,benchmarkInstrumentId:this.policy.benchmarkInstrumentId});});
    const at=new Date(this.now()).toISOString();
    return this.alerts.researchTransaction(state=>{
      let changes=0;
      for(const signal of Object.values(state.signals))if(signal.active&&signal.type==="event-review-candidate"&&this.eventLedger.isIdentityVerified&&!this.eventLedger.isIdentityVerified(signal.evidence?.eventId)){
        signal.active=false;signal.revision++;signal.generatedAt=at;signal.lastTransitionAt=at;signal.quality={...signal.quality,eventIdentityVerified:false};
        this.alerts.appendChange(state,{kind:"signal-transition",entityId:signal.signalId,revision:signal.revision,snapshot:signal,reason:"event-identity-requires-replay"});changes++;
      }
      for(const scenario of Object.values(state.scenarios))if(!terminal.has(scenario.status)&&Date.parse(scenario.expiresAt)<=this.now()){scenario.status="expired";scenario.updatedAt=at;scenario.revision++;this.alerts.appendChange(state,{kind:"scenario-transition",entityId:scenario.scenarioId,revision:scenario.revision,snapshot:scenario,reason:"horizon-expired"});changes++;}
      for(const ctx of contexts) {
        const valid=!ctx.quality.reason&&!ctx.quality.stale&&ctx.indicators.levels.value&&ctx.indicators.atr14Wilder.value>0&&typeof ctx.observed?.close==="number";
        const evidence=this.eventLedger.search({instrumentIds:[ctx.instrumentId],from:new Date(this.now()-7*86400000).toISOString(),limit:10}).events.map(e=>({eventId:e.eventId,claimId:e.claimId,revision:e.revision,claimStatus:e.claimStatus,mechanisms:e.impacts.flatMap(i=>i.mechanisms),evidenceIds:e.evidence.map(a=>a.id)}));
        const date=new Date(this.now());const weekday=(date.getUTCDay()+6)%7;date.setUTCDate(date.getUTCDate()-weekday);const cycle=date.toISOString().slice(0,10);
        for(const role of roles) {
          const id=`scenario-${stableHash([ctx.instrumentId,role,cycle]).slice(0,36)}`;const previous=state.scenarios[id];
          const correction=previous&&previous.context.lastClosedCandleAt===ctx.lastClosedCandleAt&&previous.context.seriesRevision!==ctx.seriesRevision;
          if(previous&&(previous.status==="expired"||previous.status==="invalidated"&&!correction))continue;
          const anchor=valid&&(!previous?.anchor||correction)?{...ctx.indicators.levels.value,atr:ctx.indicators.atr14Wilder.value,seriesRevision:ctx.seriesRevision}:previous?.anchor||null;
          let status=valid?"watch":"pending-data";
          if(valid&&anchor){const upper=anchor.resistance+this.policy.breakoutAtr*anchor.atr,lower=anchor.support-this.policy.breakoutAtr*anchor.atr,price=ctx.observed.close;
            if(role==="favorable")status=price>upper?"confirmed":price<lower?"invalidated":"watch";
            if(role==="adverse")status=price<lower?"confirmed":price>upper?"invalidated":"watch";
            if(role==="central")status=price>=lower&&price<=upper?"confirmed":"invalidated";
            if(previous?.status==="confirmed"&&status==="watch")status="confirmed";
          }
          const row={scenarioId:id,instrumentId:ctx.instrumentId,role,status,revision:(previous?.revision||0)+1,createdAt:previous?.createdAt||at,observedAt:ctx.lastClosedCandleAt||previous?.observedAt||at,generatedAt:previous?.generatedAt||at,updatedAt:at,expiresAt:previous?.expiresAt||new Date(this.now()+this.policy.expiryMs).toISOString(),horizon:{durationDays:this.policy.expiryMs/86400000,interval:"1day"},anchor,context:compactContext(ctx),evidence,
            mechanism:evidence.length?"Evidenced channels supplied as hypotheses; conditions below use observed price levels.":"Observed price condition; economic cause unknown.",confirmation:role==="favorable"?"Closed price > prior resistance + ATR buffer":role==="adverse"?"Closed price < prior support - ATR buffer":"Closed price within anchored support/resistance plus ATR buffer",invalidation:role==="favorable"?"Closed price < anchored support - ATR buffer":role==="adverse"?"Closed price > anchored resistance + ATR buffer":"Closed price outside anchored range",quality:ctx.quality,policy:this.policy,probability:null,targetPrice:null,deliveredAt:null,acknowledgedAt:null,
            meaning:"confirmed = observable conditions met, not a guaranteed future outcome",revisions:previous?.revisions||[]};
          const semantic=x=>stableHash({...x,revision:null,updatedAt:null,revisions:null});if(previous&&semantic(previous)===semantic(row))continue;
          if(previous)row.revisions=[...previous.revisions,{revision:previous.revision,status:previous.status,updatedAt:previous.updatedAt,seriesRevision:previous.context.seriesRevision,anchor:previous.anchor,reason:correction?"data-correction":"new-observation"}].slice(-20);
          state.scenarios[id]=row;this.alerts.appendChange(state,{kind:!previous||previous.status!==row.status?"scenario-transition":"scenario-revision",entityId:id,revision:row.revision,snapshot:row,reason:correction?"data-correction":!valid?"pending-usable-data":"closed-candle-observation"});changes++;
        }
        // Return/gap anomalies preserve unknown cause; no keyword-based causal claim.
        const bars=this.candleStore.query({instrumentId:ctx.instrumentId,interval:"1day",adjustmentMode:"splits",limit:5}).filter(c=>Date.parse(c.closeTime)<=Date.parse(ctx.lastClosedCandleAt)).slice(-2);const last=bars.at(-1),prior=bars.at(-2);const atr=ctx.indicators.atr14Wilder.value;
        const metrics={"return-anomaly":valid&&prior&&last?Math.abs(last.close-prior.close)/atr:null,"gap-anomaly":valid&&prior&&last?Math.abs(last.open-prior.close)/atr:null,"volume-anomaly":valid?ctx.indicators.relativeVolume.value:null,"relative-return-anomaly":valid&&ctx.indicators.relativeReturn?.value!=null?Math.abs(ctx.indicators.relativeReturn.value)/(atr/ctx.observed.close):null};
        for(const [type,metric]of Object.entries(metrics)){
          const id=`signal-${stableHash([ctx.instrumentId,type]).slice(0,36)}`;const previous=state.signals[id];const threshold=type==="volume-anomaly"?this.policy.relativeVolume:this.policy.anomalyAtr;
          if(metric==null)continue;const active=previous?.active?metric>=threshold*this.policy.hysteresis:metric>=threshold;
          if(active===Boolean(previous?.active)||active&&previous&&this.now()-Date.parse(previous.lastTransitionAt)<this.policy.cooldownMs)continue;
          const row={signalId:id,instrumentId:ctx.instrumentId,type,active,metric,threshold,revision:(previous?.revision||0)+1,observedAt:ctx.lastClosedCandleAt,generatedAt:at,lastTransitionAt:at,cause:"unknown",eventIds:evidence.map(e=>e.eventId),quality:ctx.quality,policy:this.policy,deliveredAt:null,acknowledgedAt:null};state.signals[id]=row;this.alerts.appendChange(state,{kind:"signal-transition",entityId:id,revision:row.revision,snapshot:row,reason:active?"threshold-crossed":"hysteresis-release"});changes++;
        }
        for(const event of evidence) {
          if(!["officially-reported","corroborated-independent-origins"].includes(event.claimStatus))continue;
          const id=`signal-${stableHash([ctx.instrumentId,event.eventId]).slice(0,36)}`;const previous=state.signals[id];if(previous?.eventRevision===event.revision)continue;
          const row={signalId:id,instrumentId:ctx.instrumentId,type:"event-review-candidate",active:true,eventRevision:event.revision,revision:(previous?.revision||0)+1,evidence:event,observedAt:at,generatedAt:at,cause:"financial-materiality-requires-review",quality:ctx.quality,deliveredAt:null,acknowledgedAt:null};state.signals[id]=row;this.alerts.appendChange(state,{kind:"material-evidence-revision",entityId:id,revision:row.revision,snapshot:row,reason:"confirmed-source-new-or-corrected-event"});changes++;
        }
      }return {changes,asOf:at,latestSequence:state.sequence,methodVersion:this.policy.methodVersion};
    });
  }
  list({instrumentIds=[],statuses=[],limit=20}={}) {const rows=Object.values(this.alerts.research.scenarios).filter(s=>(!instrumentIds.length||instrumentIds.includes(s.instrumentId))&&(!statuses.length||statuses.includes(s.status))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.scenarioId.localeCompare(b.scenarioId));return {scenarios:structuredClone(rows.slice(0,limit)),total:rows.length,hasMore:rows.length>limit,snapshotId:`scenarios-${this.alerts.research.sequence}`,latestSequence:this.alerts.research.sequence,asOf:new Date(this.now()).toISOString(),methodVersion:this.policy.methodVersion,warnings:["Scenario confirmation refers to conditions, never a guaranteed return.","No invented targets, capital weights or probabilities."]};}
  remove({scenarioId,reason}) {return this.alerts.researchTransaction(state=>{const row=state.scenarios[scenarioId];if(!row)throw new AppError("Escenario inexistente.",404,"SCENARIO_NOT_FOUND");delete state.scenarios[scenarioId];this.alerts.appendChange(state,{kind:"scenario-deleted",entityId:scenarioId,revision:row.revision+1,snapshot:{scenarioId,instrumentId:row.instrumentId,deletedAt:new Date(this.now()).toISOString()},reason});return {deleted:scenarioId,latestSequence:state.sequence};});}
}
