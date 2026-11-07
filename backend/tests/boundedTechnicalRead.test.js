import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {SqlCandleStore} from '../storage/sqlRepositories.js';
import {StorageManager} from '../storage/StorageManager.js';
import {listVerifiedInstruments} from '../services/market/instrumentRegistry.js';
import {storageOperationContract} from '../contracts/storageOperations.js';

const instrumentId='us-equity-nvidia';
async function fixture(work){
 const directory=mkdtempSync(join(tmpdir(),'ogid-technical-reader-')),databasePath=join(directory,'test.sqlite');
 const seed=new Database(databasePath);migrate(seed);
 new SqlCandleStore(seed).upsert([{instrumentId,interval:'1day',date:'2026-10-23',openTime:'2026-10-23T13:30:00Z',closeTime:'2026-10-23T20:00:00Z',open:100,high:110,low:90,close:105,volume:100,source:'yahoo',adjusted:true,provenance:{adjustmentMode:'splits'},fetchedAt:'2026-10-24T00:00:00Z'}],{now:new Date('2026-10-28T00:00:00Z')});seed.close();
 const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath});
 try{
  await manager.start();await manager.request('domain.configure',{instruments:listVerifiedInstruments(),rootDir:directory,news:{},rss:{rssFeeds:[]}});
  await work(manager);
 }finally{await manager.close();rmSync(directory,{recursive:true,force:true});}
}
const call=args=>({service:'technical',method:'get',args:[{instrumentId,...args}]});

test('bounded technical context completes on the existing read-only reader while another heavy calculation owns admission',async()=>fixture(async manager=>{
 const token='long-conditions-calculation';assert.equal(manager.pressure.acquire(token),true);
 const query=manager.request('domain.call',call({interval:'1day',limit:500}));
 try{
  const result=await Promise.race([query,wait(1500).then(()=>null)]);
  assert.notEqual(result,null,'A small technical read must not wait behind the unrelated heavy calculation');
  assert.equal(result.instrumentId,instrumentId);assert.equal(result.observed.close,105);assert.equal(result.sampleSize,1);
  assert.equal(manager.pressure.owner,token);assert.equal(manager.queryManager.getStatus().queryOnly,true);
  assert.ok(manager.queryManager.recentCommands.some(c=>c.service==='technical'&&c.status==='completed'));
  const contract=storageOperationContract('domain.call',call({limit:500}));
  assert.equal(contract.pureRead,false);assert.equal(contract.effects,'may-commit');
  // The readonly calculation still confirms its derived result through the
  // only business writer; it must not be classified as a no-effects read.
  const db=new Database(manager.options.databasePath,{readonly:true,fileMustExist:true});
  try{db.pragma('query_only=ON');const row=db.prepare("SELECT payload_json AS result_json FROM analysis_runs WHERE kind='technical.get' ORDER BY generated_at DESC LIMIT 1").get();assert.equal(JSON.parse(row.result_json).observed.close,105);}finally{db.close();}
 }finally{manager.pressure.release(token);await query;}
}));

test('technical reader keeps resource deferral and rejects weekly, large, imported and benchmark calculations',async()=>fixture(async manager=>{
 for(const args of [{interval:'1wk'},{limit:501},{datasetId:'imported'},{benchmarkInstrumentId:'us-equity-general-dynamics'}])
  await assert.rejects(manager.queryManager.request('domain.call',call(args)),{code:'STORAGE_READ_ONLY'});
 const original=manager.pressure.status;
 manager.pressure.status=()=>({state:'degraded',critical:true,reason:'io-pressure'});
 try{await assert.rejects(manager.request('domain.call',call({limit:500})),e=>e.code==='STORAGE_RESOURCE_PRESSURE'&&e.notExecuted===true);}
 finally{manager.pressure.status=original;}
 assert.equal(manager.state,'ready');assert.equal(manager.queryManager.getStatus().queryOnly,true);
}));
