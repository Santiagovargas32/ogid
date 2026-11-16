import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {readRuntimeLimit,armRuntimeLimit} from '../utils/runtimeLimit.js';
import {createAppServer} from '../server.js';

const backend=fileURLToPath(new URL('../',import.meta.url));
const fixtureOverrides={port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:false,businessEnabled:false},news:{providers:[],rssFeeds:[]},market:{enabled:false,historyPersist:false},awareness:{mode:'off'}};

test('runtime duration is absent by default and accepts one positive integer in the Node timer range',()=>{
 assert.equal(readRuntimeLimit([]),null);
 assert.equal(readRuntimeLimit(['--reconcile-market-jobs','fixture.json']),null);
 assert.equal(readRuntimeLimit(['--run-for-ms=1']),1);
 assert.equal(readRuntimeLimit(['--run-for-ms=2500']),2500);
 assert.equal(readRuntimeLimit(['--run-for-ms=2147483647']),2147483647);
 for(const args of [['--run-for-ms'],['--run-for-ms','2500'],['--run-for-ms='],['--run-for-ms=0'],['--run-for-ms=-1'],['--run-for-ms=1.5'],['--run-for-ms=1e3'],['--run-for-ms=Infinity'],['--run-for-ms=NaN'],['--run-for-ms=2147483648'],['--run-for-ms=999999999999999999999'],['--run-for-ms=1','--run-for-ms=2']])
  assert.throws(()=>readRuntimeLimit(args),{code:'INVALID_RUNTIME_LIMIT'});
});

test('an armed run bound invokes ordinary shutdown once and cancellation removes that obligation',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const signals=[];
 armRuntimeLimit(null,signal=>signals.push(signal));t.mock.timers.tick(5000);assert.deepEqual(signals,[]);
 const cancel=armRuntimeLimit(2500,signal=>signals.push(signal));t.mock.timers.tick(2499);assert.deepEqual(signals,[]);
 t.mock.timers.tick(1);assert.deepEqual(signals,['runtime-limit']);t.mock.timers.tick(10000);assert.equal(signals.length,1);cancel();
 const prevent=armRuntimeLimit(2500,signal=>signals.push(signal));prevent();t.mock.timers.tick(2500);assert.equal(signals.length,1);
});

const eventsAt=path=>{
 let raw;try{raw=readFileSync(path,'utf8');}catch(error){if(error.code==='ENOENT')return [];throw error;}
 return raw.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
};
async function until(check,description,maxMs=8000){
 const until=performance.now()+maxMs;
 while(performance.now()<until){const value=await check();if(value)return value;await pause(20);}
 throw Error('Timed out waiting for '+description);
}
function running(pid){
 try{const stat=readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]!=='Z';}
 catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return false;throw error;}
}

test('bounded backend fixture shuts itself down after its detached launcher disappears',{skip:process.platform!=='linux'},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-runtime-limit-')),logPath=join(directory,'backend.log'),marker=basename(directory);
 const source=`const fixtureMarker=${JSON.stringify(marker)};process.argv=[process.execPath,'runtime-limit-fixture','--run-for-ms=2500'];const {run}=await import(${JSON.stringify(new URL('../server.js',import.meta.url).href)});await run(${JSON.stringify(fixtureOverrides)});`;
 const ownerSource=`const {spawn}=require('node:child_process');const fs=require('node:fs');const fd=fs.openSync(${JSON.stringify(logPath)},'a',0o600);const child=spawn(process.execPath,['--require',${JSON.stringify(resolve(backend,'tests/testSetup.cjs'))},'--input-type=module','--eval',${JSON.stringify(source)}],{cwd:${JSON.stringify(backend)},env:{...process.env,NODE_ENV:'test'},detached:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);child.unref();process.send({pid:child.pid});setInterval(()=>{},10000);`;
 const owner=spawn(process.execPath,['--eval',ownerSource],{cwd:backend,env:{...process.env,NODE_ENV:'test'},stdio:['ignore','ignore','pipe','ipc']});
 const ownerExit=once(owner,'exit');let childPid;
 try{
  const [message]=await Promise.race([once(owner,'message'),ownerExit.then(()=>{throw Error('Fixture launcher exited before reporting child');})]);childPid=message.pid;assert.ok(Number.isSafeInteger(childPid));
  const started=await until(()=>eventsAt(logPath).find(row=>row.message==='server_started'),'fixture readiness');
  assert.equal(running(childPid),true);assert.equal(readFileSync(`/proc/${childPid}/task/${childPid}/children`,'utf8').trim(),'');
  const base=`http://127.0.0.1:${started.port}`;
  const alive=await fetch(base+'/api/health/live',{signal:AbortSignal.timeout(1000)});await alive.body?.cancel();assert.equal(alive.status,200);
  owner.kill('SIGKILL');const [code,signal]=await ownerExit;assert.equal(code,null);assert.equal(signal,'SIGKILL');
  assert.equal(running(childPid),true,'launcher loss must precede backend self-shutdown');
  await until(()=>!running(childPid),'bounded backend exit');
  const events=eventsAt(logPath),shutdown=events.filter(row=>row.message==='shutdown_signal_received'),stopped=events.filter(row=>row.message==='server_stopped');
  assert.equal(events.filter(row=>row.message==='runtime_limit_armed').length,1);assert.equal(shutdown.length,1);assert.equal(shutdown[0].signal,'runtime-limit');assert.equal(stopped.length,1);
  assert.equal(stopped[0].primaryCause,null);assert.deepEqual(stopped[0].cleanupErrors,[]);assert.deepEqual(stopped[0].unconfirmedPersistence,[]);
  assert.equal(events.some(row=>row.message==='startup_failed'||row.message==='shutdown_failed'),false);
  await assert.rejects(fetch(base+'/api/health/live',{signal:AbortSignal.timeout(500)}));
 }finally{
  if(owner.exitCode===null&&owner.signalCode===null){owner.kill('SIGKILL');await ownerExit;}
  if(childPid&&running(childPid)){
   const command=readFileSync(`/proc/${childPid}/cmdline`,'utf8');if(command.includes(marker)){process.kill(childPid,'SIGKILL');await until(()=>!running(childPid),'fixture cleanup');}
  }
  rmSync(directory,{recursive:true,force:true});
 }
});

test('stopping a startup phase waits for it and prevents later service activation',async t=>{
 const runtime=createAppServer({...fixtureOverrides,disableBackgroundRefresh:false});let release,entered;
 const gate=new Promise(resolve=>release=resolve),atGate=new Promise(resolve=>entered=resolve),activations=[];
 t.mock.method(runtime.storageManager,'start',async()=>{entered();await gate;});
 t.mock.method(runtime.app.locals.runtimeMetrics,'start',()=>activations.push('metrics'));
 for(const [name,component]of [['orchestrator',runtime.orchestrator],['awareness',runtime.awarenessService],['maintenance',runtime.app.locals.agentMaintenance],['agent',runtime.app.locals.agentRuntime]])t.mock.method(component,'start',async()=>{activations.push(name);});
 const starting=runtime.start(),rejection=assert.rejects(starting,{code:'STORAGE_NOT_READY'});let stopping;
 try{
  await atGate;assert.equal(runtime.server.listening,true);stopping=runtime.stop();assert.equal(runtime.stop(),stopping);
  let settled=false;stopping.then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  release();await rejection;await stopping;
  assert.deepEqual(activations,[]);assert.equal(runtime.server.listening,false);assert.equal(runtime.app.locals.runtimeMetrics.ready,false);
  assert.deepEqual(runtime.app.locals.shutdownReport.cleanupErrors,[]);assert.deepEqual(runtime.app.locals.shutdownReport.unconfirmedPersistence,[]);
  assert.equal(runtime.start(),starting);await assert.rejects(runtime.start(),{code:'STORAGE_NOT_READY'});
 }finally{release();await starting.catch(()=>{});await runtime.stop();}
});

test('run duration expiring during real SQLite startup drains once without reporting startup failure',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-runtime-startup-limit-')),databasePath=join(directory,'fixture.sqlite');
 const overrides={...fixtureOverrides,storage:{enabled:true,businessEnabled:false,databasePath}};
 const source=`process.argv=[process.execPath,'startup-limit-fixture','--run-for-ms=1'];const {run}=await import(${JSON.stringify(new URL('../server.js',import.meta.url).href)});await run(${JSON.stringify(overrides)});`;
 const child=spawn(process.execPath,['--require',resolve(backend,'tests/testSetup.cjs'),'--input-type=module','--eval',source],{cwd:backend,env:{...process.env,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const closed=once(child,'close');let output='',errors='';
 child.stdout.on('data',bytes=>{output+=bytes.toString();});child.stderr.on('data',bytes=>{errors+=bytes.toString();});
 try{
  await until(()=>child.exitCode!==null||child.signalCode!==null,'startup-limited fixture exit');
  const [code,signal]=await closed;assert.equal(code,0,output+errors);assert.equal(signal,null);
  const events=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const shutdown=events.filter(row=>row.message==='shutdown_signal_received'),stopped=events.filter(row=>row.message==='server_stopped');
  assert.equal(events.filter(row=>row.message==='runtime_limit_armed').length,1);
  assert.equal(shutdown.length,1);assert.equal(shutdown[0].signal,'runtime-limit');assert.equal(stopped.length,1);
  assert.equal(events.some(row=>['startup_failed','shutdown_failed','server_started'].includes(row.message)),false,output+errors);
  assert.equal(stopped[0].primaryCause,null);assert.deepEqual(stopped[0].cleanupErrors,[]);assert.deepEqual(stopped[0].unconfirmedPersistence,[]);
  const listening=events.find(row=>row.message==='http_listening');assert.ok(listening,'shutdown must occur while the listening server is still starting');
  await assert.rejects(fetch(`http://127.0.0.1:${listening.port}/api/health/live`,{signal:AbortSignal.timeout(500)}));
  const db=new Database(databasePath,{readonly:true,fileMustExist:true});try{db.pragma('query_only=ON');assert.equal(db.prepare('SELECT count(*) n FROM storage_writer_owner').get().n,0);}finally{db.close();}
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}
  rmSync(directory,{recursive:true,force:true});
 }
});
