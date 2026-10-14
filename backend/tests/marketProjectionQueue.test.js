import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.js';
import { setTimeout as delay } from 'node:timers/promises';
import RefreshOrchestratorService from '../services/refreshOrchestratorService.js';

test('market projections coalesce pending work and discard obsolete market or news context',async()=>{
  const releases=[],captured=[],applied=[];
  const state={market:{revision:'market-1'},meta:{sourceMeta:{corpus:{revision:1}}}};
  const orchestrator=new RefreshOrchestratorService({stateManager:{state,updateIntel:value=>{applied.push(value);return {meta:{}};}},socketServer:{broadcast(){}},config:{market:{enabled:true,analyzeInWorker:value=>{captured.push(value);return new Promise(resolve=>releases.push(resolve));}},watchlistCountries:[]}});
  const first=orchestrator.scheduleMarketProjection({marketRevision:'market-1',newsRevision:1});
  orchestrator.scheduleMarketProjection({marketRevision:'market-2',newsRevision:1});
  orchestrator.scheduleMarketProjection({marketRevision:'market-3',newsRevision:1});
  state.market.revision='market-3';releases.shift()({impact:{items:[]}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(captured.length,2);assert.equal(captured[1].marketRevision,'market-3');
  releases.shift()({impact:{items:[]}});await first;
  assert.equal(applied.length,1);
  const staleNews=orchestrator.scheduleMarketProjection({marketRevision:'market-3',newsRevision:1});
  state.meta.sourceMeta.corpus.revision=2;releases.shift()({impact:{items:[]}});await staleNews;
  assert.equal(applied.length,1);assert.equal(orchestrator.pendingCycles.size,0);
});

test('market projections validate the corpus returned by the worker rather than the pre-dispatch revision',async t=>{
  for(const {name,capturedRevision,analyzedRevision,currentRevision,accepted} of [
    {name:'accepts the newer corpus already published by a news cycle',capturedRevision:1,analyzedRevision:2,currentRevision:2,accepted:true},
    {name:'rejects an obsolete corpus even when the captured revision matches current state',capturedRevision:2,analyzedRevision:1,currentRevision:2,accepted:false},
    {name:'rejects a result superseded by another news cycle',capturedRevision:1,analyzedRevision:2,currentRevision:3,accepted:false},
    {name:'allows the first stored projection before news coverage is published',capturedRevision:undefined,analyzedRevision:0,currentRevision:undefined,accepted:true}
  ]){
    await t.test(name,async()=>{
      let release;const applied=[],broadcasts=[];
      const state={market:{revision:'market-1'},meta:{sourceMeta:{corpus:{revision:capturedRevision}}}};
      const orchestrator=new RefreshOrchestratorService({stateManager:{state,updateIntel:value=>{applied.push(value);return {...value,meta:{}};}},socketServer:{broadcast:(...args)=>broadcasts.push(args)},config:{market:{enabled:true,analyzeInWorker:()=>new Promise(resolve=>{release=resolve;})},watchlistCountries:[]}});
      const task=orchestrator.scheduleMarketProjection({marketRevision:'market-1',newsRevision:capturedRevision});
      state.meta.sourceMeta.corpus.revision=currentRevision;
      const projection={newsCoverage:{revision:analyzedRevision},predictions:{tickers:[{ticker:'GD',predictionScore:2}]},impact:{items:[{ticker:'GD',impactScore:3}]}};
      release(projection);await task;
      assert.equal(applied.length,accepted?1:0);
      assert.equal(broadcasts.length,accepted?1:0);
      if(accepted){assert.deepEqual(applied[0].predictions,projection.predictions);assert.deepEqual(applied[0].impact,projection.impact);}
      assert.equal(orchestrator.marketProjectionTask,null);assert.equal(orchestrator.pendingCycles.size,0);
    });
  }
});

test('quotes are published while derived analysis is blocked, then projections recover',async()=>{
 let release;const barrier=new Promise(resolve=>{release=resolve;});let calls=0;
 const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,news:{providers:[],rssFeeds:[]},awareness:{mode:'off'},ai:{provider:'none',mode:'off'},
   market:{provider:'yahoo',initialTickers:['GD'],tickers:['GD'],historyPersist:false,dailyCandles:{enabled:false},intradayCandles:{enabled:false},analyzeInWorker:async()=>{calls++;await barrier;return {insights:[],predictions:{tickers:[],sectors:[],predictionScoreByTicker:{}},impact:{items:[]}};}},
   marketDataService:{fetchQuotes:async()=>[{symbol:'GD',price:105,timestamp:new Date().toISOString(),currency:'USD',exchange:'NYSE'}]}});
 try{await runtime.start();await runtime.orchestrator.runMarketCycle('fixture');
   assert.equal(calls,1);assert.ok(runtime.orchestrator.marketProjectionTask);
   const base=`http://127.0.0.1:${runtime.server.address().port}`;
   const quote=await (await fetch(base+'/api/market/quotes')).json();assert.equal(quote.data.quotes.GD.price,105);
   const health=await fetch(base+'/api/health');assert.equal(health.status,200);
   release();await runtime.orchestrator.marketProjectionTask;assert.equal(runtime.orchestrator.pendingCycles.size,0);
 }finally{release();await runtime.stop();}
});
