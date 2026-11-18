import {randomUUID} from 'node:crypto';
import {AppError} from '../utils/error.js';
import {CycleContinuations} from './cycleContinuations.js';

export const MARKET_QUOTE_SCOPE='market:quotes';
const invalid=()=>{throw new AppError('Turno de cotizaciones incompatible.',409,'CONTINUATION_EFFECT_MISMATCH');};

export function reserveMarketQuotes(db,{jobId,selection}){
  if(!selection || typeof selection.trigger!=='string' || !Array.isArray(selection.tickers)
    || !Number.isFinite(Date.parse(selection.selectedAt)) || !/^[a-f0-9]{64}$/.test(selection.policyHash))invalid();
  const ledger=new CycleContinuations(db);
  return db.transaction(()=>ledger.scope({scope:MARKET_QUOTE_SCOPE}) || ledger.admit({
    jobId,scope:MARKET_QUOTE_SCOPE,phase:'admission',input:{kind:'market-quote-selection-v1',selection}
  })).immediate();
}

// The quote effect and presentation handoff already share an outer FULL
// transaction. A lost fence aborts both, including the storage command receipt.
export function confirmMarketQuotes(db,{auth,jobId,market}){
  const ledger=new CycleContinuations(db),job=ledger.get(auth);
  if(job.scope!==MARKET_QUOTE_SCOPE || job.phase!=='request-authorized' || auth.cursor!==job.cursor)invalid();
  return ledger.advance({...auth,phase:'confirmed',complete:true,transitionId:'quote-confirm-'+job.cursor,
    input:{...job.input,marketRevision:market.revision,updatedAt:market.updatedAt,presentationJobId:jobId}});
}

export class MarketQuoteCoordinator {
  constructor(manager,now=Date.now){this.manager=manager;this.owner=randomUUID();this.now=now;}
  pending(){return this.manager.request('continuation.scope',{scope:MARKET_QUOTE_SCOPE});}
  async reserve(selection){
    this.unacknowledged ||= {jobId:'quotes-'+randomUUID(),selection};
    try{
      const job=await this.manager.request('continuation.marketQuoteReserve',this.unacknowledged);
      this.unacknowledged=null;
      return job;
    }catch(error){
      if(!['STORAGE_RESOURCE_PRESSURE','STORAGE_QUEUE_TIMEOUT','STORAGE_OUTCOME_UNKNOWN','STORAGE_NOT_READY'].includes(error.code)){
        this.unacknowledged=null;
      }
      throw error;
    }
  }
  async claim(job){
    const owned=await this.manager.request('continuation.claim',{jobId:job.jobId,owner:this.owner});
    if(!owned)throw new AppError('Turno de cotizaciones reclamado.',503,'STORAGE_CONTINUATION_BUSY');
    return owned;
  }
  auth(job){return {jobId:job.jobId,owner:this.owner,fence:job.fence,cursor:job.cursor};}
  advance(job,phase,input,complete=false){
    return this.manager.request('continuation.advance',{...this.auth(job),phase,input,complete,transitionId:'quote-'+phase+'-'+job.cursor});
  }
  async authorize(admitted,cadenceMs){
    const job=await this.claim(admitted);
    if(job.phase!=='admission')invalid();
    const at=new Date(this.now()).toISOString();
    return this.advance(job,'request-authorized',{...job.input,dispatchedAt:at,
      nextEligibleAt:cadenceMs>0?new Date(Date.parse(at)+cadenceMs).toISOString():null});
  }
  async unsent(job){return this.advance(job,'admission',{kind:job.input.kind,selection:job.input.selection});}
  async skip(selected,reason){
    const job=await this.claim(selected);
    return this.advance(job,reason==='request-outcome-unknown'?'unconfirmed':'skipped',{...job.input,reason},true);
  }
}
