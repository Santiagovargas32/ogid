// Resume verification of a consistent validation copy. Never migrates or writes.
import Database from 'better-sqlite3';
import {readFileSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import dotenv from 'dotenv';
const [file,output,cacheText='256']=process.argv.slice(2),cacheMiB=Number(cacheText),backend=fileURLToPath(new URL('../',import.meta.url));
if(!file||!output||!Number.isSafeInteger(cacheMiB)||cacheMiB<16||cacheMiB>512)throw Error('Usage: agent-verify-copy COPY.sqlite report.json [cacheMiB=256, 16..512]');
const env=dotenv.parse(readFileSync(resolve(backend,'.env'))),copy=realpathSync(file),original=realpathSync(env.STORAGE_DB_PATH),a=statSync(copy),b=statSync(original);
if(copy===original||(a.dev===b.dev&&a.ino===b.ino))throw Error('A separate validation copy is required');
const report={startedAt:new Date().toISOString(),copy,readOnly:true,validationCacheMiB:cacheMiB,cacheScope:'this verification connection only; backend settings unchanged'};
const db=new Database(copy,{readonly:true,fileMustExist:true});
try{
 db.pragma('query_only=ON');db.pragma(`cache_size=-${cacheMiB*1024}`);
 const directory=resolve(backend,'storage/migrations'),files=readdirSync(directory).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort();
 const applied=db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all();
 if(applied.length!==files.length||applied.some((m,i)=>m.name!==files[i]||createHash('sha256').update(readFileSync(resolve(directory,m.name))).digest('hex')!==m.checksum))throw Error('STORAGE_SCHEMA_MISMATCH');
 report.migrations=applied.map(m=>({version:m.version,name:m.name}));
 console.log(JSON.stringify({phase:'integrity-check',cacheMiB,readOnly:true}));
 report.integrity=db.pragma('integrity_check',{simple:true});report.foreignKeys=db.pragma('foreign_key_check');
 if(report.integrity!=='ok'||report.foreignKeys.length)throw Error('COPY_INTEGRITY_FAILED');
 report.historicalCounts=Object.fromEntries(['articles','article_revisions','events','candles','analysis_runs'].map(t=>[t,db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
 report.status='passed';
}catch(e){report.status='failed';report.errorCode=e.code||e.message;process.exitCode=1;}
finally{db.close();report.finishedAt=new Date().toISOString();writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({status:report.status,errorCode:report.errorCode||null,output}));}
