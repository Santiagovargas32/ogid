import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageManager } from "../storage/StorageManager.js";
import { createAppServer } from "../server.js";
import { listVerifiedInstruments, getInstrumentById } from "../services/market/instrumentRegistry.js";
import { calculateMarketProjection } from "../services/market/marketProjection.js";
import { createAwarenessEvent } from "../services/awareness/awarenessParsers.js";
import { awarenessMarketArticles } from "../services/awareness/marketArticles.js";

const instrumentId="us-equity-general-dynamics";
const source={sourceId:"fixture-official",name:"Official fixture",official:true,role:"official",enabled:true,admissionState:"active",kind:"corporate_release",domains:["financial","corporate"],url:"https://example.org/official"};
const input=()=>({countries:{},marketQuotes:{GD:{price:100,changePct:2,dataMode:"observed"}},tickers:["GD"],instruments:[getInstrumentById(instrumentId)],countryFilter:["US"],windowMin:240,inputMode:"live",impactHistory:[]});

test("market analysis reads a corpus larger than the command budget in SQL, preserving calculations and Awareness modes",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"ogid-market-projection-"));
  const manager=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(dir,"test.sqlite")});
  const call=(service,method,...args)=>manager.request("domain.call",{service,method,args});
  try{
    await manager.start();
    await manager.request("domain.configure",{instruments:listVerifiedInstruments(),rootDir:dir,news:{watchlistCountries:["US"],analyzeLimit:3000},rss:{rssFeeds:[]}});
    await call("news","ingest",Array.from({length:60},(_,i)=>({id:`source-${i}`,title:`United States General Dynamics defense contract after Russia attack ${i}`,url:`https://example.org/${i}`,publishedAt:new Date(Date.now()-60000-i*1000).toISOString(),provider:"fixture",countryMentions:["US","RU"]})));
    const event=createAwarenessEvent({source,rawId:"release",title:"General Dynamics corporate earnings release",summary:"General Dynamics reports earnings",canonicalUrl:"https://example.org/official/release",publishedAt:new Date(Date.now()-1000).toISOString(),observedAt:new Date().toISOString()});
    await call("awareness","reconcile",[event],{sourceId:source.sourceId});
    const projection=await call("news","getProjection",{countries:["US"],awarenessMode:"visible"});
    const awareness=await call("awareness","getSnapshot",{mode:"visible",publicView:true});
    const articles=[...projection.marketSignalCorpus,...awarenessMarketArticles(awareness)];
    assert.ok(articles.length>20);
    assert.ok(articles.some(article=>article.id===event.eventId));
    manager.options.maxCommandBytes=8192;manager.analysisManager.options.maxCommandBytes=8192;
    assert.ok(Buffer.byteLength(JSON.stringify(articles))>manager.options.maxCommandBytes);
    await assert.rejects(call("market","analyze",{...input(),articles}),{code:"STORAGE_COMMAND_TOO_LARGE"});
    const rejectionCount=manager.analysisManager.metrics.rejected;
    const result=await call("market","analyze",{...input(),newsFromStorage:true,corpusOptions:{countries:["US"],awarenessMode:"visible"}});
    const expected=calculateMarketProjection({...input(),articles});
    assert.deepEqual(result.predictions.tickers,expected.predictions.tickers);
    assert.deepEqual(result.predictions.sectors,expected.predictions.sectors);
    assert.deepEqual(result.impact.items,expected.impact.items);
    assert.equal(result.newsCoverage.analysisArticleCount,articles.length);
    assert.equal(result.newsCoverage.revision,projection.meta.revision);
    assert.equal(manager.analysisManager.metrics.rejected,rejectionCount);
    assert.equal(manager.analysisManager.getStatus().queryOnly,true);
    for(const awarenessMode of ["off","shadow"]){
      const hidden=await call("market","analyze",{...input(),newsFromStorage:true,corpusOptions:{countries:["US"],awarenessMode}});
      assert.equal(hidden.newsCoverage.awarenessRevision,null);
      assert.equal(hidden.newsCoverage.analysisArticleCount,projection.signalCorpus.length);
    }
    assert.equal((await manager.request("storage.verify")).integrity[0].integrity_check,"ok");
  }finally{await manager.close();rmSync(dir,{recursive:true,force:true});}
});

test("SQL market cycles send parameters without cloning the HTTP corpus and expose metadata through the admin route",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"ogid-market-cycle-"));
  const runtime=createAppServer({port:0,host:"127.0.0.1",disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(dir,"test.sqlite")},news:{providers:[],rssFeeds:[]},awareness:{mode:"off"},ai:{mode:"off",provider:"none"},market:{provider:"yahoo",initialTickers:["GD"],tickers:["GD"],historyPersist:false,historyDir:dir,dailyCandles:{enabled:false},intradayCandles:{enabled:false}},marketDataService:{fetchQuotes:async()=>[{symbol:"GD",price:105,timestamp:new Date().toISOString(),currency:"USD",exchange:"NYSE"}]}});
  try{
    await runtime.start();
    t.mock.method(runtime.orchestrator.stateManager,"getMarketSignalCorpus",()=>assert.fail("The HTTP corpus must stay out of the SQL command"));
    const original=runtime.config.market.analyzeInWorker;let captured;
    runtime.config.market.analyzeInWorker=async value=>{captured=value;return original(value);};
    await runtime.orchestrator.runMarketCycle("fixture");
    await runtime.orchestrator.marketProjectionTask;
    await runtime.orchestrator.storageFlush();
    assert.equal(captured.newsFromStorage,true);assert.equal(Object.hasOwn(captured,"articles"),false);
    assert.equal(runtime.app.locals.pipelineMonitor.snapshot()["market.analysis"].status,"completed");
    const metricsBefore=runtime.storageManager.metrics.completed;
    const analysisBefore=runtime.storageManager.analysisManager.metrics.completed;
    const response=await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/admin/runtime`);
    assert.equal(response.status,200);
    const data=(await response.json()).data;
    assert.ok(data.sampledAt);assert.equal(data.storage.state,"ready");
    assert.ok(data.storage.analysis.recentCommands.some(row=>row.service==="market"&&row.method==="analyze"&&row.status==="completed"));
    assert.equal(runtime.storageManager.metrics.completed,metricsBefore);
    assert.equal(runtime.storageManager.analysisManager.metrics.completed,analysisBefore);
  }finally{await runtime.stop();rmSync(dir,{recursive:true,force:true});}
});
