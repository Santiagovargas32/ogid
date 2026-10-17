import path from "node:path";
import { execFileSync } from "node:child_process";
import { storageMaintenanceOptions } from "./storage-options.js";
import { repair009 } from "../storage/repair009.js";

const args = process.argv.slice(2);
if (!((args.length === 2 && args[1] === "--check") || (args.length === 3 && args[1] === "--backup"))) {
  throw new Error("Uso: storage:repair-009 -- /ruta/ogid.sqlite --check | /ruta/ogid.sqlite --backup /ruta/backup-nuevo.sqlite. Detener primero la app (Ctrl+C si se usa npm).");
}
for (const filename of [args[0],args[2]].filter(Boolean)) {
  if (path.resolve(filename).startsWith("/srv/bitcoin/")) execFileSync("mountpoint",["-q","/srv/bitcoin"]);
}
const {databasePath} = storageMaintenanceOptions(args[0]);
console.log(JSON.stringify(await repair009(databasePath,{checkOnly:args[1] === "--check",backupPath:args[2]}),null,2));
