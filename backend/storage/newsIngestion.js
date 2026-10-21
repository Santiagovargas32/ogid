// Yield between committed SQLite batches so acquisition cannot starve leases.
import { checkOperation, committedOperationItems } from "../services/shared/operationContext.js";
export async function ingestNewsBatches(archive,articles,options,onCommitted=()=>{}) {
  let accepted=0;
  for(let offset=0;offset<articles.length;offset+=10){
    checkOperation();
    const revision=archive.revision;
    accepted+=archive.ingest(articles.slice(offset,offset+10),options).accepted || 0;
    committedOperationItems(Math.min(10,articles.length-offset));
    onCommitted(Math.min(offset+10,articles.length),{changed:archive.revision!==revision,committedAt:archive.lastIngestAt || null});
    await new Promise(resolve=>setImmediate(resolve));
  }
  checkOperation();
  return accepted;
}
