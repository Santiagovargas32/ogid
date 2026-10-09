import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createStorageBackup } from "../storage/backup.js";

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
