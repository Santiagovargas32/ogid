import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { repair009 } from "../storage/repair009.js";
import { migrate } from "../storage/migrate.js";
import { StorageManager } from "../storage/StorageManager.js";

const migrations = new URL("../storage/migrations/",import.meta.url);
const checksum = text => createHash("sha256").update(text).digest("hex");
const oldChecksum = "9a6457bd9e00ceab72bddcab93fa8a236aedef75da20af636942608f1753b732";
const tables = ["articles","article_revisions","article_sources","signal_changes","research_rows","analysis_runs","analysis_jobs","analysis_latest","derived_observations","consumer_checkpoints"];
const facts = db => Object.fromEntries(tables.map(table => [table,db.prepare(`SELECT * FROM ${table}`).all().map(row=>{if(table==="analysis_jobs"){const {owner:_owner,fence:_fence,lease_until:_lease,...original}=row;return original;}return row;})]));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(),"ogid-repair-009-")),file = join(dir,"db.sqlite"),backup = join(dir,"backup.sqlite");
  const db = new Database(file);
  db.pragma("journal_mode=WAL");db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT");
  for (const name of readdirSync(migrations).filter(name=>/^00[1-9]_/.test(name)).sort()) {
    const sql = readFileSync(new URL(name,migrations),"utf8"),applied = name.startsWith("009_") ? sql.split("\n").slice(0,27).join("\n")+"\n" : sql;
    db.exec(applied);
    db.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?)").run(Number(name.slice(0,3)),name,checksum(applied),"2026-10-16T16:13:49.288Z");
  }
  // Historical fixture is written using its schema, before current migrations exist.
  const at="2026-10-16T12:00:00.000Z";
  for(const [revision,title] of [[1,"Original report"],[2,"Revised report"]]){
    const payload=JSON.stringify({id:"preserved",title,url:"https://fixture.invalid/article",revision,receivedAt:at});
    db.prepare("INSERT INTO articles VALUES('preserved',?,NULL,'https://fixture.invalid/article',?,?,?,?,'headline-only-link-out',?) ON CONFLICT(article_id) DO UPDATE SET title=excluded.title,revision=excluded.revision,payload_json=excluded.payload_json").run(title,at,at,at,revision,payload);
    db.prepare("INSERT INTO article_revisions VALUES('preserved',?,?,?)").run(revision,at,payload);
  }
  db.prepare("INSERT INTO sources VALUES('fixture-rss','Fixture RSS','configured','{}')").run();
  db.prepare("INSERT INTO article_sources VALUES('preserved','fixture-rss',?,'{}')").run(at);
  db.exec(`INSERT INTO signal_changes VALUES(1,'2026-10-16T12:00:00Z','{"instrumentId":"fixture"}');
    INSERT INTO research_rows VALUES('events','preserved','{"value":42}');
    INSERT INTO analysis_runs VALUES('run','advanced.getSnapshot','v1','2026-10-16','2026-10-16','hash','ok','{}');
    INSERT INTO analysis_jobs(job_id,scope_key,calculation_key,method_version,status,as_of,created_at,updated_at,input_json,analysis_id)
      VALUES('job','scope','calculation','v1','complete','2026-10-16','2026-10-16','2026-10-16','{}','run');
    INSERT INTO analysis_latest VALUES('scope','run','2026-10-16','calculation');
    INSERT INTO derived_observations VALUES('fixture','hash','2026-10-16','{}');
    INSERT INTO consumer_checkpoints VALUES('fixture',1,'2026-10-16');`);
  const before = facts(db);
  return {dir,file,backup,db,before,close(){if(db.open)db.close();rmSync(dir,{recursive:true,force:true});}};
}

test("009 check is read-only; explicit repair backs up WAL facts and permits restart on the same database",async()=>{
  const f = fixture();let manager;
  try {
    assert.throws(()=>migrate(f.db),{code:"STORAGE_MIGRATION_MISMATCH"});
    const script = fileURLToPath(new URL("../scripts/storage-repair-009.js",import.meta.url));
    const checked = JSON.parse(execFileSync(process.execPath,[script,f.file,"--check"],{encoding:"utf8"}));
    assert.equal(checked.repairable,true);assert.equal(checked.mode,"read-only");
    assert.equal(f.db.prepare("SELECT checksum FROM schema_migrations WHERE version=9").get().checksum,oldChecksum);
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='analysis_inputs'").get(),undefined);
    const result = await repair009(f.file,{checkOnly:false,backupPath:f.backup});
    assert.equal(result.repaired,true);assert.equal(result.backup.verified,true);
    assert.deepEqual(facts(f.db),f.before);
    const backup = new Database(f.backup,{readonly:true});
    try {
      assert.deepEqual(facts(backup),f.before);
      assert.equal(backup.prepare("SELECT checksum FROM schema_migrations WHERE version=9").get().checksum,oldChecksum);
    } finally {backup.close();}
    const fullSql = readFileSync(new URL("009_durable_analysis.sql",migrations),"utf8");
    assert.equal(f.db.prepare("SELECT checksum FROM schema_migrations WHERE version=9").get().checksum,checksum(fullSql));
    assert.equal(f.db.prepare("SELECT applied_at FROM schema_migrations WHERE version=9").get().applied_at,"2026-10-16T16:13:49.288Z");
    assert.equal(migrate(f.db).length,25);
    for(const name of result.changes)assert.ok(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name));
    assert.deepEqual(f.db.pragma("foreign_key_check"),[]);
    assert.equal(f.db.pragma("integrity_check",{simple:true}),"ok");
    f.db.close();manager = new StorageManager({enabled:true,databasePath:f.file});
    await manager.start();assert.equal((await manager.request("storage.status")).migrations.length,25);
    await manager.close();manager = null;
    const reopened = new Database(f.file,{readonly:true});
    try {assert.deepEqual(facts(reopened),f.before);} finally {reopened.close();}
    await assert.rejects(repair009(f.file,{checkOnly:false,backupPath:join(f.dir,"second.sqlite")}),{code:"STORAGE_009_REPAIR_REFUSED"});
    assert.equal(existsSync(join(f.dir,"second.sqlite")),false);
  } finally {if(manager)await manager.close();f.close();}
});

for (const [name,sql,code] of [
  ["unknown 009 checksum","UPDATE schema_migrations SET checksum='unknown' WHERE version=9","STORAGE_009_REPAIR_REFUSED"],
  ["edited earlier migration","UPDATE schema_migrations SET checksum='unknown' WHERE version=1","STORAGE_009_REPAIR_REFUSED"],
  ["unexpected schema","CREATE TABLE unexpected(value TEXT)","STORAGE_009_REPAIR_REFUSED"],
  ["partial manual repair","CREATE TABLE analysis_inputs(value TEXT)","STORAGE_009_REPAIR_REFUSED"],
  ["active writer",`INSERT INTO storage_writer_owner VALUES(1,'fixture',${process.pid},'2026-10-16')`,"STORAGE_WRITER_ACTIVE"]
]) test(`009 repair refuses ${name} before creating a backup or changing data`,async()=>{
  const f = fixture();
  try {
    f.db.exec(sql);const before = f.db.prepare("SELECT * FROM schema_migrations").all();
    await assert.rejects(repair009(f.file,{checkOnly:false,backupPath:f.backup}),{code});
    assert.equal(existsSync(f.backup),false);assert.deepEqual(facts(f.db),f.before);
    assert.deepEqual(f.db.prepare("SELECT * FROM schema_migrations").all(),before);
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='signal_changes_instrument_sequence'").get(),undefined);
  } finally {f.close();}
});

test("009 repair requires a new verified backup and never overwrites an existing destination",async()=>{
  const f = fixture();
  try {
    await assert.rejects(repair009(f.file,{checkOnly:false}),{code:"STORAGE_009_REPAIR_REFUSED"});
    const existing = new Database(f.backup);existing.exec("CREATE TABLE keep(value INTEGER);INSERT INTO keep VALUES(42)");existing.close();
    await assert.rejects(repair009(f.file,{checkOnly:false,backupPath:f.backup}),{code:"EEXIST"});
    const untouched = new Database(f.backup,{readonly:true});
    try {assert.equal(untouched.prepare("SELECT value FROM keep").get().value,42);} finally {untouched.close();}
    assert.equal(f.db.prepare("SELECT checksum FROM schema_migrations WHERE version=9").get().checksum,oldChecksum);
    assert.deepEqual(facts(f.db),f.before);
  } finally {f.close();}
});
