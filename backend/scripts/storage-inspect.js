import Database from "better-sqlite3";
import path from "node:path";
import { statSync } from "node:fs";
import { readDatabaseDiagnostics } from "../storage/diagnostics.js";

const args=process.argv.slice(2),watch=args.includes("--watch");
const databasePath=path.resolve(args.find(arg=>arg!=="--watch") || process.env.STORAGE_DB_PATH || "/srv/bitcoin/ogid/db/ogid.sqlite");
const db=new Database(databasePath,{readonly:true,fileMustExist:true,timeout:1500});
let previous=null;
function sample(){
  const result=readDatabaseDiagnostics(db),delta=previous?Object.fromEntries(Object.entries(result.counts).map(([table,n])=>[table,n-previous[table]])):null;
  const size=file=>{try{return statSync(file).size;}catch(error){if(error.code==="ENOENT")return 0;throw error;}};
  console.log(JSON.stringify({databasePath,mode:"read-only",databaseBytes:size(databasePath),walBytes:size(`${databasePath}-wal`),...result,delta},null,2));previous=result.counts;
}
try{sample();if(watch){const timer=setInterval(()=>{try{sample();}catch(error){console.error(error.message);}},5000);const stop=()=>{clearInterval(timer);db.close();};process.once("SIGINT",stop);process.once("SIGTERM",stop);}else db.close();}catch(error){db.close();throw error;}
