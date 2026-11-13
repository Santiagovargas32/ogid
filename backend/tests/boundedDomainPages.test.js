import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {SituationStore} from '../storage/situations.js';
import {StorageManager} from '../storage/StorageManager.js';
import {storageOperationContract} from '../contracts/storageOperations.js';
const call=(method,query)=>({service:'situations',method,args:[query]});

test('frozen situation pages, revision history, changes and source citation finish while heavy admission stays owned',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-domain-page-')),databasePath=join(directory,'test.sqlite'),seed=new Database(databasePath);seed.pragma('journal_mode=WAL');migrate(seed);
 const archive=new SqlNewsArchive(seed,{analysisOnly:true}),store=new SituationStore(seed),at=new Date().toISOString();
 for(const id of ['one','two'])archive.save({id,revision:1,contentRevision:1,title:'Missile strike in Kyiv',url:'https://reuters.com/'+id,publishedAt:at,receivedAt:at,archiveLastSeenAt:at,usagePolicy:'headline-only-link-out',classification:{language:'en'}});
 for(let i=0;i<50;i++)if(!store.processPage({limit:100,budgetMs:100}).hasMore)break;
 const id=store.list().items[0].id,expected=store.detail({id,limit:1,maxBytes:262144});assert.equal(expected.hasMore,true);archive.close();seed.close();
 const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath}),token='retained-conditions-calculation';let pending;
 try{
  await manager.start();await manager.request('domain.configure',{rootDir:directory,instruments:[],news:{},rss:{rssFeeds:[]}});
  assert.equal(manager.pressure.acquire(token),true);
  const request=async input=>{
   pending=manager.request('domain.call',input);const value=await Promise.race([pending,wait(1500).then(()=>null)]);
   assert.notEqual(value,null,'bounded domain page must not wait for the heavy calculation');assert.equal(manager.pressure.owner,token);return value;
  };
  const first=await request(call('detail',{id,limit:1,maxBytes:262144})),second=await request(call('detail',{id,limit:1,maxBytes:262144,cursor:first.nextCursor}));
  assert.equal(first.asOfSequence,second.asOfSequence);assert.equal(first.items.length,1);assert.equal(second.items.length,1);assert.notEqual(first.items[0].sourceId,second.items[0].sourceId);
  assert.ok((await request(call('revisions',{id,limit:1}))).items.length);
  assert.ok((await request(call('changes',{sinceSequence:0,limit:1}))).items.length);
  assert.equal((await request({service:'news',method:'getItem',args:['one']})).article.title,'Missile strike in Kyiv');
  assert.equal(manager.queryManager.getStatus().queryOnly,true);
  const original=manager.pressure.status;manager.pressure.status=()=>({state:'degraded',critical:true,reason:'io-pressure'});
  try{
   for(const input of [call('detail',{id}),call('revisions',{id}),call('changes',{}),{service:'news',method:'getItem',args:['one']}])
    await assert.rejects(manager.request('domain.call',input),e=>e.code==='STORAGE_RESOURCE_PRESSURE'&&e.notExecuted===true);
  }finally{manager.pressure.status=original;}
 }finally{manager.pressure.release(token);await pending;await manager.close();rmSync(directory,{recursive:true,force:true});}
});

test('domain page admission excludes mutation, excessive budgets and unbounded queries',()=>{
 for(const input of [call('review',{id:'item'}),call('detail',{id:'item',limit:101}),call('detail',{id:'item',maxBytes:262145}),call('detail',{id:'item',atSequence:-1}),call('detail',{id:'item',extra:true}),call('revisions',{id:'item',cursor:'x'.repeat(4097)}),call('changes',{sinceSequence:-1}),{service:'news',method:'getItem',args:['x'.repeat(129)]},{service:'news',method:'getHistory',args:[{}]}])
  assert.equal(storageOperationContract('domain.call',input).resourceClass,'heavy',JSON.stringify(input));
 for(const input of [call('detail',{id:'item',atSequence:1}),call('revisions',{id:'item'}),call('changes',{}),{service:'news',method:'getItem',args:['article-one']}]){
  const c=storageOperationContract('domain.call',input);assert.equal(c.resourceClass,'payload');assert.equal(c.pureRead,true);assert.equal(c.role,'queries');
 }
});
