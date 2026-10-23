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
    const revision=archive.revision;
    const started=performance.now();
    accepted+=archive.ingest(articles.slice(start,offset),options).accepted || 0;
    committedOperationItems(offset-start);
    onCommitted(offset,{changed:archive.revision!==revision,committedAt:archive.lastIngestAt || null,commitMs:performance.now()-started,rows:offset-start,bytes});
    await new Promise(resolve=>setImmediate(resolve));
  }
  checkOperation();
  return accepted;
}
