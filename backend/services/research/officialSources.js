import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { AppError } from "../../utils/error.js";
import { safeUrl } from "../../utils/researchProjection.js";
import { stableHash } from "../../utils/stableHash.js";
import { parseFeedArticles } from "../news/providers/rssProvider.js";
import { getCompany, registerCompany } from "./companyIdentity.js";
import { registerInstruments, getInstrumentById } from "../market/instrumentRegistry.js";
const iso=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export function loadResearchSources(file) {
  if(!file)return [];
  const config=JSON.parse(readFileSync(file,"utf8"));
  for(const company of config.companies||[])registerCompany(company);
  registerInstruments(config.instruments||[]);
  if(!Array.isArray(config.sources)||config.sources.length>50)throw new Error("invalid-research-source-config");
  return config.sources.map(source=>{
    if(!/^[a-z0-9._-]{1,100}$/.test(source.sourceId||"")||!["sec-submissions","sec-companyfacts","rss","issuer-holdings-json"].includes(source.adapter))throw new Error("invalid-research-source-config");
    if(source.adapter.startsWith("sec-")&&!getCompany(source.companyId)?.cik)throw new Error("sec-company-cik-required");
    if(!source.adapter.startsWith("sec-")) { const url=new URL(source.url);if(url.protocol!=="https:"||url.username||url.password||url.port||isIP(url.hostname)||url.hostname==="localhost"||!source.allowedHosts?.includes(url.hostname))throw new Error("unapproved-research-source-host"); }
    return Object.freeze({...source,enabled:source.enabled===true});
  });
}
async function boundedBody(response,maxBytes) {
  if(Number(response.headers.get("content-length"))>maxBytes)throw new AppError("Fuente excede presupuesto.",413,"SOURCE_TOO_LARGE");
  const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>maxBytes)throw new AppError("Fuente excede presupuesto.",413,"SOURCE_TOO_LARGE");chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks).toString("utf8");
}
export class OfficialSourceService {
  constructor({store,eventLedger,sources=[],fetchImpl=fetch,now=Date.now,userAgent=null}={}){Object.assign(this,{store,eventLedger,sources,fetchImpl,now,userAgent});this.inFlight=null;}
  status(){return {sources:this.sources.map(s=>({sourceId:s.sourceId,adapter:s.adapter,enabled:s.enabled,companyId:s.companyId||null,instrumentId:s.instrumentId||null,admission:s.verifiedAt?"configured-with-evidence":"pending-verification",runtime:this.store.state.sourceStates[s.sourceId]||{status:"not-validated",lastSuccessAt:null}})),asOf:new Date(this.now()).toISOString(),warnings:["Configured adapters are not operational coverage until successful source reads; no paid provider activated."]};}
  async run({sourceIds,maxRequests=2}={}){if(this.inFlight)throw new AppError("Ingesta ya activa.",409,"SOURCE_BUSY");this.inFlight=this.execute(sourceIds,maxRequests);try{return await this.inFlight;}finally{this.inFlight=null;}}
  async execute(sourceIds,maxRequests){const ids=sourceIds||[];if(!ids.length||ids.length>4||ids.some(id=>!this.sources.some(s=>s.sourceId===id)))throw new AppError("Fuente no configurada.",400,"UNKNOWN_SOURCE");
    const results=[];for(const id of ids.slice(0,Math.min(4,maxRequests))){const source=this.sources.find(s=>s.sourceId===id);const previous=this.store.state.sourceStates[id];
      if(!source.enabled||!source.verifiedAt){results.push({sourceId:id,status:"pending-configuration"});continue;}
      if(previous?.nextEligibleAt&&Date.parse(previous.nextEligibleAt)>this.now()){results.push({sourceId:id,status:"cooldown",nextEligibleAt:previous.nextEligibleAt});continue;}
      if(source.adapter.startsWith("sec-")&&(!this.userAgent||!/@/.test(this.userAgent))) {results.push({sourceId:id,status:"blocked",reason:"SEC requires an identifying contact User-Agent."});continue;}
      const at=new Date(this.now()).toISOString();this.store.transact(state=>state.sourceStates[id]={...previous,status:"running",lastAttemptAt:at,nextEligibleAt:new Date(this.now()+Math.max(60000,source.minPollIntervalMs||300000)).toISOString()});
      const elapsed=Date.now()-(this.lastRequestWallTime||0); if(elapsed<250)await new Promise(resolve=>setTimeout(resolve,250-elapsed));this.lastRequestWallTime=Date.now();
      try {const company=getCompany(source.companyId);const url=source.adapter==="sec-submissions"?`https://data.sec.gov/submissions/CIK${company.cik}.json`:source.adapter==="sec-companyfacts"?`https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`:source.url;
        const response=await this.fetchImpl(url,{redirect:"error",signal:AbortSignal.timeout(10000),headers:{Accept:source.adapter==="rss"?"application/rss+xml, application/xml, text/xml":"application/json",...(this.userAgent?{"User-Agent":this.userAgent}:{})}});
        if(!response.ok){await response.body?.cancel();throw Object.assign(new Error("source-http"),{status:response.status});}
        const body=await boundedBody(response,Math.min(8388608,source.maxBytes||2097152));const parsed=source.adapter==="rss"?body:JSON.parse(body);let accepted=0;
        if(source.adapter==="rss") {const articles=parseFeedArticles(body,source.sourceId,{...source,contentPolicy:source.contentPolicy||"headline-only-link-out"}).slice(0,100);accepted=this.eventLedger.ingest(articles.map(a=>({...a,companyId:source.companyId||null,instrumentIds:source.instrumentIds||[],usagePolicy:source.contentPolicy||"headline-only-link-out"})),{official:true,sourceId:id,originGroup:source.originGroup||new URL(source.url).hostname}).accepted;}
        if(source.adapter==="sec-submissions") {if(String(parsed.cik).padStart(10,"0")!==company.cik)throw new Error("cik-mismatch");const recent=parsed.filings?.recent;if(!recent?.accessionNumber)throw new Error("invalid-sec-submissions");
          const items=recent.accessionNumber.slice(0,200).flatMap((accn,i)=>{const form=recent.form[i];if(!["10-K","10-Q","8-K","20-F","6-K","10-K/A","10-Q/A","8-K/A"].includes(form)||!/^\d{10}-\d{2}-\d{6}$/.test(accn))return [];
            const file=recent.primaryDocument?.[i];const path=file&&/^[A-Za-z0-9._-]+$/.test(file)?`/${file}`:"";
            return [{id:`sec-${accn}`,sourceEventId:accn,factKey:`sec:${accn}`,companyId:company.companyId,title:`${company.name}: ${form}`,publishedAt:iso(recent.acceptanceDateTime?.[i]),eventTime:null,receivedAt:at,kind:"regulatory-filing",url:`https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${accn.replaceAll("-","")}${path}`,usagePolicy:"headline-only-link-out",provider:"SEC",...(form.endsWith("/A")?{correctionOf:"amended-filing; original accession requires explicit linkage"}:{})}];});accepted=this.eventLedger.ingest(items,{official:true,sourceId:id,originGroup:`sec:${company.cik}`}).accepted;}
        if(source.adapter==="sec-companyfacts") {if(String(parsed.cik).padStart(10,"0")!==company.cik)throw new Error("cik-mismatch");const metrics=[];for(const concept of (source.concepts||[]).slice(0,20)){const [taxonomy,key]=concept.split(":");const fact=parsed.facts?.[taxonomy]?.[key];if(!fact)continue;for(const [unit,values] of Object.entries(fact.units||{}))metrics.push({concept,label:fact.label,unit,observations:values.slice(-100).map(v=>({value:v.val,start:v.start||null,end:v.end,accession:v.accn,form:v.form,filed:v.filed,fy:v.fy,fp:v.fp,frame:v.frame||null,availableAtBasis:"filed-date-only; intraday acceptance not joined"}))});}
          this.store.transact(state=>state.companyFacts[company.companyId]={companyId:company.companyId,cik:company.cik,fetchedAt:at,sourceUrl:url,metrics,coverage:"configured-concepts-and-last-100-observations-per-unit",methodVersion:"sec-companyfacts-context-v1"});accepted=metrics.length;}
        if(source.adapter==="issuer-holdings-json") {accepted=this.ingestHoldings(source,parsed,at);}
        this.store.transact(state=>state.sourceStates[id]={...state.sourceStates[id],status:"healthy",lastSuccessAt:at,accepted,validation:"source-response-read; not external attestation"});results.push({sourceId:id,status:"healthy",accepted});
      }catch(error){this.store.transact(state=>state.sourceStates[id]={...state.sourceStates[id],status:error.status===403?"blocked":error.status===429?"rate-limited":"error",failureCode:error.status?`HTTP_${error.status}`:"SOURCE_CONTRACT_OR_TRANSPORT_ERROR",nextEligibleAt:new Date(this.now()+(error.status===403?86400000:error.status===429?3600000:300000)).toISOString()});results.push({sourceId:id,status:this.store.state.sourceStates[id].status});}
    }return {results,asOf:new Date(this.now()).toISOString()};}
  ingestHoldings(source,data,at) {
    const instrument=getInstrumentById(source.instrumentId);if(instrument?.assetType!=="etf"||!instrument.isin||data.isin!==instrument.isin||data.instrumentId!==instrument.instrumentId||!iso(data.asOf)||Date.parse(data.asOf)>this.now()||!Array.isArray(data.holdings)||data.holdings.length>10000)throw new Error("invalid-dated-issuer-holdings");
    const holdings=data.holdings.map(h=>{if(typeof h.weight!=="number"||!Number.isFinite(h.weight)||h.weight<0||h.weight>1||!h.name)throw new Error("invalid-holding");return {name:String(h.name).slice(0,200),isin:h.isin||null,instrumentId:h.instrumentId||null,companyId:h.companyId||null,weight:h.weight,currency:h.currency||null};});const weightSum=holdings.reduce((s,h)=>s+h.weight,0);if(weightSum>1.02)throw new Error("invalid-holdings-total");
    const row={instrumentId:instrument.instrumentId,isin:instrument.isin,asOf:iso(data.asOf),fetchedAt:at,sourceUrl:safeUrl(source.url),issuer:source.issuer||null,holdings,weightSum,nav:typeof data.nav==="number"&&data.nav>0?data.nav:null,navCurrency:data.navCurrency||null,navAsOf:iso(data.navAsOf),ongoingCharge:typeof data.ongoingCharge==="number"&&data.ongoingCharge>=0&&data.ongoingCharge<1?data.ongoingCharge:null,costAsOf:iso(data.costAsOf),methodVersion:"dated-issuer-holdings-v1",quality:{partial:data.complete!==true,synthetic:false}};
    return this.store.transact(state=>{const prior=state.holdings[instrument.instrumentId];state.holdings[instrument.instrumentId]={...row,revisions:[...(prior?.revisions||[]),...(prior?[{asOf:prior.asOf,fetchedAt:prior.fetchedAt,weightSum:prior.weightSum}]:[])].slice(-20)};return holdings.length;});
  }
  holdings({instrumentId,limit=100,offset=0,snapshotId}) {
    const instrument=getInstrumentById(instrumentId);if(instrument?.assetType!=="etf")throw new AppError("Requiere identidad ETF verificada.",400,"INVALID_ETF_IDENTITY");
    const row=this.store.state.holdings[instrumentId];if(!row)return {instrumentId,holdings:null,missingReason:"no-dated-verified-issuer-holdings",quality:{coverage:"not-available"},warnings:["No se infieren holdings a partir del nombre del ETF."]};
    const revision=stableHash(row);if((offset>0&&!snapshotId)||(snapshotId&&snapshotId!==revision))throw new AppError("Snapshot de holdings ausente o cambiado; reiniciar desde offset cero.",409,"HOLDINGS_SNAPSHOT_CHANGED");
    const hasMore=row.holdings.length>offset+limit;
    return {...structuredClone(row),holdings:row.holdings.slice(offset,offset+limit),snapshotId:revision,offset,nextOffset:hasMore?offset+limit:null,hasMore,total:row.holdings.length};
  }
}
