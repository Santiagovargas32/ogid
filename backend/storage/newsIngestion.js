// Yield between committed SQLite batches so acquisition cannot starve leases.
import { checkOperation, committedOperationItems } from "../services/shared/operationContext.js";
import {RUNTIME_POLICY} from '../config/runtimePolicy.js';
export async function ingestNewsBatches(archive,articles,options,onCommitted=()=>{}) {
  let accepted=0;
  for(let offset=0;offset<articles.length;){
    checkOperation();
    const start=offset;let bytes=0;
    while(offset<articles.length && offset-start<RUNTIME_POLICY.storage.commitBatchRows){
      const size=Buffer.byteLength(JSON.stringify(articles[offset]));
      if(offset>start && bytes+size>RUNTIME_POLICY.storage.commitBatchBytes)break;
      bytes+=size;offset++;
    }
    const candidates=articles.slice(start,offset),revision=archive.revision;
    const started=performance.now();
    const result=archive.ingestPage?archive.ingestPage(candidates,options,{budgetMs:RUNTIME_POLICY.storage.commitBatchMs}):archive.ingest(candidates,options);
    const processed=result.processed??candidates.length;
    if(!Number.isSafeInteger(processed)||processed<1||processed>candidates.length)throw Object.assign(Error('Invalid committed page'),{code:'STORAGE_INVALID_COMMIT_PAGE'});
    offset=start+processed;bytes=candidates.slice(0,processed).reduce((n,item)=>n+Buffer.byteLength(JSON.stringify(item)),0);
    accepted+=result.accepted||0;
    committedOperationItems(offset-start);
    onCommitted(offset,{changed:archive.revision!==revision,committedAt:archive.lastIngestAt || null,commitMs:performance.now()-started,rows:offset-start,bytes});
    await new Promise(resolve=>setImmediate(resolve));
  }
  checkOperation();
  return accepted;
}
