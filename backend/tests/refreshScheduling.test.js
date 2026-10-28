import test from "node:test";
import assert from "node:assert/strict";
import RefreshOrchestratorService from "../services/refreshOrchestratorService.js";

test('shutdown drains the accepted news cycle without starting its coalesced RSS successor',async()=>{
 const service=new RefreshOrchestratorService({config:{news:{providers:[]},market:{enabled:false}}});
 let release,entered,runs=0;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 service.executeNewsCycle=async()=>{runs++;entered();await gate;};
 const first=service.runNewsCycle();await started;
 const joined=service.runNewsCycle('rss',{rssOnly:true});assert.equal(first,joined);
 const stopped=service.stop();assert.deepEqual(await service.runNewsCycle('late-rss',{rssOnly:true}),{skipped:true,reason:'stopping'});
 release();await Promise.all([first,stopped]);assert.equal(runs,1);assert.equal(service.newsTask,null);assert.equal(service.rssSelectionPending,false);
});

test("news scheduler respects the policy interval when the backoff cap is smaller",async t=>{
  t.mock.timers.enable({apis:["Date","setTimeout"],now:0});
  const config={news:{intervalMs:600000,backoffMaxMs:300000,providers:[]},market:{enabled:false}};
  const orchestrator=new RefreshOrchestratorService({config});let runs=0;
  orchestrator.runNewsCycle=async()=>{runs++;};orchestrator.stopped=false;
  try{
    orchestrator.scheduleNextNewsCycle();
    assert.equal(orchestrator.nextNewsRunAt,new Date(600000).toISOString());
    t.mock.timers.tick(599999);assert.equal(runs,0);
    t.mock.timers.tick(1);assert.equal(runs,1);await Promise.resolve();orchestrator.stop();
    config.news.backoffMaxMs=900000;orchestrator.newsBackoffMs=120000;orchestrator.stopped=false;
    orchestrator.scheduleNextNewsCycle();
    t.mock.timers.tick(719999);assert.equal(runs,1);
    t.mock.timers.tick(1);assert.equal(runs,2);await Promise.resolve();
  }finally{orchestrator.stop();}
});

test("SQL projection and RSS cycles continue independently of paid provider cadence",async t=>{
  t.mock.timers.enable({apis:["Date"],now:0});
  const calls=[],config={news:{providers:["newsapi","rss"],projectionIntervalMs:60000,rssPollIntervalMs:60000,collectInWorker:async input=>{calls.push(input.providers);return {articles:[],rawArticles:[],sourceMeta:{},quotas:{}};}},market:{enabled:false}};
  const orchestrator=new RefreshOrchestratorService({config});
  assert.equal(orchestrator.resolveNextNewsDelayMs(),60000);
  await orchestrator.collectStoredNews({}, {intervalMs:600000});
  t.mock.timers.tick(60000);await orchestrator.collectStoredNews({}, {intervalMs:600000});
  t.mock.timers.tick(540000);await orchestrator.collectStoredNews({}, {intervalMs:600000});
  assert.deepEqual(calls,[["newsapi","rss"],["rss"],["newsapi","rss"]]);
  await orchestrator.collectStoredNews({}, {intervalMs:600000},{storageOnly:true});assert.equal(calls.length,3);
});
