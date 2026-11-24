import assert from 'node:assert/strict';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createAppServer} from '../../server.js';
import {pressureError} from '../../storage/resourceAdmission.js';

const [directory,attempt,asOf]=process.argv.slice(2);
let network=0,calculations=0,confirmations=0,projectionBroadcasts=0,postCommitDeferrals=0;
const runtime=createAppServer({
  port:0,host:'127.0.0.1',disableBackgroundRefresh:true,
  storage:{enabled:true,businessEnabled:true,databasePath:join(directory,'fixture.sqlite')},
  news:{providers:[],rssFeeds:[]},awareness:{mode:'off'},ai:{mode:'off',provider:'none'},
  market:{provider:'yahoo',initialTickers:['GD'],tickers:['GD'],historyPersist:false,historyDir:directory,
    dailyCandles:{enabled:false},intradayCandles:{enabled:false}},
  marketDataService:{fetchQuotes:async()=>{
    network++;
    assert.equal(attempt,'defer');
    return [{symbol:'GD',price:101,timestamp:asOf,currency:'USD',exchange:'NYSE'}];
  }}
});
const {orchestrator,storageManager}=runtime;
const analyze=runtime.config.market.analyzeInWorker;
runtime.config.market.analyzeInWorker=async input=>{
  calculations++;
  if(attempt==='defer')throw pressureError({state:'degraded',reason:'fixture-presentation'});
  assert.equal(attempt,'recover');
  assert.equal(input.asOf,asOf);
  assert.equal(input.corpusOptions.revisionWatermark,0);
  return analyze(input);
};
const request=storageManager.request.bind(storageManager);
storageManager.request=async(op,...args)=>{
  if(attempt==='recover' && confirmations && !postCommitDeferrals && op==='runtime.load' &&
      args[0]?.kind==='market-presentation-current' && args[0].options?.withFrame===false){
    postCommitDeferrals++;
    throw pressureError({state:'degraded',reason:'fixture-after-confirmation'});
  }
  if(op==='continuation.marketPresent'){
    const db=new Database(join(directory,'fixture.sqlite'),{readonly:true});
    try{
      assert.equal(db.prepare("SELECT count(*) FROM analysis_runs WHERE kind='market.analyze'").pluck().get(),0);
    }finally{db.close();}
  }
  const result=await request(op,...args);
  if(op==='continuation.marketPresent'){
    confirmations++;
    assert.equal(attempt,'recover');
    throw Object.assign(Error('ACK lost after presentation commit'),{code:'STORAGE_OUTCOME_UNKNOWN'});
  }
  return result;
};
const broadcast=orchestrator.socketServer.broadcast.bind(orchestrator.socketServer);
orchestrator.socketServer.broadcast=(event,payload,...args)=>{
  if(event==='update' && payload.impact?.updatedAt===asOf && !payload.market)projectionBroadcasts++;
  return broadcast(event,payload,...args);
};
try{
  await runtime.start();
  if(attempt==='defer'){
    orchestrator.resolveAggregateNewsSnapshot = () => {
      throw pressureError({state:'degraded',reason:'fixture-after-quote-before-context'});
    };
    await assert.rejects(orchestrator.runMarketCycle('manual-market',{now:asOf}), {code:'STORAGE_RESOURCE_PRESSURE'});
    await orchestrator.marketProjectionTask;
  }
  if(attempt==='recover'){
    // Timers are disabled to isolate this recovery. Invoke the same pending
    // scheduler entry that resource relief selects in the running application.
    assert.equal(postCommitDeferrals,1);
    assert.ok(orchestrator.resourceDeferred.has('projection'));
    assert.equal(projectionBroadcasts,0);
    await orchestrator.scheduleMarketProjection(orchestrator.marketProjectionPending);
  }
  const saved=await orchestrator.marketHistoryStore.presentation.read();
  const context = saved.frame.context;
  assert.ok(context.observedAt);
  assert.equal(context.bucket,context.observedAt.slice(0,13));
  const db = new Database(join(directory,'fixture.sqlite'),{readonly:true});
  try {
    assert.deepEqual(db.prepare('SELECT payload_json FROM news_context').pluck().all().map(JSON.parse),[context]);
  } finally { db.close(); }
  assert.equal(saved.frame.market.quotes.GD.price,101);
  assert.equal(saved.frame.analysis.asOf,asOf);
  assert.equal(saved.frame.analysis.articles,undefined);
  assert.equal(saved.frame.market.timeseries,undefined);
  assert.equal(orchestrator.stateManager.state.market.revision,saved.job.input.marketRevision);
  if(attempt==='defer'){
    assert.equal(saved.job.status,'pending');assert.equal(network,1);assert.equal(projectionBroadcasts,0);
  }else{
    assert.equal(saved.job.phase,'published');assert.equal(saved.current,true);
    assert.equal(saved.projection.impact.updatedAt,asOf);
    assert.equal(saved.projection.predictions.updatedAt,asOf);
    assert.equal(orchestrator.stateManager.state.impact.updatedAt,asOf);
    assert.equal(network,0);assert.equal(projectionBroadcasts,1);
    const points=orchestrator.stateManager.state.impactHistory.length;
    await orchestrator.recoverMarketPresentation();
    assert.equal(orchestrator.stateManager.state.impactHistory.length,points);
    assert.equal(projectionBroadcasts,1);
  }
  assert.equal(calculations,attempt==='reuse'?0:1);
  assert.equal(confirmations,attempt==='recover'?1:0);
}finally{await runtime.stop();}
if(attempt==='defer')assert.ok(runtime.app.locals.shutdownReport.deferredPersistence.cycleContinuations.some(row=>row.phase==='projection'&&row.durable));
