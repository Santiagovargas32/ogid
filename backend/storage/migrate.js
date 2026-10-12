import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
function fail(code) { throw Object.assign(new Error(code), { code }); }
export function migrate(database, directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations")) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT");
  const files = readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length) fail("STORAGE_MIGRATIONS_MISSING");
  const applied = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  const migrations = files.map(name => { const sql = readFileSync(path.join(directory, name), "utf8"); return { version: Number(name.slice(0, 3)), name, sql, checksum: createHash("sha256").update(sql).digest("hex") }; });
  if (new Set(migrations.map(m => m.version)).size !== migrations.length) fail("STORAGE_MIGRATION_DUPLICATE");
  for (const row of applied) {
    const migration = migrations.find(m => m.version === row.version);
    if (!migration) fail("STORAGE_SCHEMA_AHEAD");
    if (row.checksum !== migration.checksum || row.name !== migration.name) fail("STORAGE_MIGRATION_MISMATCH");
  }
  for (const migration of migrations) if (!applied.some(row => row.version === migration.version)) {
    if (applied.some(row => row.version > migration.version)) fail("STORAGE_MIGRATION_GAP");
    database.transaction(() => {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?)").run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    }).immediate();
  }
  return database.prepare("SELECT version,name,applied_at AS appliedAt FROM schema_migrations ORDER BY version").all();
}
