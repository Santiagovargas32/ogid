import test from 'node:test';
import assert from 'node:assert/strict';
import {StorageManager} from '../storage/StorageManager.js';

function controlledManager(t) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  const manager=new StorageManager({enabled:true,timeoutMs:30,databasePath:'/tmp/ogid-reconciliation-fixture-missing.sqlite'});
  const sent=[];
  manager.state='ready';
  manager.worker={postMessage:message=>sent.push(message),terminate:()=>Promise.resolve()};
  t.after(()=>{if(manager.state!=='failed')manager.fail(Object.assign(Error('fixture closed'),{code:'STORAGE_TEST_CLOSED'}));});
  return {manager,sent,start(message){manager.handleMessage({type:'command-started',id:message.id,startedAt:Date.now()});},
    finish(message,result={renewed:true}){manager.handleMessage({id:message.id,result,durationMs:Date.now()-100000,status:{}});}};
}
test('delayed writer renewal quarantines dispatch and resumes only on its definite result',async t=>{
  const f=controlledManager(t);
  const renewal=f.manager.localRequest('agent.call',{method:'heartbeat'},{timeoutMs:5});
  f.start(f.sent[0]);t.mock.timers.tick(5);
  assert.equal(f.manager.state,'ready');assert.equal(f.manager.getStatus().reconciliation.pending,true);
  const write=f.manager.localRequest('runtime.save',{kind:'fixture',payload:{}});
  assert.equal(f.sent.length,1);
  t.mock.timers.tick(10);f.finish(f.sent[0]);
  assert.deepEqual(await renewal,{renewed:true});assert.equal(f.manager.getStatus().reconciliation.pending,false);
  assert.equal(f.sent.length,2);f.start(f.sent[1]);f.finish(f.sent[1],{persisted:true});await write;
  assert.equal(f.manager.getStatus().reconciliation.resolved,1);
});
test('unresponsive renewal fails closed at the original writer guard measured from start',async t=>{
  const f=controlledManager(t);
  const renewal=f.manager.localRequest('agent.call',{method:'heartbeat'},{timeoutMs:5});
  const rejected=assert.rejects(renewal,{code:'STORAGE_OUTCOME_UNKNOWN'});
  f.start(f.sent[0]);t.mock.timers.tick(5);t.mock.timers.tick(24);
  assert.equal(f.manager.state,'ready');t.mock.timers.tick(1);await rejected;
  assert.equal(f.manager.state,'failed');assert.equal(f.manager.getStatus().lastExpiredCommand.executionMs,30);
  f.finish(f.sent[0]);assert.equal(f.manager.state,'failed');
});
