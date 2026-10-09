// Mantenimiento explícito del almacenamiento; nunca invocado por el panel Admin.
import { existsSync } from "node:fs";
import path from "node:path";
import { StorageManager } from "../storage/StorageManager.js";
const operation=process.argv[2]||"status";
const operations={status:"storage.status",verify:"storage.verify",checkpoint:"storage.checkpoint"};
if(!Object.hasOwn(operations,operation))throw new Error("Uso: node scripts/storage-status.js status|verify|checkpoint /ruta/ogid.sqlite");
const databasePath=path.resolve(process.argv[3]||process.env.STORAGE_DB_PATH||"/srv/bitcoin/ogid/db/ogid.sqlite");
if(!existsSync(databasePath))throw new Error("La base no existe; este comando no crea una base alternativa.");
const manager=new StorageManager({enabled:true,databasePath});
try {await manager.start();console.log(JSON.stringify(await manager.request(operations[operation]),null,2));}
finally {await manager.close();}
