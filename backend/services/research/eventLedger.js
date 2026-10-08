import { stableHash } from "../../utils/stableHash.js";
import { permittedArticle, safeUrl } from "../../utils/researchProjection.js";
import { listVerifiedInstruments } from "../market/instrumentRegistry.js";
import { matchInstrument } from "./instrumentIdentity.js";
import { AppError } from "../../utils/error.js";
const norm=x=>String(x||"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
const iso=x=>typeof x==="string"&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;
// La URL de un calendario es contexto, nunca identidad de una publicación.
export function eventIdentity(item, article, fallbackSource) {
  const source = item.source?.sourceId || item.sourceId || fallbackSource;
  if (item.wireId) return ["wire", item.wireId];
  if (item.factKey) return ["fact", source, item.factKey];
  const id = item.sourceEventId || item.eventId || item.id;
  if (id) return ["source-publication", source, item.kind || "news-report", id];
  return ["metadata", source, item.kind || "news-report", norm(article.title), iso(item.scheduledAt || item.eventTime) || article.publishedAt || article.receivedAt.slice(0,10)];
}
const channels={revenue:/revenue|sales|earnings|results|ingresos|resultados/i,margins:/margin|profit|pricing|margen/i,cash:/cash flow|liquidity|dividend|caja/i,capex:/capex|capital expenditure|investment|inversi[oó]n/i,rates:/interest rate|federal reserve|ecb|tipos|bce/i,fx:/currency|foreign exchange|divisa/i,energy:/oil|gas|energy|petr[oó]leo/i,supply:/supply chain|supplier|suministro/i,regulation:/regulat|export control|export ban|sanction/i,contracts:/contract award|awarded .*contract|adjudicaci[oó]n/i};
export function comparableSurprise(actual,consensus,availableBefore) {
  if(!actual||!consensus) return {value:null,reason:"no_sourced_consensus"};
  if(!iso(availableBefore)||!safeUrl(consensus.sourceUrl)||!iso(consensus.observedAt)||Date.parse(consensus.observedAt)>=Date.parse(availableBefore||""))return {value:null,reason:"consensus_not_available_before_release"};
  if(!["unit","period","metric"].every(k=>actual[k]&&actual[k]===consensus[k])||typeof actual.value!=="number"||typeof consensus.value!=="number"||![actual.value,consensus.value].every(Number.isFinite))return {value:null,reason:"non_comparable_metric"};
  return {value:actual.value-consensus.value,unit:actual.unit,period:actual.period,metric:actual.metric,consensusObservedAt:consensus.observedAt,sourceUrl:safeUrl(consensus.sourceUrl),reason:null};
}
export class EventLedger {
  constructor({store,now=Date.now}={}){this.store=store;this.now=now;}
  isIdentityVerified(eventId){const e=this.store.state.events[eventId];return e?.identityVersion==="source-publication-v2"&&e.quality?.identityVerified!==false;}
  replayAwareness(snapshot,{dryRun=true,snapshotId=null}={}) {
    if(snapshot.mode!=="visible")throw new AppError("Awareness no está en modo público visible.",409,"AWARENESS_NOT_VISIBLE");
    const items=[...(snapshot.recent||[]),...(snapshot.upcoming||[])].slice(0,500).map(e=>({...e,url:e.canonicalUrl,eventTime:e.scheduledAt}));
    const expected=stableHash({revision:snapshot.revision,items});
    const mapping=items.map(item=>({sourceEventId:item.eventId,sourceId:item.source?.sourceId,eventId:`event-${stableHash(eventIdentity(item,permittedArticle(item,new Date(this.now()).toISOString()),"awareness")).slice(0,40)}`}));
    if(!dryRun&&snapshotId!==expected)throw new AppError("La agenda cambió; revisar de nuevo la vista previa.",409,"EVENT_REPLAY_SNAPSHOT_CHANGED");
    const result=dryRun?null:this.ingest(items,{sourceId:"awareness"});
    return {dryRun,snapshotId:expected,count:items.length,mapping,result,warnings:["Only the current admitted Awareness snapshot is replayed, up to 500 events. Older releases require original source archives.","Legacy rows and revisions remain for audit; no split is inferred from a shared URL."]};
  }
  ingest(items=[],{official=false,sourceId="archive",originGroup=null,allowFixtures=false}={}) {
    const accepted=items.filter(x=>!(x.synthetic||x.provenance?.synthetic||["synthetic","fallback","seeded"].includes(x.dataMode))&&(allowFixtures||x.environment!=="fixture")).slice(0,500);
    if(!accepted.length)return {accepted:0,changed:0};
    return this.store.transact(state=>{
      let changed=0;
      for(const item of accepted) {
        const article=permittedArticle(item,new Date(this.now()).toISOString());if(!article.title)continue;
        const identityKey=stableHash(eventIdentity(item,article,sourceId));
        const identityVerified=Boolean(item.wireId||item.factKey||item.sourceEventId||item.eventId||item.id||iso(item.scheduledAt||item.eventTime)||article.publishedAt);
        const eventId=`event-${identityKey.slice(0,40)}`;
        const previous=state.events[eventId];const now=new Date(this.now()).toISOString();const claimId=previous?.claimId||`claim-${stableHash([eventId,item.metric||"narrative"]).slice(0,40)}`;
        const evidenceId=`evidence-${stableHash([item.source?.sourceId||item.sourceId||sourceId,item.id||item.sourceEventId||item.eventId||identityKey]).slice(0,32)}`;
        const evidence={id:evidenceId,title:article.title,excerpt:article.excerpt,url:article.url,provider:article.provider||sourceId,sourceId:item.source?.sourceId||item.sourceId||sourceId,originGroup:item.wireId?`wire:${item.wireId}`:originGroup||"unverified-origin",official:official||item.source?.official===true,publishedAt:article.publishedAt,receivedAt:(previous?.evidence||[]).find(a=>a.id===evidenceId)?.receivedAt||article.receivedAt,revision:item.contentRevision||item.revision||1,usagePolicy:article.usagePolicy};
        const evidenceRows=[...(previous?.evidence||[]).filter(a=>a.id!==evidenceId),evidence].slice(-50);
        const verifiedGroups=new Set(evidenceRows.filter(a=>a.originGroup!=="unverified-origin").map(a=>a.originGroup));
        const sourceOfficial=evidenceRows.some(a=>a.official);
        const claimStatus=item.claimStatus==="rumor"?"rumor":sourceOfficial?"officially-reported":verifiedGroups.size>=2?"corroborated-independent-origins":"unconfirmed";
        const event={eventId,claimId,kind:item.kind||"news-report",companyId:item.companyId||previous?.companyId||null,sourceEventId:item.sourceEventId||item.eventId||previous?.sourceEventId||null,
          title:article.title,summary:article.excerpt,eventTime:iso(item.eventTime||item.scheduledAt),publishedAt:article.publishedAt,receivedAt:previous?.receivedAt||article.receivedAt,firstObservedAt:previous?.firstObservedAt||now,
          confirmedAt:claimStatus==="officially-reported"||claimStatus==="corroborated-independent-origins"?previous?.confirmedAt||now:null,updatedAt:now,claimStatus,evidence:evidenceRows,independentOriginCount:verifiedGroups.size,corroborationMethod:"declared-origin-chain-v1; unknown origins never independent",instrumentIds:[...new Set([...(previous?.instrumentIds||[]),...(item.instrumentIds||[])])],
          identityKey,identityVersion:"source-publication-v2",correctionOf:item.correctionOf||previous?.correctionOf||null,revision:(previous?.revision||0)+1,surprise:comparableSurprise(item.actual,item.consensus,article.publishedAt),quality:{synthetic:false,publicationTimeKnown:Boolean(article.publishedAt),official:sourceOfficial,coverage:"collected-metadata-only",identityVerified},methodVersion:"event-ledger-v2"};
        const semantic=e=>stableHash({...e,updatedAt:null,revision:null,revisions:null});
        if(previous&&semantic(previous)===semantic(event))continue;
        event.revisions=[...(previous?.revisions||[]),...(previous?[{revision:previous.revision,updatedAt:previous.updatedAt,title:previous.title,summary:previous.summary,claimStatus:previous.claimStatus,evidenceRevision:stableHash(previous.evidence)}]:[])].slice(-20);
        state.events[eventId]=event;changed++;
      }return {accepted:accepted.length,changed,revision:state.revision+1};
    });
  }
  impact(event,instruments) {
    if(event.identityVersion!=="source-publication-v2"||event.quality?.identityVerified===false)return [];
    return instruments.flatMap(instrument=>{
      const direct=event.instrumentIds.includes(instrument.instrumentId)||event.companyId&&event.companyId===instrument.companyId;
      const match=direct?{kind:"direct",method:"verified-entity-or-instrument-link",evidence:instrument.instrumentId}:event.evidence.map(a=>matchInstrument({...a,instrumentIds:event.instrumentIds},instrument)).find(Boolean);
      if(!match)return [];
      const text=`${event.title} ${event.summary||""}`;const mechanisms=Object.entries(channels).filter(([,pattern])=>pattern.test(text)).map(([channel])=>({channel,direction:"unknown",evidenceIds:event.evidence.map(a=>a.id),method:"explicit-topic-channel-candidate-v1",reason:"Direction and financial materiality require comparable facts."}));
      return [{instrumentId:instrument.instrumentId,companyId:instrument.companyId||null,match,mechanisms:mechanisms.length?mechanisms:[{channel:"unknown",direction:"unknown",reason:"No evidenced economic channel."}],materiality:{band:event.quality.official&&mechanisms.some(x=>["revenue","regulation","contracts"].includes(x.channel))?"review-required":"unknown",methodVersion:"evidence-channel-v1"}}];
    });
  }
  search({instrumentIds=[],eventIds=[],from,to,limit=20}={}) {
    const instruments=instrumentIds.length?instrumentIds.map(id=>listVerifiedInstruments().find(i=>i.instrumentId===id)):listVerifiedInstruments();if(instruments.some(x=>!x))throw new AppError("Instrumento no resuelto.",400,"UNRESOLVED_INSTRUMENT");
    const events=Object.values(this.store.state.events).filter(e=>(!eventIds.length||eventIds.includes(e.eventId))&&(!from||Date.parse(e.updatedAt)>=Date.parse(from))&&(!to||Date.parse(e.updatedAt)<=Date.parse(to))).map(e=>({...structuredClone(e),quality:{...e.quality,identityVerified:this.isIdentityVerified(e.eventId),...(!this.isIdentityVerified(e.eventId)?{identityReason:e.identityVersion!=="source-publication-v2"?"legacy_identity_requires_replay":"publication_identity_insufficient"}:{})},impacts:this.impact(e,instruments)})).filter(e=>!instrumentIds.length||e.impacts.length).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.eventId.localeCompare(b.eventId));
    return {events:events.slice(0,limit),total:events.length,hasMore:events.length>limit,asOf:new Date(this.now()).toISOString(),snapshotId:`events-${this.store.state.revision}`,methodVersion:"event-ledger-v2",coverage:{storedEvents:Object.keys(this.store.state.events).length,legacyRequiresReplay:Object.values(this.store.state.events).filter(e=>e.identityVersion!=="source-publication-v2").length,continuity:"not-guaranteed",revisionHistoryLimit:20,evidenceLimit:50},warnings:["Legacy URL-based event IDs require replay from original sources; excluded from impacts, preserved for audit.","Republished wires are one origin; unknown provenance cannot establish corroboration.","A topic or named company does not establish benefit, contract award or price causality."]};
  }
}
