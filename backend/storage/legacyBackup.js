import { mkdir, readFile, writeFile, copyFile, chmod, readdir, statfs } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function checkStorageVolume(databasePath) {
  const dir=path.dirname(databasePath);await mkdir(dir,{recursive:true,mode:0o700});const fs=await statfs(dir);
  if([0x6969,0xff534d42,0xfe534d42].includes(Number(fs.type)))throw Object.assign(Error('SQLite necesita almacenamiento local con WAL y bloqueo.'),{code:'STORAGE_NETWORK_FILESYSTEM'});
  const availableBytes=Number(fs.bavail)*Number(fs.bsize);
  if(availableBytes<128*1024*1024)throw Object.assign(Error('Espacio insuficiente para migración y WAL.'),{code:'STORAGE_DISK_SPACE'});
  return {filesystemType:Number(fs.type),availableBytes};
}
// Explicit offline tool only; startup never triggers migration or activation.
export async function backupLegacy(paths, directory) {
  await mkdir(directory,{recursive:true,mode:0o700});const files=[],manifest=[];
  for(const [kind,value] of Object.entries(paths)) {
    if(['snapshots','audits'].includes(kind))files.push(...Object.entries(value).map(([name,p])=>[name,p]));
    else if(kind!=='candlesDir')files.push([kind,value]);
  }
  async function walk(dir){if(!dir)return;try{for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.isFile()&&/\.jsonl?$/.test(p))files.push(['market',p]);}}catch(e){if(e.code!=='ENOENT')throw e;}}
  await walk(paths.candlesDir);
  for(const [kind,source]of files){
    if(!source)continue;let bytes;
    try{bytes=await readFile(source);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    const sha256=hash(bytes),backup=path.join(directory,`${manifest.length}-${kind}-${randomUUID()}.backup`);
    await copyFile(source,backup);await chmod(backup,0o600);
    if(hash(await readFile(backup))!==sha256||hash(await readFile(source))!==sha256)throw Object.assign(Error('Origen cambiante; detener sus escritores y repetir.'),{code:'STORAGE_IMPORT_SOURCE_CHANGED'});
    manifest.push({kind,source,backup,bytes:bytes.length,sha256});
  }
  const result={verified:true,files:manifest};await writeFile(path.join(directory,'manifest.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
}
export async function verifyLegacyBackup(manifest){
  for(const file of manifest.files)if(hash(await readFile(file.backup))!==file.sha256||hash(await readFile(file.source))!==file.sha256)throw Object.assign(Error('El origen o backup cambió; no activar la candidata.'),{code:'STORAGE_IMPORT_SOURCE_CHANGED'});
  return {verified:true,files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0)};
}
