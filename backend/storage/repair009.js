// Offline, opt-in reconciliation of the exact pre-release 009 observed in use.
// Startup still rejects every migration checksum mismatch.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createStorageBackup } from "./backup.js";
import { assertWriterAvailable } from "./writerOwnership.js";

const directory = new URL("./migrations/", import.meta.url);
const legacyChecksum = "9a6457bd9e00ceab72bddcab93fa8a236aedef75da20af636942608f1753b732";
const currentChecksum = "4551490865d0c8ef40df65cc9c7057d5ed3b30a40e6c2f3dede4ba556398d778";
const digest = sql => createHash("sha256").update(sql).digest("hex");
const schema = db => db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name!='schema_migrations' ORDER BY type,name").all();
function fail(message) { throw Object.assign(new Error(message), {code:"STORAGE_009_REPAIR_REFUSED"}); }

function definition() {
  const migrations = readdirSync(directory).filter(name => /^00[1-9]_.*\.sql$/.test(name)).sort().map(name => ({
    name, sql:readFileSync(new URL(name,directory),"utf8")
  }));
  const sql = migrations.at(-1)?.sql;
  const prefix = sql?.split("\n").slice(0,27).join("\n") + "\n";
  if (migrations.length !== 9 || digest(sql) !== currentChecksum || digest(prefix) !== legacyChecksum) {
    fail("Los archivos de migración no coinciden con la reparación revisada de 009.");
  }
  return {migrations, prefix, suffix:sql.slice(prefix.length)};
}

function validate(db, definition, checksum) {
  assertWriterAvailable(db);
  const rows = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
  if (rows.length !== 9 || rows.some((row,index) => row.version !== index+1 || row.name !== definition.migrations[index].name || row.checksum !== (row.version === 9 ? checksum : digest(definition.migrations[index].sql)))) {
    fail("Se requiere exactamente 001–008 vigentes y la variante conocida de 009; no se cambió la base.");
  }
  const reference = new Database(":memory:");
  try {
    for (const migration of definition.migrations) reference.exec(migration.name.startsWith("009_") && checksum === legacyChecksum ? definition.prefix : migration.sql);
    if (JSON.stringify(schema(db)) !== JSON.stringify(schema(reference))) fail("El esquema difiere de la variante conocida; requiere revisión manual.");
  } finally { reference.close(); }
}

export async function repair009(databasePath, {checkOnly = true, backupPath} = {}) {
  const expected = definition();
  const reader = new Database(databasePath,{readonly:true,fileMustExist:true});
  try { validate(reader,expected,legacyChecksum); }
  finally { reader.close(); }
  const changes = ["signal_changes_instrument_sequence","article_revisions_publication","analysis_inputs"];
  if (checkOnly) return {databasePath,repairable:true,mode:"read-only",changes};
  if (!backupPath) fail("La reparación requiere un destino nuevo para el backup.");
  const backup = await createStorageBackup(databasePath,backupPath);
  const db = new Database(databasePath,{fileMustExist:true,timeout:2000});
  try {
    db.pragma("synchronous=FULL");
    db.pragma("foreign_keys=ON");
    db.transaction(() => {
      // Recheck under the write lock after backup; another process may have started.
      validate(db,expected,legacyChecksum);
      db.exec(expected.suffix);
      db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=9 AND checksum=?").run(currentChecksum,legacyChecksum);
      validate(db,expected,currentChecksum);
    }).immediate();
    return {databasePath,repaired:true,backup,changes};
  } finally { db.close(); }
}
