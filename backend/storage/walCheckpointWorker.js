import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3';
import {nativeThreadId} from './nativeWait.js';

// This connection can only copy committed WAL pages. It never owns the business
// writer lease and cannot execute business mutations, even accidentally.
let database;
try{
  database=new Database(workerData.databasePath,{fileMustExist:true,timeout:0});
  database.pragma('synchronous=FULL');
  database.pragma('wal_autocheckpoint=0');
  database.pragma('query_only=ON');
  const verifyOwner=()=>{
    const owner=database.prepare('SELECT token,process_id FROM storage_writer_owner WHERE singleton=1').get();
    if(owner?.token!==workerData.writerToken || owner.process_id!==process.pid)
      throw Object.assign(Error('Checkpoint owner changed'),{code:'STORAGE_CHECKPOINT_OWNER_CHANGED'});
  };
  verifyOwner();
  parentPort.postMessage({type:'ready',nativeThreadId:nativeThreadId(),queryOnly:database.pragma('query_only',{simple:true})===1,synchronous:database.pragma('synchronous',{simple:true}),pageSize:database.pragma('page_size',{simple:true})});
  parentPort.on('message',message=>{
    if(message.type==='close'){database.close();parentPort.close();return;}
    if(message.type!=='checkpoint')return;
    const start=performance.now();
    try{
      verifyOwner();
      const result=database.pragma('wal_checkpoint(PASSIVE)');
      parentPort.postMessage({id:message.id,result,durationMs:performance.now()-start});
    }catch(reason){parentPort.postMessage({id:message.id,error:{code:reason.code||'STORAGE_CHECKPOINT_FAILED'},durationMs:performance.now()-start});}
  });
}catch(reason){
  database?.close();
  parentPort.postMessage({type:'failed',error:{code:reason.code||'STORAGE_CHECKPOINT_START_FAILED'}});
  parentPort.close();
}
