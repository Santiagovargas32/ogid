import Database from 'better-sqlite3';
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
function activeOwner(db){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='storage_writer_owner'").get())return null;
 const owner=db.prepare('SELECT * FROM storage_writer_owner WHERE singleton=1').get();
 return owner&&alive(owner.process_id)?owner:null;
}
export function assertWriterAvailable(db){if(activeOwner(db))throw Object.assign(new Error('Otro escritor operativo posee la base.'),{code:'STORAGE_WRITER_ACTIVE'});}
export function acquireWriter(db,token){
 db.transaction(()=>{assertWriterAvailable(db);db.prepare('INSERT INTO storage_writer_owner VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,process_id=excluded.process_id,acquired_at=excluded.acquired_at').run(token,process.pid,new Date().toISOString());}).immediate();
}
export function releaseWriter(db,token){if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='storage_writer_owner'").get())db.prepare('DELETE FROM storage_writer_owner WHERE token=?').run(token);}
// Lifecycle recovery only, after termination has released the worker connection.
// Business tables are never changed from the parent process.
export function releaseTerminatedWriter(file,token){
 let db;try{db=new Database(file,{fileMustExist:true,timeout:2000});releaseWriter(db,token);}finally{db?.close();}
}
