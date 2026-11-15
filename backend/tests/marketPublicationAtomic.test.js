import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../storage/migrate.js';
import {BusinessRuntime} from '../storage/businessRuntime.js';
import {PipelinePersistence} from '../storage/pipelinePersistence.js';
import {StorageManager} from '../storage/StorageManager.js';
import {MarketHistoryStore} from '../services/market/marketHistoryStore.js';
import {AwarenessStore} from '../services/awareness/awarenessStore.js';
import {SqlActivity,createSqlActivityBuffer,trackTransactions} from '../storage/sqlActivity.js';
import {cacheStatements} from '../storage/statementCache.js';
const quote=(price,extra={})=>({price,asOf:'2026-11-15T12:00:00.000Z',source:'yahoo',dataMode:'observed',synthetic:false,...extra});
const state=(revision='fixture-1')=>({provider:'yahoo',sourceMode:'live',sourceMeta:{},updatedAt:'2026-11-15T12:00:00.000Z',revision,quotes:{GD:quote(300),BA:quote(200,{dataMode:'fallback'})}});
const packet=(revision='fixture-1')=>({quotes:state(revision).quotes,snapshot:{...state(revision),quotes:{GD:quote(300)}}});
function fixture(){const directory=mkdtempSync(join(tmpdir(),'ogid-market-publication-')),path=join(directory,'fixture.sqlite'),db=new Database(path);db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma('wal_autocheckpoint=0');migrate(db);return {directory,path,db,close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
async function hydrate(manager,store=new MarketHistoryStore({enabled:true,tickers:['GD','BA']})){const persistence=new PipelinePersistence(manager);await persistence.hydrate({awarenessStore:new AwarenessStore(),aiStore:{records:new Map(),upsert:r=>r,recoverInterrupted(){}},aiBudget:{},marketHistoryStore:store,quotaTracker:{providers:{},ensureProvider(){}}});await persistence.flush();return {persistence,store};}
function read(path,fn){const db=new Database(path,{readonly:true});try{db.pragma('query_only=ON');return fn(db);}finally{db.close();}}

test('eligible publication uses one save, preserves filters and no-op decisions, and acknowledges only commit',async()=>{
 let release,fail=false;const writes=[],gate=new Promise(resolve=>release=resolve);
 const manager={request:async(operation,input)=>{if(operation==='runtime.load')return null;writes.push(structuredClone(input));if(input.kind==='market-publication'){await gate;if(fail)throw Object.assign(Error('commit rejected'),{code:'SQLITE_FULL'});}return {persisted:true};}};
 const {store,persistence}=await hydrate(manager);writes.length=0;
 const market=state(),work=store.persistMarketState({},market,{trigger:'manual-market-refresh'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(writes.length,1);assert.equal(writes[0].kind,'market-publication');assert.equal(store.getStatus().lastSavedAt,null);
 assert.deepEqual(Object.keys(writes[0].payload.snapshot.quotes),['GD']);assert.equal(writes[0].payload.quotes.BA.dataMode,'fallback');
 release();await work;await persistence.flush();assert.equal(store.getStatus().lastSavedAt,market.sourceMeta.persistence.savedAt);
 const count=writes.length;await store.persistMarketState(market,structuredClone(market));assert.equal(writes.length,count);
 await store.persistMarketState({}, {...state(),quotes:{BA:quote(200,{dataMode:'fallback'})}});assert.equal(writes.length,count);
 fail=true;const next=state('fixture-2');next.updatedAt='2026-11-15T12:01:00.000Z';next.quotes.GD=quote(301);
 const saved=store.getStatus().lastSavedAt;await assert.rejects(store.persistMarketState(market,next,{trigger:'manual-market-refresh'}),{code:'SQLITE_FULL'});assert.equal(store.getStatus().lastSavedAt,saved);
});

test('one FULL publication rolls history and snapshot back together on failure between writes',()=>{
 const f=fixture(),runtime=new BusinessRuntime(f.db);try{
  f.db.exec("CREATE TRIGGER reject_market BEFORE INSERT ON runtime_snapshots WHEN NEW.kind='market' BEGIN SELECT RAISE(ABORT,'fixture snapshot rejected'); END");
  assert.throws(()=>runtime.save('market-publication',packet()),/fixture snapshot rejected/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM quote_observations').get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM pipeline_checkpoints WHERE pipeline_id='market-quotes'").get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM runtime_snapshots WHERE kind='market'").get().n,0);assert.equal(f.db.pragma('synchronous',{simple:true}),2);
 }finally{f.close();}
});

test('writer receipt reconciles lost ACK without duplicate history or commits',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-market-receipt-')),path=join(directory,'fixture.sqlite'),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:path,resourcePressureEnabled:false});try{
  await manager.start();await manager.request('domain.configure',{instruments:globalThis.__OGID_TEST_MARKET_INSTRUMENTS__,rootDir:directory,rss:{rssFeeds:[]}});const input={kind:'market-publication',payload:packet()},requestId='market-publication-lost-ack';
  let lost=true;const write=async()=>{const result=await manager.request('runtime.save',input,{requestId});if(lost){lost=false;throw Object.assign(Error('lost ACK'),{code:'STORAGE_OUTCOME_UNKNOWN'});}return result;};
  await assert.rejects(write(),{code:'STORAGE_OUTCOME_UNKNOWN'});assert.deepEqual(await write(),{persisted:true});
  const status=await manager.request('storage.status');assert.equal(status.synchronous,2);
  read(path,db=>{assert.equal(db.prepare('SELECT count(*) n FROM quote_observations').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM storage_commands WHERE request_id=?').get(requestId).n,1);assert.equal(JSON.parse(db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='market'").get().payload_json).revision,'fixture-1');});
  await assert.rejects(manager.request('runtime.save',{kind:'market-publication',payload:packet('conflict')},{requestId}),{code:'STORAGE_IDEMPOTENCY_CONFLICT'});
 }finally{await manager.close();rmSync(directory,{recursive:true,force:true});}
});

test('paired FULL fixture preserves results and reduces outer commits from two to one per publication',()=>{
 const run=atomic=>{const f=fixture(),activity=new SqlActivity(createSqlActivityBuffer());trackTransactions(f.db,activity);cacheStatements(f.db,128,{activity});const runtime=new BusinessRuntime(f.db);f.db.pragma('wal_checkpoint(TRUNCATE)');try{
  for(let index=0;index<12;index++){const input=packet('fixture-'+index);input.quotes.GD.price=300+index;input.snapshot.quotes.GD.price=300+index;if(atomic)runtime.save('market-publication',input);else{runtime.save('quotes',{quotes:input.quotes});runtime.save('market',input.snapshot);}}
  const persisted={history:f.db.prepare('SELECT observation_id,instrument_id,market_time,price,payload_json FROM quote_observations ORDER BY observation_id').all(),snapshot:runtime.load('market')};return {commits:activity.writeMetrics.status().total.transactions,walBytes:statSync(f.path+'-wal').size,persisted};
 }finally{f.close();}};
 const separate=run(false),atomic=run(true);assert.deepEqual(atomic.persisted,separate.persisted);assert.equal(separate.commits,24);assert.equal(atomic.commits,12);assert.ok(atomic.walBytes<separate.walBytes);
 console.log(JSON.stringify({fixture:true,synchronous:'FULL',publications:12,separateCommits:separate.commits,atomicCommits:atomic.commits,separateWalBytes:separate.walBytes,atomicWalBytes:atomic.walBytes,scope:'Outer commit and WAL measurement only; physical fsync latency and operational pressure are unproven.'}));
});
