import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import Database from 'better-sqlite3';
import {cacheStatements} from '../storage/statementCache.js';
import {SqlActivity,createSqlActivityBuffer,trackTransactions} from '../storage/sqlActivity.js';
import {CommitActivity,createCommitBuffer,readCommits} from '../storage/commitActivity.js';
import {slowCommitCommand} from '../storage/slowCommitDiagnostics.js';

const idA='11111111-1111-4111-8111-111111111111',idB='22222222-2222-4222-8222-222222222222';
function fixture({onSlowCommit=()=>{}}={}){
 const db=new Database(':memory:');db.exec('CREATE TABLE facts(id TEXT PRIMARY KEY,value TEXT)');
 const original=db.transaction.bind(db);let clock=0;
 // Keep native SQLite transactions and rollback behavior. Advance only the
 // diagnostic clock around their return instead of creating a real slow fsync.
 db.transaction=fn=>{
  const native=original(fn),wrap=mode=>function(...args){try{return mode.apply(this,args);}finally{clock+=1250;}};
  const value=wrap(native);for(const mode of ['deferred','immediate','exclusive'])value[mode]=wrap(native[mode]);return value;
 };
 const context=new AsyncLocalStorage(),active=new Map(),buffer=createCommitBuffer(),activity=new SqlActivity(createSqlActivityBuffer());activity.commits=new CommitActivity(buffer);
 trackTransactions(db,activity,{now:()=>clock,describeCommit:()=>slowCommitCommand(context.getStore(),active),readCommitGeneration:()=>readCommits(buffer).generation,onSlowCommit});
 cacheStatements(db,16,{activity});
 const put=db.prepare('INSERT INTO facts VALUES(?,?)');
 return {db,context,active,activity,buffer,put,run:fn=>db.transaction(fn).immediate(),close:()=>db.close()};
}

test('overlapping async owners retain their own bounded command through awaits and nested savepoints',async()=>{
 const events=[],f=fixture({onSlowCommit:(durationMs,details)=>events.push({durationMs,...details})});
 f.active.set(idA,{operation:'runtime.save',service:null,method:null,kind:'rss-canonical-feed:private-source',payload:{credential:'DO-NOT-LOG'},requestId:'DO-NOT-LOG'});
 f.active.set(idB,{operation:'domain.call',service:'news',method:'ingest',kind:null,input:{content:'DO-NOT-LOG'}});
 let releaseA,enteredA;const gate=new Promise(resolve=>releaseA=resolve),entered=new Promise(resolve=>enteredA=resolve);
 try{
  const first=f.context.run({commandId:idA},async()=>{enteredA();await gate;f.run(()=>{
   f.put.run('a','private fact');
   // A nested savepoint has a different owner, but it cannot reattribute the
   // outer commit or manufacture an acknowledged commit generation.
   f.context.run({commandId:idB},()=>f.run(()=>f.put.run('nested','another private fact')));
  });});
  await entered;
  await f.context.run({commandId:idB},async()=>{await Promise.resolve();f.run(()=>f.put.run('b','private fact'));});
  releaseA();await first;
  assert.equal(events.length,2);assert.deepEqual(events.map(e=>e.command.commandId),[idB,idA]);
  assert.equal(events[0].command.service,'news');assert.equal(events[0].command.method,'ingest');assert.equal(events[1].command.kind,'rss-feed');
  assert.deepEqual(events.map(e=>[e.generationBefore,e.generationAfter]),[[0,1],[1,2]]);
  assert.ok(events.every(e=>e.nativeSucceeded&&e.commitFinishedMonotonicMs-e.commitStartedMonotonicMs===1250&&e.durationMs===1250));
  assert.equal(f.db.prepare('SELECT count(*) n FROM facts').get().n,3);assert.equal(f.activity.stack.length,0);
  const serialized=JSON.stringify(events);for(const value of ['DO-NOT-LOG','private fact','private-source','requestId','payload','input'])assert.equal(serialized.includes(value),false);
 }finally{releaseA();f.close();}
});

test('startup/internal commits stay unattributed, and dynamic identities or malformed scalar values do not leak',()=>{
 const events=[],f=fixture({onSlowCommit:(_duration,details)=>events.push(details)});
 try{
  f.run(()=>f.put.run('startup','private'));assert.equal(events[0].command,null);
  assert.equal(slowCommitCommand({commandId:'malformed'},f.active),null);assert.equal(slowCommitCommand({commandId:idA},f.active),null);
  f.active.set(idA,{operation:'runtime.save',service:'https://credential.invalid/token',method:'x'.repeat(200),kind:'rss-article:private-id',payload:'SECRET'});
  const command=slowCommitCommand({commandId:idA},f.active);assert.deepEqual(command,{commandId:idA,operation:'runtime.save',service:null,method:null,kind:'rss-body'});
  assert.equal(JSON.stringify(command).includes('SECRET'),false);
 }finally{f.close();}
});

test('rollback does not emit a successful commit; diagnostic exceptions cannot corrupt acknowledged writes or tracker state',()=>{
 const events=[],f=fixture({onSlowCommit:(_duration,details)=>{events.push(details);throw Error('logger unavailable');}});
 try{
  assert.throws(()=>f.run(()=>{f.put.run('rollback','private');throw Error('business failure');}),/business failure/);
  assert.equal(events.length,0);assert.equal(readCommits(f.buffer).generation,0);assert.equal(f.activity.stack.length,0);
  assert.doesNotThrow(()=>f.run(()=>f.put.run('committed','private')));assert.equal(events.length,1);assert.equal(events[0].generationAfter,1);
  assert.equal(f.db.prepare("SELECT value FROM facts WHERE id='committed'").get().value,'private');
  assert.doesNotThrow(()=>f.run(()=>f.put.run('successor','private')));assert.equal(readCommits(f.buffer).generation,2);assert.equal(f.activity.stack.length,0);
 }finally{f.close();}
});
