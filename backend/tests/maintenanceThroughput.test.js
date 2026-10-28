import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import {migrate} from '../storage/migrate.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {StorageManager} from '../storage/StorageManager.js';
import {createBusinessAdapters} from '../storage/businessAdapters.js';
import {AgentMaintenance} from '../services/agent/maintenance.js';
import {createServer} from 'node:http';

test('a real journal commit completes before a pending RSS HTTP response is released',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-rss-journal-')),file=join(dir,'fixture.sqlite'),at=new Date().toISOString();
 const db=new Database(file);db.pragma('journal_mode=WAL');migrate(db);const archive=new SqlNewsArchive(db,{analysisOnly:true});
 try{db.transaction(()=>{for(let n=0;n<200;n++)archive.save({id:'pending-'+n,title:'Missile strike in Kyiv',url:'https://example.org/pending-'+n,publishedAt:at,receivedAt:at,archiveLastSeenAt:at,revision:1});})();}finally{archive.close();db.close();}
 let received,release;const started=new Promise(resolve=>{received=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const server=createServer(async(_req,res)=>{received();await gate;res.end('<rss><channel></channel></rss>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});let rss,page;
 try{
  await manager.start();await manager.request('domain.configure',{rootDir:dir,instruments:[],news:{providers:['rss'],rssFeeds:[{url:`http://127.0.0.1:${server.address().port}/pending`,label:'Pending fixture'}]},rss:{rssFeeds:[]}});
  rss=manager.request('domain.call',{service:'rss',method:'refresh',args:[{force:true}]});rss.catch(()=>{});await started;
  page=manager.request('agent.call',{method:'alertSync',args:{limit:100,budgetMs:50}});page.catch(()=>{});
  const result=await Promise.race([page,wait(1500).then(()=>null)]);
  assert.ok(result&&result.processed>0,'durable progress cannot depend on the external RSS response');
  assert.ok([...manager.active.values()].some(entry=>entry.workflow),'the acquisition is still awaiting its response');
 }finally{release();await Promise.allSettled([rss,page].filter(Boolean));await manager.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('one maintenance timer catches up with acquisition while analysis is pending and preserves the journal across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-maintenance-load-')),file=join(dir,'fixture.sqlite'),at=new Date().toISOString();
 const article=n=>({id:'load-'+n,revision:1,contentRevision:1,title:'Missile strike in Kyiv',url:'https://example.org/load-'+n,publishedAt:at,receivedAt:at,archiveLastSeenAt:at,classification:{language:'en'},usagePolicy:'headline-only-link-out'});
 const db=new Database(file);db.pragma('journal_mode=WAL');migrate(db);const archive=new SqlNewsArchive(db,{analysisOnly:true});
 try{db.transaction(()=>{for(let n=0;n<1000;n++)archive.save(article(n));})();}finally{archive.close();db.close();}
 let manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file}),maintenance,release,entered,analysisCalls=0,pages=0;
 const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;}),progress=[];
 try{
  await manager.start();await manager.request('domain.configure',{instruments:[],rootDir:dir,researchSources:[],rss:{rssFeeds:[]}});
  const adapters=createBusinessAdapters(manager);
  maintenance=new AgentMaintenance({enabled:true,dependencies:()=>manager.request('runtime.load',{kind:'maintenance-inputs'}),call:async()=>{
   const result=await manager.request('agent.call',{method:'alertSync',args:{limit:100,budgetMs:50}});pages++;progress.push(result.streams.find(s=>s.stream==='news').lastSequence);return result;
  },business:{advanced:{getSnapshot:async()=>{analysisCalls++;entered();await gate;}},conditions:{getSnapshot:async()=>{}},forecasts:{evaluate:async()=>{}}}});
  const began=performance.now();maintenance.start();await started;
  const beforeAcquisitionPages=pages;
  for(let batch=0;batch<20;batch++){
   await adapters.news.ingest(Array.from({length:25},(_,n)=>article(1000+batch*25+n)));await wait(250);
  }
  assert.ok(pages>beforeAcquisitionPages,'control pages must advance during acquisition, before analysis finishes');
  let status;for(let attempt=0;attempt<300;attempt++){
   status=await adapters.situations.status();if(!status.hasMore)break;await wait(100);
  }
  assert.equal(status.hasMore,false,'the consumer must reach the journal head while analysis remains pending');assert.equal(analysisCalls,1);assert.ok(pages>10);assert.ok(maintenance.analyticalTask);
  assert.equal(manager.queryManager.getStatus().queryOnly,true);assert.equal(status.errorCode,null);
  assert.ok(progress.every((value,i)=>i===0||value>=progress[i-1]));
  release();await maintenance.stop();await manager.close();
  const before=new Database(file,{readonly:true});let emissions;try{emissions=before.prepare('SELECT count(*) n FROM situation_outbox').get().n;assert.equal(before.prepare('SELECT count(*) n FROM articles').get().n,1500);assert.equal(before.prepare('SELECT count(*) n FROM storage_writer_owner').get().n,0);}finally{before.close();}
  manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:file});await manager.start();
  const idle=await manager.request('agent.call',{method:'alertSync',args:{}});assert.equal(idle.processed,0);assert.equal(idle.hasMore,false);assert.equal(idle.outboxSequence,emissions);
  console.log(JSON.stringify({fixtureOnly:true,articles:1500,initialBacklog:1000,acquisition:{batches:20,perBatch:25,minimumIntervalMs:250},pages,durationMs:Math.round(performance.now()-began),analyticalSweeps:analysisCalls,emissions}));
 }finally{release();await maintenance?.stop();await manager.close();rmSync(dir,{recursive:true,force:true});}
});
