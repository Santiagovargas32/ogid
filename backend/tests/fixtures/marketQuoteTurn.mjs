import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createAppServer} from '../../server.js';
import {pressureError} from '../../storage/resourceAdmission.js';

const [directory,attempt,cut]=process.argv.slice(2);
let network=0;
const dispatched=Promise.withResolvers(),release=Promise.withResolvers();
const runtime=createAppServer({
  port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(directory,'fixture.sqlite')},
  news:{providers:[],rssFeeds:[]},awareness:{mode:'off'},ai:{mode:'off',provider:'none'},
  market:{provider:'yahoo',initialTickers:['GD'],tickers:['GD'],historyPersist:true,historyDir:directory,
    dailyCandles:{enabled:false},intradayCandles:{enabled:false}},
  marketDataService:{fetchQuotes:async symbols=>{
    network++;
    if(attempt==='switch' && network===1){dispatched.resolve();await release.promise;}
    return symbols.map(symbol=>({symbol,price:142,timestamp:cut,currency:'USD',exchange:'NYSE'}));
  }}
});
const {orchestrator,storageManager}=runtime;
try{
  await runtime.start();
  const turns=orchestrator.marketHistoryStore.quoteTurns;
  const cycle=(trigger,options)=>orchestrator.runMarketCycle(trigger,options);
  const params={now:cut,countries:['US'],allowExhaustedProviders:true};
  if(attempt==='switch'){
    const quotes=[],broadcast=orchestrator.socketServer.broadcast.bind(orchestrator.socketServer);
    orchestrator.socketServer.broadcast=(event,payload,...rest)=>{
      if(event==='update'&&payload.market)quotes.push(Object.keys(payload.market.quotes));
      return broadcast(event,payload,...rest);
    };
    const running=cycle('manual-original',params);
    try{
      await Promise.race([dispatched.promise,running.then(()=>assert.fail('expected a provider dispatch'))]);
      const response=await fetch('http://127.0.0.1:'+runtime.server.address().port+'/api/market/watchlist',{
        method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({instrumentIds:['us-equity-boeing']})});
      assert.equal(response.status,200);
      assert.equal(cycle('watchlist-update',{}),running);
      assert.equal(cycle('watchlist-update',{}),running);
    }finally{release.resolve();}
    await running;await orchestrator.marketProjectionTask;
    assert.equal(network,2);
    assert.ok(quotes.length && quotes.every(symbols=>symbols.length===1 && symbols[0]==='BA'));
    const latest=await orchestrator.marketHistoryStore.presentation.read();
    assert.deepEqual(latest.frame.analysis.tickers,['BA']);assert.equal(latest.job.phase,'published');
  }else if(attempt==='deferred'){
    const admission=orchestrator.admission;
    orchestrator.admission={assert(kind){if(kind==='acquisition')throw pressureError({state:'degraded',reason:'fixture'});},
      status:()=>({state:'degraded'}),off(){}};
    const first=cycle('manual-original',params),joined=cycle('interval-market',{countries:['FR']});
    assert.equal(first,joined);
    await assert.rejects(first,{code:'STORAGE_RESOURCE_PRESSURE'});
    const job=await turns.pending();
    assert.equal(job.phase,'admission');
    assert.equal(job.input.selection.trigger,'manual-original');
    assert.deepEqual(job.input.selection.instrumentIds,['us-equity-general-dynamics']);
    assert.deepEqual(job.input.selection.countries,['US']);
    assert.equal(network,0);
    orchestrator.admission=admission;
  }else if(attempt==='uncertain'){
    const request=storageManager.request.bind(storageManager);
    storageManager.request=async(op,input,options)=>{
      if(op==='runtime.save' && input.kind==='market-publication')throw Object.assign(Error('ACK missing'),{code:'STORAGE_OUTCOME_UNKNOWN'});
      return request(op,input,options);
    };
    await assert.rejects(cycle('manual-original',params),{code:'STORAGE_OUTCOME_UNKNOWN'});
    const job=await turns.pending();
    assert.equal(job.phase,'request-authorized');
    assert.equal(network,1);
    assert.equal(await orchestrator.marketHistoryStore.presentation.read(),null);
  }else{
    const prior=await turns.pending();
    assert.ok(prior);
    if(attempt==='supersede'){
      runtime.config.market.tickers=['BA'];
      const skipped=await cycle('startup-market',{});
      assert.equal(skipped.reason,'selection-superseded');
      assert.equal((await storageManager.request('continuation.get',{jobId:prior.jobId})).phase,'skipped');
      assert.equal(network,0);
    }else{
      if(attempt==='reconcile'){
        const waiting=await cycle('startup-market',{});
        assert.equal(waiting.reason,'prior-request-unconfirmed');assert.equal(waiting.jobId,prior.jobId);
        assert.equal(network,0);
        turns.now=()=>Date.parse(prior.input.nextEligibleAt)+1;
      }
      await cycle('manual-successor',{...params,countries:['FR']});
      await orchestrator.marketProjectionTask;
      assert.equal(network,1);
      const frame=await orchestrator.marketHistoryStore.presentation.read();
      assert.equal(frame.job.phase,'published');assert.equal(frame.frame.market.quotes.GD.price,142);
      const job=await storageManager.request('continuation.get',{jobId:frame.frame.quoteTurn.jobId});
      assert.equal(job.phase,'confirmed');assert.equal(job.input.presentationJobId,frame.job.jobId);
      if(attempt==='reconcile'){
        assert.notEqual(job.jobId,prior.jobId);
        assert.equal((await storageManager.request('continuation.get',{jobId:prior.jobId})).phase,'unconfirmed');
      }else{
        assert.equal(job.jobId,prior.jobId);assert.equal(job.input.selection.referenceAt,cut);
        assert.deepEqual(frame.frame.analysis.countryFilter,['US']);assert.equal(frame.frame.trigger,'manual-original');
      }
    }
    assert.equal(await turns.pending(),null);
  }
}finally{
  if(attempt==='uncertain')await assert.rejects(runtime.stop(),{code:'STORAGE_OUTCOME_UNKNOWN'});
  else await runtime.stop();
}
if(['deferred','uncertain'].includes(attempt)){
  const report=runtime.app.locals.shutdownReport.deferredPersistence.cycleContinuations;
  assert.ok(report.some(row=>row.durable && row.domain==='market' && row.phase===(attempt==='deferred'?'admission':'request-authorized')));
}
