import Database from "better-sqlite3";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const checks = {
  integrity: {sql:"PRAGMA main.integrity_check(1)", ok:row=>row?.integrity_check==="ok"},
  "foreign-keys": {sql:"PRAGMA main.foreign_key_check", ok:row=>row===undefined}
};

function identity(filename) {
  const s = statSync(filename,{bigint:true});
  return Object.fromEntries(["dev","ino","size","mtimeNs","ctimeNs"].map(key=>[key,String(s[key])]));
}

function requireStandalone(filename) {
  // Publishing a main file cannot also publish an outstanding SQLite journal.
  for (const suffix of ["-wal","-journal"]) {
    if (lstatSync(filename+suffix,{throwIfNoEntry:false})?.size) {
      throw Object.assign(new Error("El candidato tiene un journal pendiente."),{code:"BACKUP_JOURNAL_PRESENT"});
    }
  }
}

function syncPath(filename) {
  const fd = openSync(filename,"r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function verify(filename, units) {
  requireStandalone(filename);
  const before = identity(filename);
  const db = new Database(filename,{readonly:true,fileMustExist:true});
  try {
    db.pragma("query_only=ON");
    db.pragma("cache_size=-131072");
    const proof = db.transaction(() => {
      const engine = db.prepare("SELECT sqlite_version() AS sqliteVersion, sqlite_source_id() AS sqliteSourceId").get();
      const schemaCookie = db.pragma("main.schema_version",{simple:true});
      const hasLedger = db.prepare("SELECT 1 FROM pragma_table_info('schema_migrations') WHERE name='version' AND upper(type)='INTEGER' AND pk=1").pluck().get();
      const migrationVersion = hasLedger ? db.prepare("SELECT max(version) FROM main.schema_migrations").pluck().get() : null;
      const results = units.map(unit => {
        const {sql,ok} = checks[unit], start = performance.now();
        // A clean FK check must reach EOF. A single violation rejects the copy.
        const row = db.prepare(sql).get();
        if (!ok(row)) throw Object.assign(new Error("Backup inválido: "+sql),{code:"BACKUP_CHECK_FAILED",unit});
        return {unit,sql,complete:true,elapsedMs:performance.now()-start};
      });
      return {...engine,schemaCookie,migrationVersion,results};
    }).deferred();
    requireStandalone(filename);
    const after = identity(filename);
    if (Object.keys(before).some(key=>before[key]!==after[key])) {
      throw Object.assign(new Error("La identidad del candidato cambió."),{code:"BACKUP_IDENTITY_CHANGED"});
    }
    return {...proof,identity:after};
  } finally { db.close(); }
}

export function checkStorageCandidate(candidatePath, unit) {
  if (!Object.hasOwn(checks,unit)) throw new Error("Prueba de backup desconocida.");
  return {candidate:path.resolve(candidatePath),verified:false,...verify(candidatePath,[unit])};
}

async function copyBackup(sourcePath, destinationPath, verifyBeforePublishing) {
  const source = path.resolve(sourcePath), destination = path.resolve(destinationPath);
  if (source === destination) throw new Error("El backup debe usar otra ruta.");
  const dir = path.dirname(destination);
  mkdirSync(dir,{recursive:true,mode:0o700});
  const target = path.join(realpathSync(dir),path.basename(destination));
  const sources = [source,realpathSync(source)];
  if (sources.some(file=>["-wal","-shm","-journal"].some(suffix=>target===file+suffix))) {
    throw new Error("El destino es un archivo auxiliar del origen.");
  }
  const requireUnusedName = () => {
    for (const suffix of ["","-wal","-shm","-journal"]) {
      if (lstatSync(destination+suffix,{throwIfNoEntry:false})) {
        throw Object.assign(new Error("El nombre del backup ya está en uso."),{code:"EEXIST"});
      }
    }
  };
  requireUnusedName();
  const staging = mkdtempSync(path.join(dir,".ogid-backup-"));
  const file = path.join(staging,"copy.sqlite");
  let primaryError;
  try {
    closeSync(openSync(file,"wx",0o600));
    const db = new Database(source,{readonly:true,fileMustExist:true});
    try { await db.backup(file); } finally { db.close(); }
    requireStandalone(file);
    if (verifyBeforePublishing) verify(file,Object.keys(checks));
    syncPath(file);
    requireUnusedName();
    // A stopped copy stays under its private staging name. Concurrent captures
    // cannot replace the first published file.
    linkSync(file,destination);
    syncPath(dir);
  } catch (error) {
    primaryError=error;
    throw error;
  } finally {
    try { rmSync(staging,{recursive:true,force:true}); }
    catch (error) {
      if (!primaryError) throw error;
      primaryError.cleanupError=error;
    }
  }
  return {source,destination,verified:verifyBeforePublishing,bytes:statSync(destination).size,identity:identity(destination)};
}

export function createStorageBackup(source, destination) {
  return copyBackup(source,destination,true);
}

export function captureStorageCandidate(source, destination) {
  return copyBackup(source,destination,false);
}
