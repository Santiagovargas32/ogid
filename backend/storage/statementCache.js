// Prepared statements own native memory. Reusing a bounded set prevents a long
// import or frequent ingests from allocating a new native statement per row.
export function cacheStatements(database, maxEntries=256, {onSlow=null,thresholdMs=1000,activity=null,beforeWrite=null}={}){
  const prepare=database.prepare.bind(database),cache=new Map();
  const instrument=statement=>{
    if(!onSlow&&!activity&&!beforeWrite)return statement;
    const current=activity?.statement(statement.source);
    const measure=(fn,method,args=[])=>{if(!statement.readonly)beforeWrite?.();const start=performance.now();current?.start(method);try{const result=fn();if(!statement.readonly&&result?.changes!==0&&(method!=='iterate'||result.done))activity?.write?.(4096+args.reduce((n,v)=>n+(typeof v==='string'?Buffer.byteLength(v):Buffer.isBuffer(v)?v.length:8),0),database.inTransaction);return result;}finally{const durationMs=performance.now()-start;current?.end(durationMs);if(onSlow&&durationMs>=thresholdMs){try{onSlow(statement.source,durationMs);}catch{/* Metrics never fail a business operation. */}}}};
    for(const name of ['get','all','run']){const method=statement[name];statement[name]=function(...args){return measure(()=>method.apply(this,args),name,args);};}
    const iterate=statement.iterate;
    statement.iterate=function(...args){const iterator=iterate.apply(this,args);return {[Symbol.iterator](){return this;},next:()=>measure(()=>iterator.next(),'iterate'),return:()=>iterator.return()};};
    return statement;
  };
  database.prepare=sql=>{
    let statement=cache.get(sql);
    // Async scans yield between batches; another request can run the same SQL
    // while its cached iterator is still open. A statement cannot be reused then.
    if(statement?.busy) return instrument(prepare(sql));
    if(statement){cache.delete(sql);cache.set(sql,statement);return statement;}
    statement=instrument(prepare(sql));cache.set(sql,statement);
    while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
    return statement;
  };
  return cache;
}
