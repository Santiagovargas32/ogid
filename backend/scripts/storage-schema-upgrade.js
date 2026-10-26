import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import dotenv from 'dotenv';
import {migrate} from '../storage/migrate.js';
import {acquireWriter,releaseWriter} from '../storage/writerOwnership.js';

// Explicit maintenance command: no server, data import, backup or integrity scan.
if(process.argv.slice(2).join(' ')!=='--apply')throw new Error('Uso: node scripts/storage-schema-upgrade.js --apply');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const env=dotenv.parse(readFileSync(path.join(root,'.env')));
if(!env.STORAGE_DB_PATH||!path.isAbsolute(env.STORAGE_DB_PATH))throw new Error('STORAGE_DB_PATH absoluto requerido en backend/.env');
const db=new Database(env.STORAGE_DB_PATH,{fileMustExist:true,timeout:5000}),token=randomUUID();
let owned=false;
try{
  db.pragma('foreign_keys=ON');
  acquireWriter(db,token);owned=true;
  const before=db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version;
  const applied=migrate(db);
  console.log(JSON.stringify({database:env.STORAGE_DB_PATH,before,after:applied.at(-1).version,applied:applied.filter(row=>row.version>before)},null,2));
}finally{try{if(owned)releaseWriter(db,token);}finally{db.close();}}
