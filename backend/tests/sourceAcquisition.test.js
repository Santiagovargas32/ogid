import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {SqlResearchStore,SqlEventLedger} from '../storage/sqlRepositories.js';
import {OfficialSourceService} from '../services/research/officialSources.js';
import {loadSecSources} from '../services/research/secSourceCatalog.js';
import {SourceAcquisition} from '../services/research/sourceAcquisition.js';
import {createServer} from 'node:http';
import {operationContext} from '../services/shared/operationContext.js';

function fixture(options={}){
  const db=new Database(':memory:');migrate(db);const store=new SqlResearchStore(db),source=loadSecSources().find(s=>s.sourceId==='sec-nvda-companyfacts');
  const service=new OfficialSourceService({store,eventLedger:new SqlEventLedger({store}),sources:[source],userAgent:'OGID fixture@example.test',...options});return {db,store,source,service};
}
test('transport connect timeout records an observed headers phase and transport origin without erasing last success',async()=>{
  const f=fixture({fetchImpl:async()=>{throw new TypeError('fetch failed',{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});},random:()=>0});
  try{
    f.store.transact(s=>s.sourceStates[f.source.sourceId]={lastSuccessAt:'2026-10-01T12:00:00Z'});
    const result=await f.service.run({sourceIds:[f.source.sourceId]});const row=result.results[0];
    assert.equal(row.failureCode,'SOURCE_TIMEOUT');assert.equal(row.lastFailure.phase,'waiting_headers');assert.equal(row.lastFailure.timeoutOrigin,'transport');assert.equal(row.lastFailure.causeCode,'UND_ERR_CONNECT_TIMEOUT');assert.equal(row.lastSuccessAt,'2026-10-01T12:00:00Z');assert.equal(row.attempts.length,1);
  }finally{f.db.close();}
});
test('body deadline identifies budget origin, counts bytes and retains previously accepted facts',async()=>{
  const keep=setTimeout(()=>{},1000),f=fixture({timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}))});
  try{
    f.store.transact(s=>s.companyFacts[f.source.companyId]={preserved:true});
    const result=await f.service.run({sourceIds:[f.source.sourceId]});const row=result.results[0];
    assert.equal(row.lastFailure.phase,'reading_body');assert.equal(row.lastFailure.timeoutOrigin,'budget');assert.equal(row.lastFailure.bytes,1);assert.deepEqual(f.store.state.companyFacts[f.source.companyId],{preserved:true});
  }finally{clearTimeout(keep);f.db.close();}
});
test('the SQL writer delegates acquisition and rejects a late prepared generation after stop',async()=>{
  let release,entered;const waiting=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});let cancelled=0;
  const f=fixture({acquire:async input=>{entered(input);await gate;return {events:[],companyFacts:{[input.source.companyId]:{replacement:true}},holdings:{},runtime:{status:'healthy',lastSuccessAt:new Date().toISOString(),accepted:1}};},cancelAcquire:()=>{cancelled++;}});
  try{
    f.store.transact(s=>s.companyFacts[f.source.companyId]={preserved:true});
    const run=f.service.run({sourceIds:[f.source.sourceId]});const descriptor=await waiting;assert.ok(descriptor.attemptId);assert.equal(descriptor.source.sourceId,f.source.sourceId);
    const stopping=f.service.stop();release();await stopping;await run;
    assert.equal(cancelled,1);assert.deepEqual(f.store.state.companyFacts[f.source.companyId],{preserved:true});assert.equal(f.store.state.sourceStates[f.source.sourceId].status,'cancelled');
  }finally{f.db.close();}
});
test('a failed atomic prepared commit rolls back accepted facts and retains failure telemetry',async()=>{
  const f=fixture({acquire:async()=>({events:[],companyFacts:{'new-company':{new:true}},holdings:{},runtime:{status:'healthy',accepted:1}})});
  try{
    f.db.exec("CREATE TRIGGER fixture_reject_fact BEFORE INSERT ON research_rows WHEN new.collection='companyFacts' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END;");
    await f.service.run({sourceIds:[f.source.sourceId]});assert.equal(f.store.state.companyFacts['new-company'],undefined);assert.equal(f.store.state.sourceStates[f.source.sourceId].status,'error');
  }finally{f.db.close();}
});
test('the managed acquisition worker fetches and parses an injected local source without any SQL handle',async()=>{
  const executor=new SourceAcquisition(),server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/rss+xml'});res.end('<rss><channel><item><title>Fixture filing</title><link>https://example.test/item</link><guid>fixture</guid></item></channel></rss>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await executor.run({source:{sourceId:'fixture-source',adapter:'rss',enabled:true,verifiedAt:'2026-10-23',url:`http://127.0.0.1:${server.address().port}`,minPollIntervalMs:1000},instruments:[],userAgent:'OGID fixture@example.test',timeoutMs:1000,attemptId:'fixture-attempt'});
    assert.ok(executor.worker.threadId>0);assert.equal(result.runtime.status,'healthy');assert.equal(result.runtime.lastSuccess.attemptId,'fixture-attempt');assert.equal(result.events[0].items[0].title,'Fixture filing');assert.equal(result.runtime.lastSuccess.phase,'completed');assert.ok(result.runtime.lastSuccess.bytes>0);
  }finally{await executor.close();await new Promise(resolve=>server.close(resolve));}
});
test('a reconfigured source generation cannot commit an old prepared response',async()=>{
  let epoch=1,release,entered;const waiting=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const f=fixture({configurationVersion:()=>epoch,acquire:async input=>{entered();await gate;return {events:[],companyFacts:{[input.source.companyId]:{obsolete:true}},holdings:{},runtime:{status:'healthy',accepted:1}};}});
  try{const run=f.service.run({sourceIds:[f.source.sourceId]});await waiting;epoch++;release();await run;assert.equal(f.store.state.companyFacts[f.source.companyId],undefined);assert.equal(f.store.state.sourceStates[f.source.sourceId].status,'cancelled');}finally{f.db.close();}
});
test('source workflows inherit storage cancellation and acknowledge only committed terminal units',async()=>{
  const controller=new AbortController();let entered,release,progress=0,cancelled=0;
  const waiting=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const f=fixture({cancelAcquire:()=>{cancelled++;},acquire:async()=>{entered();await gate;return {events:[],companyFacts:{},holdings:{},runtime:{status:'healthy',accepted:0}};}});
  try{
    const run=operationContext.run({signal:controller.signal,committed:count=>{progress+=count;}},()=>f.service.run({sourceIds:[f.source.sourceId]}));
    await waiting;assert.equal(progress,0);controller.abort();release();await run;assert.equal(cancelled,1);assert.equal(f.store.state.sourceStates[f.source.sourceId].status,'cancelled');
  }finally{f.db.close();}
});
