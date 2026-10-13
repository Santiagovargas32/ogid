import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../storage/migrate.js";
import { readDatabaseDiagnostics } from "../storage/diagnostics.js";

test("periodic SQL diagnostics report record counts without presenting unmeasured bytes as zero",()=>{
  const db=new Database(":memory:");
  try{
    migrate(db);
    const payload=JSON.stringify({title:"Información de investigación",provenance:{source:"fixture"}});
    db.prepare("INSERT INTO research_rows VALUES(?,?,?)").run("events","first",payload);
    const periodic=readDatabaseDiagnostics(db);
    assert.equal(periodic.researchBytesSampled,false);
    assert.deepEqual(periodic.researchTables,[{collection:"events",records:1,bytes:null}]);
    const full=readDatabaseDiagnostics(db,{includeResearchBytes:true});
    assert.equal(full.researchBytesSampled,true);
    assert.deepEqual(full.researchTables,[{collection:"events",records:1,bytes:Buffer.byteLength(payload)}]);
    assert.deepEqual(periodic.counts,full.counts);
    assert.deepEqual(periodic.pipelines,full.pipelines);
  }finally{db.close();}
});

test("light SQL diagnostics see newly persisted records on subsequent samples",()=>{
  const db=new Database(":memory:");
  try{
    migrate(db);
    const first=readDatabaseDiagnostics(db);assert.deepEqual(first.researchTables,[]);
    db.prepare("INSERT INTO research_rows VALUES(?,?,?)").run("jobs","job-1",JSON.stringify({status:"pending"}));
    const second=readDatabaseDiagnostics(db);
    assert.deepEqual(second.researchTables,[{collection:"jobs",records:1,bytes:null}]);
    assert.equal(second.researchBytesSampled,false);
  }finally{db.close();}
});
