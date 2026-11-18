import {randomUUID} from 'node:crypto';
import {CycleContinuations} from './cycleContinuations.js';
import {readMeta,writeMeta} from './sqlRepositories.js';
import {stableHash} from '../utils/stableHash.js';
import {AppError} from '../utils/error.js';

export const MARKET_PRESENTATION_SCOPE='market:presentation';
export const MARKET_FRAME='market-presentation-frame-v1';
const resultKind='market-presentation-result-v1';

export function visibleSourceAdmission(db){
  // A source can leave the public view without changing an event revision.
  const states=db.prepare("SELECT source_id,json_extract(payload_json,'$.admissionState') AS admission FROM awareness_source_status ORDER BY source_id").all();
  return stableHash(states);
}

function revisions(db,mode){
  const news=readMeta(db,'news.meta',{}).revision || 0;
  if(mode!=='visible')return {news,awareness:null,admission:null};
  return {news,awareness:readMeta(db,'awareness.revision',0),admission:visibleSourceAdmission(db)};
}

function mismatch(){
  throw new AppError('Entrada de presentación de mercado incompatible.',409,'CONTINUATION_EFFECT_MISMATCH');
}

// Called synchronously inside the snapshot/quote writer transaction. The
// singleton holds only the newest market frame. Older jobs keep their receipts.
export function captureMarketPresentation(runtime,frame){
  const {db}=runtime, {jobId,market,analysis}=frame;
  if(!market?.revision || !analysis?.newsFromStorage || analysis.articles || analysis.marketQuotes
      || !Number.isFinite(Date.parse(analysis.asOf)) || !Array.isArray(analysis.tickers)) mismatch();
  const ledger=new CycleContinuations(db), mode=analysis.corpusOptions.awarenessMode;
  const basis=revisions(db,mode);
  const watermark=db.prepare('SELECT coalesce(max(rowid),0) AS n FROM article_revisions').get().n;
  const descriptor={kind:'market-presentation-v1',marketRevision:market.revision,asOf:analysis.asOf,
    newsMode:mode,frameHash:stableHash(frame),basis,watermark};
  const current=ledger.scope({scope:MARKET_PRESENTATION_SCOPE});
  if(current && current.jobId!==jobId){
    // Only the writer publishing the replacement frame can preempt this scope.
    // Invalidating its fence also prevents a late calculation from committing.
    const old=ledger.row(current.jobId);
    old.status='complete';
    Object.assign(old.descriptor,{phase:'superseded',cursor:old.descriptor.cursor+1,owner:null,
      leaseUntil:0,fence:old.descriptor.fence+1,input:{...old.descriptor.input,replacedBy:jobId}});
    old.descriptor.inputHash=stableHash(old.descriptor.input);
    ledger.save(old);
  }
  const job=ledger.admit({jobId,scope:MARKET_PRESENTATION_SCOPE,phase:'projection',input:descriptor});
  if(job.status!=='pending')mismatch();
  runtime.save(MARKET_FRAME,frame);
  writeMeta(db,'market.presentation.latest',jobId);
  return job;
}

export function finishMarketPresentation(runtime,{auth,projection,reason=null}){
  const {db}=runtime,ledger=new CycleContinuations(db);
  return db.transaction(()=>{
    const job=ledger.get(auth);
    if(job.scope!==MARKET_PRESENTATION_SCOPE)mismatch();
    if(job.phase==='superseded')return {job};
    const transitionId='present-'+auth.cursor;
    if(job.status==='complete'){
      if(job.lastTransition?.id!==transitionId)mismatch();
      if(job.input.resultHash!==stableHash(projection ?? null) || job.input.requestedReason!==reason)mismatch();
      return {job:ledger.advance({...auth,phase:job.phase,input:job.input,complete:true,transitionId})};
    }
    if(job.phase!=='projection')mismatch();
    const {basis,newsMode,asOf,watermark}=job.input;
    const coverage=projection?.newsCoverage;
    let outcome=reason;
    if(!outcome && (stableHash(revisions(db,newsMode))!==stableHash(basis) || coverage?.revision!==basis.news
      || coverage?.awarenessRevision!==basis.awareness || coverage?.awarenessAdmission!==basis.admission || coverage?.asOf!==asOf
      || coverage?.inputManifest?.revisionWatermark!==watermark))outcome='revisions-changed';
    if(!outcome && (!projection?.impact || !projection?.predictions || !Array.isArray(projection.insights)))mismatch();
    const phase=outcome?'discarded':'published';
    const input={...job.input,resultHash:stableHash(projection ?? null),requestedReason:reason,outcome:outcome || 'published'};
    return {job:ledger.advance({...auth,phase,input,complete:true,transitionId},()=>{
      if(!outcome)runtime.save(resultKind,{jobId:job.jobId,projection});
    })};
  }).immediate();
}

// A consistent read also handles a crash between the commit and WS delivery.
export function readMarketPresentation(runtime,{withFrame=true}={}){
  return runtime.db.transaction(()=>{
    const jobId=readMeta(runtime.db,'market.presentation.latest',null);
    if(!jobId)return null;
    const job=new CycleContinuations(runtime.db).get({jobId});
    const frame=withFrame?runtime.load(MARKET_FRAME):null;
    if(withFrame && (!frame || frame.jobId!==jobId || stableHash(frame)!==job.input.frameHash))mismatch();
    const current=stableHash(revisions(runtime.db,job.input.newsMode))===stableHash(job.input.basis);
    const result=withFrame && current && job.phase==='published'?runtime.load(resultKind):null;
    return {job,current,...(withFrame?{frame,projection:result?.jobId===job.jobId?result.projection:null}:{})};
  }).deferred();
}

export class MarketPresentationCoordinator {
  constructor(manager){this.manager=manager;this.owner=randomUUID();}
  read(withFrame=true){return this.manager.request('runtime.load',{kind:'market-presentation-current',options:{withFrame}});}
  pending(){return this.manager.request('continuation.scope',{scope:MARKET_PRESENTATION_SCOPE});}
  claim(jobId){return this.manager.request('continuation.claim',{jobId,owner:this.owner});}
  async finish(job,projection,reason){
    const auth={jobId:job.jobId,owner:this.owner,fence:job.fence,cursor:job.cursor};
    try{return await this.manager.request('continuation.marketPresent',{auth,projection,reason});}
    catch(error){
      if(error.code!=='STORAGE_OUTCOME_UNKNOWN')throw error;
      let saved;
      try{saved=await this.manager.request('continuation.get',{jobId:job.jobId});}
      catch(lookupError){error.receiptLookupCode=lookupError.code;}
      if(saved?.status==='complete' && saved.owner===auth.owner && saved.fence===auth.fence &&
          saved.lastTransition?.id==='present-'+auth.cursor && saved.input.resultHash===stableHash(projection ?? null)
          && saved.input.requestedReason===reason)return {job:saved};
      throw error;
    }
  }
}
