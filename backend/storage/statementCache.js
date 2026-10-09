// Prepared statements own native memory. Reusing a bounded set prevents a long
// import or frequent ingests from allocating a new native statement per row.
export function cacheStatements(database, maxEntries=256){
  const prepare=database.prepare.bind(database),cache=new Map();
  database.prepare=sql=>{
    let statement=cache.get(sql);
    // Async scans yield between batches; another request can run the same SQL
    // while its cached iterator is still open. A statement cannot be reused then.
    if(statement?.busy) return prepare(sql);
    if(statement){cache.delete(sql);cache.set(sql,statement);return statement;}
    statement=prepare(sql);cache.set(sql,statement);
    while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
    return statement;
  };
  return cache;
}
