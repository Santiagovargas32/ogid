// Mantenimiento explícito del almacenamiento; nunca invocado por el panel Admin.
import Database from "better-sqlite3";
import { StorageManager } from "../storage/StorageManager.js";
import { storageMaintenanceOptions } from "./storage-options.js";
const operation=process.argv[2]||"status";
const operations={status:"storage.status",verify:"storage.verify",checkpoint:"storage.checkpoint"};
if(!Object.hasOwn(operations,operation))throw new Error("Uso: node scripts/storage-status.js status|verify|checkpoint /ruta/ogid.sqlite");
const options=storageMaintenanceOptions(process.argv[3]);
if(operation === "verify"){
  // A full integrity scan can take minutes on a historical database. Run it
  // read-only in this maintenance process, outside request/worker deadlines.
  const db=new Database(options.databasePath,{readonly:true,fileMustExist:true});
  try {
    const result={integrity:db.pragma("integrity_check"),foreignKeys:db.pragma("foreign_key_check")};
    console.log(JSON.stringify(result,null,2));
    if(result.integrity.length!==1 || result.integrity[0].integrity_check!=="ok" || result.foreignKeys.length)process.exitCode=1;
  }finally{db.close();}
}else{
  const manager=new StorageManager(options);
  try {await manager.start();console.log(JSON.stringify(await manager.request(operations[operation]),null,2));}
  finally {await manager.close();}
}
