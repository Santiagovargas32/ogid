import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureStorageCandidate, checkStorageCandidate, createStorageBackup } from "../storage/backup.js";

test("online backup restores committed WAL rows and never overwrites an existing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogid-backup-")),source = join(dir, "source.sqlite"),destination = join(dir, "backup.sqlite");
  const db = new Database(source);
  try {
    db.pragma("journal_mode=WAL");db.pragma("wal_autocheckpoint=0");
    db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY); INSERT INTO entries VALUES(1); BEGIN IMMEDIATE; INSERT INTO entries VALUES(2)");
    const result = await createStorageBackup(source, destination);assert.equal(result.verified,true);
    const restored = new Database(destination);try { assert.deepEqual(restored.prepare("SELECT * FROM entries").all(),[{id:1}]); }finally { restored.close(); }
    await assert.rejects(createStorageBackup(source, destination), {code:"EEXIST"});
    db.exec("ROLLBACK");
  }finally { db.close();rmSync(dir,{recursive:true,force:true}); }
});

test("independent CLI checks can resume a closed WAL capture and keep later acquisitions separate", async () => {
  const dir=mkdtempSync(join(tmpdir(),"ogid-capture-cli-"));
  const source=join(dir,"source.sqlite"),copy=join(dir,"capture.sqlite");
  const script=fileURLToPath(new URL("../scripts/storage-backup.js",import.meta.url));
  const run=(...args)=>JSON.parse(execFileSync(process.execPath,[script,...args],{encoding:"utf8",timeout:10000}));
  const db=new Database(source);
  try {
    db.pragma("journal_mode=WAL");db.pragma("wal_autocheckpoint=0");
    db.exec("CREATE TABLE rows(id INTEGER PRIMARY KEY); INSERT INTO rows VALUES (1)");
    const candidate=run("--capture",source,copy);
    assert.equal(candidate.verified,false);
    assert.equal(statSync(copy).mode&0o777,0o600);
    const first=run("--check","integrity",copy);
    assert.equal(first.verified,false);
    assert.deepEqual(first.identity,candidate.identity);
    assert.equal(first.results[0].complete,true);
    db.exec("INSERT INTO rows VALUES (2)");
    const second=run("--check","foreign-keys",copy);
    assert.deepEqual(second.identity,first.identity);
    assert.equal(second.results[0].sql,"PRAGMA main.foreign_key_check");
    const restored=new Database(copy,{readonly:true});
    try { assert.equal(restored.prepare("SELECT count(*) FROM rows").pluck().get(),1); }
    finally { restored.close(); }
    assert.equal(db.prepare("SELECT count(*) FROM rows").pluck().get(),2);
  } finally { db.close();rmSync(dir,{recursive:true,force:true}); }
});

test("foreign-key failure retains the captured candidate and forbids verified publication", async () => {
  const dir=mkdtempSync(join(tmpdir(),"ogid-backup-fk-"));
  const source=join(dir,"source.sqlite"),copy=join(dir,"candidate.sqlite"),verified=join(dir,"verified.sqlite");
  const db=new Database(source);
  try {
    db.pragma("foreign_keys=OFF");
    db.exec("CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(id REFERENCES parent(id)); INSERT INTO child VALUES(5)");
    const candidate=await captureStorageCandidate(source,copy);
    assert.equal(checkStorageCandidate(copy,"integrity").results[0].complete,true);
    const stages=[];
    assert.throws(()=>checkStorageCandidate(copy,"foreign-keys",row=>stages.push(row)),{code:"BACKUP_CHECK_FAILED",unit:"foreign-keys"});
    assert.deepEqual(stages,[{unit:"foreign-keys",stage:"dispatch",sql:"PRAGMA main.foreign_key_check"}]);
    assert.deepEqual(checkStorageCandidate(copy,"integrity").identity,candidate.identity);
    await assert.rejects(createStorageBackup(source,verified),{code:"BACKUP_CHECK_FAILED",unit:"foreign-keys"});
    assert.equal(existsSync(verified),false);
  } finally { db.close();rmSync(dir,{recursive:true,force:true}); }
});

test("two captures cannot replace one another or adopt a destination sidecar", async () => {
  const dir=mkdtempSync(join(tmpdir(),"ogid-backup-race-"));
  const source=join(dir,"source.sqlite"),copy=join(dir,"capture.sqlite"),blocked=join(dir,"blocked.sqlite");
  const db=new Database(source);
  try {
    db.exec("CREATE TABLE rows(id PRIMARY KEY); INSERT INTO rows VALUES(1)");
    await assert.rejects(captureStorageCandidate(source,source+"-wal"),/auxiliar del origen/);
    assert.equal(existsSync(source+"-wal"),false);
    const results=await Promise.allSettled([captureStorageCandidate(source,copy),captureStorageCandidate(source,copy)]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    assert.equal(results.find(r=>r.status==="rejected").reason.code,"EEXIST");
    writeFileSync(blocked+"-wal","fixture");
    await assert.rejects(captureStorageCandidate(source,blocked),{code:"EEXIST"});
    assert.equal(readFileSync(blocked+"-wal","utf8"),"fixture");
    assert.equal(existsSync(blocked),false);
    writeFileSync(copy+"-journal","fixture");
    assert.throws(()=>checkStorageCandidate(copy,"integrity"),{code:"BACKUP_JOURNAL_PRESENT"});
  } finally { db.close();rmSync(dir,{recursive:true,force:true}); }
});
