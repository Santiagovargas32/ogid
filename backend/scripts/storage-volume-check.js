// Comprobación aislada de WAL y bloqueos. Sólo borra su directorio temporal.
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, chmodSync, statSync, rmSync } from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const mode=process.argv[2];
if (mode==="lock-child" || mode==="crash-child") {
  const db=new Database(process.argv[3]);db.pragma("journal_mode=WAL");db.pragma("synchronous=FULL");db.pragma("wal_autocheckpoint=0");
  let finished=false;
  process.on("disconnect",()=>{if(!finished)process.exit(1);});
  if(mode==="lock-child") {
    db.exec("BEGIN IMMEDIATE; INSERT INTO probe VALUES(1,'held');");process.send({ready:true});
    process.on("message",()=>{db.exec("COMMIT");db.close();finished=true;process.disconnect();});
  } else {
    db.exec("INSERT INTO probe VALUES(2,'committed'); BEGIN IMMEDIATE; INSERT INTO probe VALUES(3,'uncommitted');");process.send({ready:true});
  }
} else {
  const root=path.resolve(mode||"/srv/bitcoin/ogid");mkdirSync(root,{recursive:true,mode:0o700});
  const directory=mkdtempSync(path.join(root,".sqlite-volume-check-"));const file=path.join(directory,"probe.sqlite");let db,child;
  async function launch(kind) {
    child=fork(fileURLToPath(import.meta.url),[kind,file],{stdio:["ignore","inherit","inherit","ipc"],execArgv:[]});
    let timer;
    try {await Promise.race([once(child,"message"),once(child,"exit").then(()=>{throw new Error("Volume check child exited before ready");}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Volume check child timed out")),5000);})]);}
    finally {clearTimeout(timer);}
  }
  try {
    db=new Database(file,{timeout:100});chmodSync(file,0o600);assert.equal(db.pragma("journal_mode=WAL",{simple:true}),"wal");db.pragma("synchronous=FULL");db.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY,value TEXT NOT NULL) STRICT");
    await launch("lock-child");
    assert.equal(db.prepare("SELECT count(*) AS n FROM probe").get().n,0);
    assert.throws(()=>db.prepare("INSERT INTO probe VALUES(4,'contending')").run(),{code:"SQLITE_BUSY"});
    let exit=once(child,"exit");child.send({commit:true});await exit;child=null;
    assert.equal(db.prepare("SELECT count(*) AS n FROM probe").get().n,1);db.close();db=null;
    await launch("crash-child");exit=once(child,"exit");child.kill("SIGKILL");await exit;child=null;
    db=new Database(file);assert.deepEqual(db.prepare("SELECT id FROM probe ORDER BY id").all().map(r=>r.id),[1,2]);
    assert.equal(db.pragma("integrity_check",{simple:true}),"ok");
    console.log(JSON.stringify({directory:root,sqliteVersion:db.prepare("SELECT sqlite_version() AS v").get().v,wal:true,concurrentReader:true,writerLock:true,committedCrashRecovery:true,uncommittedRollback:true,integrity:"ok",fileMode:(statSync(file).mode&0o777).toString(8),directoryMode:(statSync(directory).mode&0o777).toString(8),limitation:"No simula un corte de alimentación ni certifica el filesystem a largo plazo."},null,2));
  } finally {
    if(child && child.exitCode===null && child.signalCode===null){const exit=once(child,"exit");child.kill("SIGKILL");await exit;}
    db?.close();rmSync(directory,{recursive:true,force:true});
  }
}
