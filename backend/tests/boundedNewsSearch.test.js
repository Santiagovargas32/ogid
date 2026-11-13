import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import {StorageManager} from '../storage/StorageManager.js';
import {storageOperationContract} from '../contracts/storageOperations.js';

const call=query=>({service:'news',method:'search',args:[query]});
test('country/date page completes on the existing readonly reader while a heavy calculation retains admission',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-news-reader-')),manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'test.sqlite')});
 const token='retained-heavy-calculation';let query;
 try{
  await manager.start();await manager.request('domain.configure',{rootDir:directory,instruments:[],news:{},rss:{rssFeeds:[]}});
  await manager.request('domain.call',{service:'news',method:'ingest',args:[[{id:'fixture-report',title:'Russia report',url:'https://example.org/fixture',publishedAt:new Date().toISOString(),provider:'rss',countryMentions:['RU']}]]});
  assert.equal(manager.pressure.acquire(token),true);
  query=manager.request('domain.call',call({countries:['RU'],limit:20}));
  const result=await Promise.race([query,wait(1500).then(()=>null)]);
  assert.notEqual(result,null,'a compact indexed search must not wait behind the heavy calculation');
  assert.equal(result.total,1);assert.equal(result.articles.length,1);assert.equal(manager.pressure.owner,token);
  assert.equal(manager.queryManager.getStatus().queryOnly,true);
  const original=manager.pressure.status;manager.pressure.status=()=>({state:'degraded',critical:true,reason:'io-pressure'});
  try{await assert.rejects(manager.request('domain.call',call({countries:['RU'],limit:20})),e=>e.code==='STORAGE_RESOURCE_PRESSURE'&&e.notExecuted===true);}
  finally{manager.pressure.status=original;}
 }finally{manager.pressure.release(token);await query;await manager.close();rmSync(directory,{recursive:true,force:true});}
});

test('large and complex searches retain heavy admission; only frozen cursor pages are independently bounded',()=>{
 for(const query of [{limit:101},{maxBytes:524289},{q:'report'},{symbols:['NVDA']},{instrumentIds:['id']},{providers:['rss']},{sources:['wire']},{sectors:['technology']},{topics:['war']},{countries:['RU','invalid']},{countries:Array(51).fill('RU')},{from:'invalid'},{timeField:'invalid'},{cursor:'x',q:'report'}])
  assert.equal(storageOperationContract('domain.call',call(query)).resourceClass,'heavy',JSON.stringify(query));
 for(const query of [{},{countries:['RU','UA'],limit:100},{from:'2026-11-01T00:00:00Z',timeField:'receivedAt'},{cursor:'bounded-frozen-reference',limit:20}]){
  const contract=storageOperationContract('domain.call',call(query));assert.equal(contract.resourceClass,'payload');assert.equal(contract.pureRead,true);assert.equal(contract.role,'queries');
 }
});
