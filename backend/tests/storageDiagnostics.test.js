import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../storage/migrate.js";
import { readDatabaseDiagnostics } from "../storage/diagnostics.js";
import {mkdtempSync,cpSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test("counter migration bootstraps an existing 013 database without changing its history",()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-count-upgrade-')),db=new Database(':memory:');
 try{
  cpSync(new URL('../storage/migrations/',import.meta.url),directory,{recursive:true});for(const file of readdirSync(directory))if(Number(file.slice(0,3))>13)rmSync(join(directory,file));
  migrate(db,directory);const before=db.prepare('SELECT * FROM schema_migrations').all();
  db.exec("INSERT INTO articles VALUES('old','Preserved',NULL,NULL,'2026-10-19','2026-10-19','2026-10-19',1,'headline-only-link-out','{}'); INSERT INTO research_rows VALUES('events','historical','{}')");
  migrate(db);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=13').all(),before);
  const state=readDatabaseDiagnostics(db);assert.equal(state.counts.articles,1);assert.deepEqual(state.researchTables,[{collection:'events',records:1,bytes:null}]);
  assert.equal(db.prepare("SELECT title FROM articles WHERE article_id='old'").get().title,'Preserved');
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

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

test("diagnostic counters follow commit, rollback, upsert, collection moves and deletes without historical count scans",()=>{
 const db=new Database(':memory:');migrate(db);
 try{
  const article=db.prepare("INSERT INTO articles VALUES(?,? ,NULL,NULL,?,?,?,1,'headline-only-link-out','{}')");
  article.run('a','Report','2026-10-19','2026-10-19','2026-10-19');
  assert.throws(()=>db.transaction(()=>{article.run('rollback','Rollback','2026-10-19','2026-10-19','2026-10-19');throw Error('rollback');})());
  db.prepare("INSERT INTO research_rows VALUES('events','one','{}')").run();
  db.prepare("INSERT INTO research_rows VALUES('events','one','{}') ON CONFLICT(collection,entity_id) DO UPDATE SET payload_json='{}'").run();
  db.prepare("UPDATE research_rows SET collection='jobs' WHERE entity_id='one'").run();
  const prepare=db.prepare.bind(db),queries=[];db.prepare=sql=>{queries.push(sql);return prepare(sql);};
  const state=readDatabaseDiagnostics(db);assert.equal(state.counts.articles,1);assert.deepEqual(state.researchTables,[{collection:'jobs',records:1,bytes:null}]);
  const pending=queries.filter(sql=>sql.includes("kind='market-persistence' AND status='pending'"));
  assert.equal(pending.length,1);
  assert.ok(!queries.filter(sql=>!pending.includes(sql)).some(sql=>/count\(\*\)/i.test(sql)));
  assert.ok(db.prepare('EXPLAIN QUERY PLAN '+pending[0]).all().some(r=>r.detail.includes('COVERING INDEX acquisition_jobs_kind_status')));
  db.prepare("DELETE FROM articles").run();db.prepare("DELETE FROM research_rows").run();
  const empty=readDatabaseDiagnostics(db);assert.equal(empty.counts.articles,0);assert.deepEqual(empty.researchTables,[]);
 }finally{db.close();}
});
