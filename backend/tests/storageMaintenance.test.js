import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import Database from "better-sqlite3";

const script=fileURLToPath(new URL("../scripts/storage-status.js",import.meta.url));
const env={...process.env,STORAGE_ENABLED:"1",STORAGE_BUSINESS_ENABLED:"1",STORAGE_TIMEOUT_MS:"1"};

test("maintenance verification is read-only and independent of worker request deadlines",()=>{
  const directory=mkdtempSync(join(tmpdir(),"ogid-storage-maintenance-")),file=join(directory,"fixture.sqlite");
  try{
    const db=new Database(file);db.exec("CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES(42)");db.close();
    const result=JSON.parse(execFileSync(process.execPath,[script,"verify",file],{env,encoding:"utf8"}));
    assert.deepEqual(result,{integrity:[{integrity_check:"ok"}],foreignKeys:[]});
    const checked=new Database(file,{readonly:true});
    try{assert.deepEqual(checked.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all(),[{name:"fixture"}]);}
    finally{checked.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test("maintenance verification exits unsuccessfully when foreign keys are broken",()=>{
  const directory=mkdtempSync(join(tmpdir(),"ogid-storage-maintenance-")),file=join(directory,"fixture.sqlite");
  try{
    const db=new Database(file);
    db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(42)");db.close();
    assert.throws(()=>execFileSync(process.execPath,[script,"verify",file],{env,encoding:"utf8"}),error=>{
      assert.equal(error.status,1);
      const result=JSON.parse(error.stdout);assert.equal(result.integrity[0].integrity_check,"ok");
      assert.equal(result.foreignKeys.length,1);return true;
    });
  }finally{rmSync(directory,{recursive:true,force:true});}
});
