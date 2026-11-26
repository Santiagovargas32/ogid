import path from "node:path";
import { writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { captureStorageCandidate, checkStorageCandidate, createStorageBackup } from "../storage/backup.js";

const args = process.argv.slice(2);
let work, files;
if (args.length===3 && args[0]==="--capture") {
  files=args.slice(1);work=()=>captureStorageCandidate(...files);
} else if (args.length===3 && args[0]==="--check") {
  files=[args[2]];work=()=>checkStorageCandidate(args[2],args[1],stage=>writeSync(2,JSON.stringify(stage)+"\n"));
} else if (args.length===2 && !args[0].startsWith("--")) {
  files=args;work=()=>createStorageBackup(...files);
} else {
  throw new Error("Uso: storage:backup [--capture] origen.sqlite destino.sqlite | --check integrity|foreign-keys candidato.sqlite");
}
for (const filename of files) if (path.resolve(filename).startsWith("/srv/bitcoin/")) execFileSync("mountpoint",["-q","/srv/bitcoin"]);
console.log(JSON.stringify(await work(),null,2));
