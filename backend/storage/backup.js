import Database from "better-sqlite3";
import { mkdirSync, openSync, closeSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export async function createStorageBackup(sourcePath, destinationPath) {
  const source = path.resolve(sourcePath), destination = path.resolve(destinationPath);
  if (source === destination) throw new Error("El backup debe usar otra ruta.");
  const db = new Database(source, {readonly:true, fileMustExist:true});
  let created = false;
  try {
    mkdirSync(path.dirname(destination), {recursive:true, mode:0o700});
    closeSync(openSync(destination, "wx", 0o600));
    created = true;
    await db.backup(destination);
    const restored = new Database(destination, {readonly:true, fileMustExist:true});
    let integrity, foreignKeys;
    try { integrity = restored.pragma("integrity_check"); foreignKeys = restored.pragma("foreign_key_check"); }
    finally { restored.close(); }
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || foreignKeys.length) throw new Error("Backup inválido: falló integrity_check o foreign_key_check.");
    return {source, destination, verified:true, bytes:statSync(destination).size};
  } catch (error) {
    if (created) rmSync(destination, {force:true});
    throw error;
  } finally { db.close(); }
}
