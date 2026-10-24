import {AsyncLocalStorage} from 'node:async_hooks';
export const storageExecutionContext=new AsyncLocalStorage();
export function walWriteGuard(database,buffer){
  const pressure=new Int32Array(buffer);
  return ()=>{
    // A transaction already admitted must finish or roll back atomically.
    // Lease renewal/cancellation and shutdown remain available under pressure.
    if(!database.inTransaction && Atomics.load(pressure,0)===1 && !storageExecutionContext.getStore()?.control)
      throw Object.assign(Error('WAL checkpoint is behind; retry after progress'),{code:'STORAGE_WAL_BACKPRESSURE',statusCode:503});
  };
}
