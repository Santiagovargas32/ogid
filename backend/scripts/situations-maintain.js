import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {StorageManager} from '../storage/StorageManager.js';
import {SituationStore} from '../storage/situations.js';
import {assertWriterAvailable} from '../storage/writerOwnership.js';

// Bounded maintenance through the normal business writer. No server, providers
// or inference; an interrupted run resumes the same durable journal cursors.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const argv=process.argv.slice(2),apply=argv.includes('--apply');
let maxPages=100,limit=100;
for(const arg of argv){
 if(arg==='--apply')continue;
 const match=/^--(max-pages|limit)=([1-9][0-9]*)$/.exec(arg);
 if(!match||!Number.isSafeInteger(Number(match[2])))throw Error('Uso: npm run situations:maintain -- [--apply] [--max-pages=N] [--limit=1..100]');
 if(match[1]==='max-pages')maxPages=Number(match[2]);else limit=Number(match[2]);
}
if(limit>100)throw Error('Límite máximo: 100 referencias por página.');
const envFile=path.join(root,'.env'),env={...(existsSync(envFile)?dotenv.parse(readFileSync(envFile)):{}),...process.env};
const file=env.STORAGE_DB_PATH;
if(!file||!path.isAbsolute(file))throw Error('STORAGE_DB_PATH absoluto requerido.');
const reader=new Database(file,{readonly:true,fileMustExist:true});reader.pragma('query_only=ON');
const expected=Math.max(...readdirSync(path.join(root,'storage/migrations')).filter(n=>/^\d+_.*\.sql$/.test(n)).map(n=>Number.parseInt(n,10)));
const schema=reader.prepare('SELECT max(version) AS n FROM schema_migrations').get().n;
if(schema!==expected){reader.close();throw Error('Migrar explícitamente al esquema vigente antes del mantenimiento.');}
const store=new SituationStore(reader),before=store.status(),startedAt=new Date().toISOString();
const emit=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
if(!apply){emit({event:'status',schema,apply:false,state:before});reader.close();}
else{
 let manager,stopping=false,pages=0,state=before,lastReport=0;
 const timings=[],commits=[],pause=()=>{stopping=true;};
 const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
 process.on('SIGINT',pause);process.on('SIGTERM',pause);
 try{
  assertWriterAvailable(reader);
  manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});await manager.start();
  emit({event:'started',startedAt,schema,state:before});
  while(!stopping&&pages<maxPages&&state.hasMore){
   try{state=await manager.request('agent.call',{method:'alertSync',args:{limit,budgetMs:50}});}
   catch(error){if(error.code!=='STORAGE_WAL_BACKPRESSURE')throw error;await manager.request('storage.checkpoint');await wait(100);continue;}
   pages++;const command=manager.recentCommands.at(-1);
   timings.push(command.executionMs);if(Number.isFinite(command.commitMs))commits.push(command.commitMs);
   if(Date.now()-lastReport>=5000||!state.hasMore||pages===maxPages){emit({event:'progress',pages,state,executionMs:command.executionMs,commitMs:command.commitMs});lastReport=Date.now();}
   if(manager.checkpoint?.pending)await manager.request('storage.checkpoint');
   await wait(0);
  }
  await manager.close();manager=null;
  const durable=store.status();
  if(JSON.stringify(durable.streams)!==JSON.stringify(state.streams)||durable.domainSequence!==state.domainSequence)throw Error('SITUATION_DURABLE_CURSOR_MISMATCH');
  emit({event:durable.hasMore?'paused':'completed',startedAt,pages,state:durable,
   timing:{executionP95:percentile(timings,.95),executionMax:timings.length?Math.max(...timings):null,commitP95:percentile(commits,.95),commitMax:commits.length?Math.max(...commits):null},
   ownerReleased:!reader.prepare('SELECT 1 FROM storage_writer_owner LIMIT 1').get()});
 }catch(error){emit({event:'failed',code:error.code||error.message,state:store.status()});process.exitCode=1;}
 finally{await manager?.close();reader.close();process.off('SIGINT',pause);process.off('SIGTERM',pause);}
}
