// Guidance rather than an allowlist: continuations retain every frozen ID.
export async function repairCatalog(call,snapshotId,job,{maxBytes=8192,maxPages=8}={}) {
  const result={snapshotId,items:[],continuations:[]};let bytes=128;
  for(const domain of job.task==='situation_analysis'?['situation-source','coverage']:job.task==='instrument_outlook'?['technical.get','coverage']:['coverage','technical.get']){
    let cursor=0,pages=0,more=true;
    while(more&&pages++<maxPages){
      const page=await call('evidence',{snapshotId,domain,cursor,limit:20});
      for(const item of page.items||[]){
        if(job.task==='instrument_outlook'&&item.data?.instrumentId&&item.data.instrumentId!==job.scope)continue;
        const row={evidenceId:item.evidenceId,domain:item.domain,instrumentId:item.data?.instrumentId||null,interval:item.data?.interval||null,quality:item.quality,publicationEligibility:item.publicationEligibility};
        const size=Buffer.byteLength(JSON.stringify(row));
        if(bytes+size>maxBytes){result.continuations.push({operationId:'agent.evidence',parameters:{snapshotId,domain,cursor,limit:20}});return result;}
        result.items.push(row);bytes+=size;
      }
      more=page.hasMore;cursor=page.nextCursor;
    }
    if(more)result.continuations.push({operationId:'agent.evidence',parameters:{snapshotId,domain,cursor,limit:20}});
  }
  return result;
}
