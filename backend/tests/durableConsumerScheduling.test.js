import test from 'node:test';
import assert from 'node:assert/strict';
import {StorageManager} from '../storage/StorageManager.js';

function fixture(t) {
  const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:'/tmp/ogid-consumer-scheduling.sqlite'}),sent=[];
  manager.state='ready';
  manager.worker={postMessage:message=>sent.push(message),terminate:async()=>{}};
  t.after(()=>manager.fail(Object.assign(Error('fixture closed'),{code:'STORAGE_TEST_CLOSED'})));
  return {manager,sent,finish(message,result={}){manager.handleMessage({id:message.id,result,durationMs:1,status:{}});}};
}

test('durable revisions progress while RSS acquisition is waiting, without admitting a second SQL unit',async t=>{
  const f=fixture(t),rss=f.manager.localRequest('domain.call',{service:'rss',method:'refresh',args:[]});rss.catch(()=>{});
  assert.equal(f.sent.length,1);
  const write=f.manager.localRequest('runtime.save',{kind:'fixture',payload:{}});write.catch(()=>{});
  assert.equal(f.sent.length,2);
  const page=f.manager.localRequest('agent.call',{method:'alertSync',args:{limit:100,budgetMs:50}});page.catch(()=>{});
  assert.equal(f.sent.length,2,'a second SQL unit must wait');
  const heartbeat=f.manager.localRequest('agent.call',{method:'heartbeat',args:{jobId:'fixture',owner:'fixture-owner',fence:1}});heartbeat.catch(()=>{});
  assert.equal(f.sent.length,3,'lease control retains its reserved admission');
  f.finish(f.sent[1],{persisted:true});await write;
  assert.equal(f.sent.length,4,'the journal page must not wait for the network workflow to finish');
  assert.equal(JSON.parse(f.sent[3].encoded).input.method,'alertSync');
  f.finish(f.sent[3],{processed:100,hasMore:true});assert.equal((await page).processed,100);
  f.finish(f.sent[2],{renewed:true});await heartbeat;
  f.finish(f.sent[0]);await rss;
});
