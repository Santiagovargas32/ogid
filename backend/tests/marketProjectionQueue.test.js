import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.js';
import { setTimeout as delay } from 'node:timers/promises';

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
