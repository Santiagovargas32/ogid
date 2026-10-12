import path from "node:path";
import { execFileSync } from "node:child_process";
import { createStorageBackup } from "../storage/backup.js";

const args = process.argv.slice(2);
if (args.length !== 2) throw new Error("Uso: storage:backup /ruta/origen.sqlite /ruta/backup.sqlite");
for (const filename of args) if (path.resolve(filename).startsWith("/srv/bitcoin/")) execFileSync("mountpoint", ["-q", "/srv/bitcoin"]);
console.log(JSON.stringify(await createStorageBackup(...args), null, 2));
