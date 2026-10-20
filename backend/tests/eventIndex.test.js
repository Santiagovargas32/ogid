import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';import {BusinessRuntime} from '../storage/businessRuntime.js';import{SqlEventLedger,SqlResearchStore}from'../storage/sqlRepositories.js';import{eventIndexView}from'../storage/eventIndex.js';import{listVerifiedInstruments}from'../services/market/instrumentRegistry.js';
test('registry publishes only a complete generation, resumes pages and dual-writes revisions behind the cursor',()=>{
 const db=new Database(':memory:');migrate(db);const runtime=new BusinessRuntime(db,()=>{}),universe=listVerifiedInstruments(),i=universe[0];
 const value=n=>({eventId:`e-${String(n).padStart(4,'0')}`,identityVersion:'source-publication-v2',quality:{identityVerified:true,official:false},evidence:[],title:i.displayName,symbols:[i.canonicalSymbol],instrumentIds:[i.instrumentId],updatedAt:'2026-10-20T00:00:00Z'});
 const insert=db.prepare('INSERT INTO events(event_id,identity_version,revision,observed_at,status,payload_json) VALUES(?,?,?,?,?,?)');
 for(let n=0;n<100;n++){const e=value(n);insert.run(e.eventId,e.identityVersion,1,e.updatedAt,'observed',JSON.stringify(e));}
 try{
  const started=runtime.registry(universe);assert.equal(started.index.state,'building');assert.equal(eventIndexView(db).generation,null);
  const first=runtime.indexPage({limit:16});assert.equal(first.processed,16);assert.equal(eventIndexView(db).generation,null);
  const resumed=new BusinessRuntime(db,()=>{});assert.equal(resumed.registry(universe).index.processed,16);
  db.transaction(()=>new SqlResearchStore(db).project('events','a-new',{...value(1),eventId:'a-new'})).immediate();
  db.transaction(()=>new SqlResearchStore(db).project('events','e-0001',{...value(1),revision:2,title:'revision survives'})).immediate();
  while(resumed.indexPage({limit:16}).state!=='ready'){}
  const view=eventIndexView(db);assert.ok(view.generation);assert.equal(db.prepare('SELECT count(DISTINCT event_id) n FROM event_index_links WHERE generation=?').get(view.generation).n,101);
  const result=new SqlEventLedger({store:{db,state:{revision:2}}}).search({instrumentIds:[i.instrumentId],limit:200});assert.equal(result.total,101);assert.equal(result.index.state,'ready');assert.equal(result.events.find(e=>e.eventId==='e-0001').title,'revision survives');
  assert.equal(resumed.registry([...universe].reverse()).index.state,'ready');assert.equal(eventIndexView(db).generation,view.generation);
 }finally{db.close();}
});

test('failed build page rolls back without moving the cursor or replacing the active index',()=>{
 const db=new Database(':memory:');migrate(db);const runtime=new BusinessRuntime(db,()=>{}),i=listVerifiedInstruments()[0];
 runtime.registry(listVerifiedInstruments());const before=eventIndexView(db);
 const e={evidence:[],eventId:'broken-page',title:i.displayName,symbols:[i.canonicalSymbol],instrumentIds:[i.instrumentId],quality:{identityVerified:true},identityVersion:'source-publication-v2'};
 db.prepare('INSERT INTO events(event_id,identity_version,revision,observed_at,status,payload_json) VALUES(?,?,?,?,?,?)').run(e.eventId,e.identityVersion,1,new Date().toISOString(),'observed',JSON.stringify(e));
 db.exec("CREATE TRIGGER reject_index_page BEFORE INSERT ON event_index_links BEGIN SELECT RAISE(ABORT,'injected-page-failure'); END");
 try{assert.throws(()=>runtime.indexPage({}),/injected-page-failure/);assert.deepEqual(eventIndexView(db),before);assert.equal(db.prepare("SELECT json_extract(value_json,'$.processed') n FROM runtime_meta WHERE key='events.index.build'").get().n,0);assert.equal(db.inTransaction,false);}finally{db.close();}
});

test('background index admission waits for hydration and resumes when readiness releases it',async()=>{
 const {StorageManager}=await import('../storage/StorageManager.js');const manager=new StorageManager({enabled:false,businessEnabled:true});manager.state='ready';let pages=0;
 manager.localRequest=async()=>{pages++;return{state:'ready'};};manager.deferEventIndex();manager.resumeEventIndex();await new Promise(setImmediate);assert.equal(pages,0);
 manager.resumeEventIndex({release:true});await manager.eventIndexTask;assert.equal(pages,1);assert.equal(manager.eventIndexTask,null);
});

test('queries admits a short control read while one news calculation yields, but never a second CPU calculation',async()=>{
 const {StorageManager}=await import('../storage/StorageManager.js');const manager=new StorageManager({enabled:false,businessEnabled:true}),reader=manager.createAnalysisManager('queries');reader.state='ready';const dispatched=[];reader.worker={postMessage:m=>dispatched.push(m)};
 const heavy=reader.localRequest('domain.call',{service:'news',method:'getFeed',args:[]}),short=reader.localRequest('agent.read',{method:'status',args:{}}),next=reader.localRequest('domain.call',{service:'news',method:'getLiveFeed',args:[]});
 assert.equal(dispatched.length,2);assert.equal(reader.active.size,2);assert.equal(reader.queue.length,1);
 reader.handleMessage({id:dispatched[1].id,result:{},status:{},durationMs:1});assert.equal(dispatched.length,2);
 reader.handleMessage({id:dispatched[0].id,result:{},status:{},durationMs:1});assert.equal(dispatched.length,3);
 reader.handleMessage({id:dispatched[2].id,result:{},status:{},durationMs:1});await Promise.all([heavy,short,next]);reader.state='closed';
});

test('a slow event ends its page at a safe boundary without dropping any remaining events',()=>{
 const db=new Database(':memory:');migrate(db);const runtime=new BusinessRuntime(db,()=>{}),i=listVerifiedInstruments()[0];runtime.registry(listVerifiedInstruments());
 const insert=db.prepare('INSERT INTO events(event_id,identity_version,revision,observed_at,status,payload_json) VALUES(?,?,?,?,?,?)');for(let n=0;n<3;n++){const e={eventId:`slow-${n}`,identityVersion:'source-publication-v2',quality:{identityVerified:true},instrumentIds:[i.instrumentId],title:i.displayName,evidence:[]};insert.run(e.eventId,e.identityVersion,1,new Date().toISOString(),'observed',JSON.stringify(e));}
 db.function('slow_index_event',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10));db.exec('CREATE TRIGGER slow_index_event BEFORE INSERT ON event_index_links BEGIN SELECT slow_index_event(); END');
 try{assert.equal(runtime.indexPage({limit:64,budgetMs:1}).processed,1);while(runtime.indexPage({limit:64,budgetMs:1}).state!=='ready'){}assert.equal(db.prepare('SELECT count(DISTINCT event_id) n FROM event_index_links').get().n,3);assert.equal(db.inTransaction,false);}finally{db.close();}
});
