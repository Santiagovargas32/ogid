// Explicit isolated browser benchmark. Never opens the configured operational DB
// or a real provider/model; ordinary npm test does not execute this script.
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import assert from 'node:assert/strict';
createRequire(import.meta.url)('../tests/testSetup.cjs');
process.env.LOG_LEVEL='error';
const [outputArg,samplesArg='50',scope]=process.argv.slice(2),samples=Number(samplesArg);
const lifecycleOnly=scope==='--lifecycle-only';
if(!outputArg || !Number.isSafeInteger(samples)||samples<1||samples>100)throw Error('Usage: node scripts/dashboard-validation.js NEW-output-directory [navigations-per-cohort=50]');
const output=resolve(outputArg);mkdirSync(output,{mode:0o700});
const {chromium}=await import(process.env.OGID_PLAYWRIGHT_MODULE||'playwright');
const {createAppServer}=await import('../server.js');
const {createStorageBackup}=await import('../storage/backup.js');
const source=join(output,'source.sqlite'),candidate=join(output,'candidate.sqlite');
const options=file=>({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:file},agent:{mode:'off'},
  news:{providers:[],rssFeeds:[]},awareness:{mode:'off'},market:{enabled:false,historyPersist:false,historyDir:output,creditStateFile:join(output,'credits.json'),tickers:['GD','BA','NOC'],initialTickers:['GD','BA','NOC'],dailyCandles:{enabled:false},intradayCandles:{enabled:false}}});
let runtime,browser,timer,tickTask,probeTimer,probeTask,sampler,acquisitions=0;
const controlProbes=[];
const report={schemaVersion:'ogid-dashboard-validation-v1',startedAt:new Date().toISOString(),kind:'synthetic fixtures on consistent SQLite backup; not historical replay or external-disk certification',samples,scenarios:[],errors:[],acceptance:'not-evaluated'};
const article=i=>({id:`fixture-${i}`,title:`Russia military conflict report ${i}`,url:`https://fixture.invalid/news/${i}`,provider:'rss',sourceName:`Fixture ${i%25}`,publishedAt:new Date(Date.now()-i*1000).toISOString(),description:`Attributed fixture report ${i}`,usagePolicy:'standard-link-out'});
try{
  runtime=createAppServer(options(source));await runtime.start();
  for(let i=0;i<400;i+=10)await runtime.app.locals.business.news.ingest(Array.from({length:10},(_,j)=>article(i+j)));
  await runtime.stop();runtime=null;
  report.backup=await createStorageBackup(source,candidate);
  runtime=createAppServer(options(candidate));await runtime.start();
  await runtime.app.locals.agentCall('enqueue',{task:'global_intelligence_brief',model:'llamacpp/fixture',key:'validation-lease',priority:10});
  const claim=await runtime.app.locals.agentCall('claim',{owner:'fixture-lease'}),auth={...claim,owner:'fixture-lease'};
  assert.ok(claim?.jobId,'fixture lease must be claimed before probing it');
  probeTimer=setInterval(()=>{
    if(probeTask)return;
    const started=performance.now();
    probeTask=runtime.app.locals.agentCall('heartbeat',{...auth,renewalId:`fixture-${controlProbes.length}`})
      .then(()=>controlProbes.push({at:Date.now(),ms:performance.now()-started}))
      .catch(error=>report.errors.push(error.code||error.message)).finally(()=>{probeTask=null;});
  },5000);
  const state=runtime.orchestrator.stateManager,feed=await runtime.app.locals.business.news.getFeed({limit:100});
  const quotes=Object.fromEntries(runtime.app.locals.marketWatchlistService.selectedInstruments().map((instrument,i)=>[instrument.canonicalSymbol,{instrumentId:instrument.instrumentId,price:100+i,changePct:1,currency:instrument.currency,exchange:instrument.exchange,source:'fixture',dataMode:'live',asOf:new Date().toISOString()}]));
  const history=Array.from({length:7000},(_,i)=>({timestamp:new Date(Date.now()-i*60000).toISOString(),price:100+i/100,changePct:i/1000}));
  const market={...state.state.market,quotes,provider:'fixture',sourceMode:'live',revision:'fixture-market',updatedAt:new Date().toISOString(),timeseries:Object.fromEntries(Object.keys(quotes).map(symbol=>[symbol,history]))};
  state.updateIntel({news:feed.items,market,sourceMode:'live',sourceMeta:{corpus:feed.meta}});
  runtime.socketServer.broadcast('snapshot',state.getSnapshot());
  timer=setInterval(()=>{
    if(tickTask)return;
    tickTask=(async()=>{
      acquisitions++;await runtime.app.locals.business.news.ingest([article(1000+acquisitions)]);
      const next=await runtime.app.locals.business.news.getFeed({limit:100});state.updateIntel({news:next.items,sourceMode:'live',sourceMeta:{corpus:next.meta}});
      runtime.socketServer.broadcast('update',{news:state.state.news,meta:state.state.meta});
    })().catch(error=>report.errors.push(error.code||error.message)).finally(()=>{tickTask=null;});
  },2000);
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const assets=resolve(new URL('../../.agent-validation/browser-assets-20261020',import.meta.url).pathname);
  const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
  for(const mode of lifecycleOnly?[]:['baseline-v2-8000','s1-v2-64k','dashboard-v1'])for(const clients of [1,2,5]){
    runtime.socketServer.sync.pageChars=mode==='baseline-v2-8000'?8000:null;
    const entries=[],before=runtime.storageManager.getStatus(),rssBefore=process.memoryUsage().rss,probeStart=controlProbes.length;
    const sampled=[];runtime.app.locals.runtimeMetrics.lag.reset();
    sampler=setInterval(()=>{
      const status=runtime.storageManager.getStatus();
      sampled.push({rss:process.memoryUsage().rss,pending:status.queue.pending,inFlight:status.queue.inFlight,readerPending:(status.analysis?.queue.pending||0)+(status.queries?.queue.pending||0),heartbeatAgeMs:status.worker?.heartbeatAt?Date.now()-Date.parse(status.worker.heartbeatAt):null});
    },1000);
    const navigate=async tenSeconds=>{
      const context=await browser.newContext({viewport:{width:1440,height:1000}});
      await context.route('**/*',async route=>{
        const url=route.request().url();
        if(url.startsWith(base)){
          if(mode!=='dashboard-v1'&&url.includes('/api/intel/bootstrap'))return route.fulfill({status:404,contentType:'application/json',body:'{"error":{"code":"NOT_FOUND"}}'});
          return route.continue();
        }
        const asset=url.includes('bootstrap')?(url.endsWith('.css')?'bootstrap.css':'bootstrap.js'):url.includes('chart')?'chart.js':null;
        if(asset)return route.fulfill({status:200,contentType:asset.endsWith('.css')?'text/css':'application/javascript',body:readFileSync(join(assets,asset))});
        return route.abort();
      });
      const page=await context.newPage(),requests=[],failures=[],statuses={},responseBytes=[];
      page.on('pageerror',error=>report.errors.push(error.message));
      page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/'))requests.push(url.pathname);});
      page.on('response',response=>{
        if(!response.url().includes('/api/'))return;
        statuses[response.status()]=(statuses[response.status()]||0)+1;
        responseBytes.push({path:new URL(response.url()).pathname,bytes:Number(response.headers()['content-length'])||0});
        if(response.status()>=500)failures.push({path:new URL(response.url()).pathname,status:response.status()});
      });
      const started=performance.now();
      try{
        await page.goto(base,{waitUntil:'domcontentloaded',timeout:30000});
        await page.waitForFunction(()=>performance.getEntriesByName('ogid:first-useful-view').length>0,{timeout:30000});
        const useful=await page.evaluate(()=>performance.getEntriesByName('ogid:first-useful-view')[0].startTime);
        await page.waitForFunction(()=>document.querySelector('#ws-status-badge')?.textContent==='WS: connected',{timeout:30000});
        await wait(tenSeconds?Math.max(0,10000-(performance.now()-started)):150);
        const view=await page.evaluate(()=>({news:document.querySelectorAll('.news-item').length,quotes:[...document.querySelectorAll('#market-quotes-body tr')].map(row=>row.cells[1]?.textContent.trim())}));
        assert.ok(view.news>0,'first useful view must contain fixture news');
        assert.deepEqual(view.quotes,Object.values(quotes).map(quote=>quote.price.toFixed(2)));
        assert.equal(requests.some(path=>path==='/api/agent/v1/models'||path==='/api/agent/v1/access'),false,'closed chat must not load models or device access');
        if(tenSeconds)assert.ok(requests.length<=20,`dashboard initial API budget: ${requests.length}`);
        const timing=await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/api/')).reduce((total,entry)=>({transferBytes:total.transferBytes+entry.transferSize,jsonBytes:total.jsonBytes+entry.decodedBodySize}),{transferBytes:0,jsonBytes:0}));
        entries.push({firstUsefulMs:useful,apiRequests:requests.length,syncRequests:requests.filter(path=>path==='/api/intel/sync').length,tenSeconds,failures,statuses,responseBytes,...timing});
        if(mode==='dashboard-v1'&&tenSeconds)await page.screenshot({path:join(output,`dashboard-${clients}-clients.png`),fullPage:true});
      }finally{await context.close();}
    };
    for(let batch=0;batch<Math.ceil(samples/clients);batch++)await Promise.all(Array.from({length:Math.min(clients,samples-batch*clients)},()=>navigate(false)));
    if(mode==='dashboard-v1')await Promise.all(Array.from({length:clients},()=>navigate(true)));
    const after=runtime.storageManager.getStatus();
    clearInterval(sampler);
    report.scenarios.push({mode,clients,n:entries.length,firstUsefulP95Ms:percentile(entries.map(entry=>entry.firstUsefulMs),.95),firstUsefulMaxMs:Math.max(...entries.map(entry=>entry.firstUsefulMs)),apiRequestsMedian:percentile(entries.filter(entry=>!entry.tenSeconds).map(entry=>entry.apiRequests),.5),syncRequestsMedian:percentile(entries.filter(entry=>!entry.tenSeconds).map(entry=>entry.syncRequests),.5),tenSecondApiCounts:entries.filter(entry=>entry.tenSeconds).map(entry=>entry.apiRequests),jsonBytesMedian:percentile(entries.map(entry=>entry.jsonBytes),.5),transferBytesMedian:percentile(entries.map(entry=>entry.transferBytes),.5),responseBytesMax:Math.max(...entries.flatMap(entry=>entry.responseBytes).map(entry=>entry.bytes)),httpFailures:entries.flatMap(entry=>entry.failures),httpStatuses:entries.map(entry=>entry.statuses),rssBefore,rssAfter:process.memoryUsage().rss,sampled,loop:runtime.app.locals.runtimeMetrics.snapshot().eventLoopDelayMs,controlProbes:controlProbes.slice(probeStart),analysisRecoveries:after.analysisRecovery.recoveries-before.analysisRecovery.recoveries,queryRecoveries:after.queryRecovery.recoveries-before.queryRecovery.recoveries,writerFailures:after.failed-before.failed});
    writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  }
  // Exercise details and navigation separately so they cannot contaminate the
  // initial-view comparison. No model/provider is used by these interactions.
  runtime.socketServer.sync.pageChars=null;
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),lifecycle={checks:[],requests:[]};report.lifecycle=lifecycle;
  let lifecyclePage;
  try{
    await context.route('**/*',async route=>{
      const url=route.request().url();
      if(url.startsWith(base+'/api/agent/v1/models'))return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"data":{"models":[],"state":"unavailable"}}'});
      if(url.startsWith(base))return route.continue();
      const asset=url.includes('bootstrap')?(url.endsWith('.css')?'bootstrap.css':'bootstrap.js'):url.includes('chart')?'chart.js':null;
      if(asset)return route.fulfill({status:200,contentType:asset.endsWith('.css')?'text/css':'application/javascript',body:readFileSync(join(assets,asset))});
      return route.abort();
    });
    await context.addInitScript(()=>{
      window.validationSockets=[];
      const NativeWebSocket=window.WebSocket;
      window.WebSocket=class extends NativeWebSocket{constructor(...args){super(...args);window.validationSockets.push(this);}};
    });
    const page=await context.newPage();lifecyclePage=page;
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('request',request=>{if(request.url().includes('/api/')){const url=new URL(request.url());lifecycle.requests.push(url.pathname+url.search);}});
    const connected=()=>page.waitForFunction(()=>document.querySelector('#ws-status-badge')?.textContent==='WS: connected',{timeout:30000});
    await page.goto(base);await connected();
    await page.locator('#news-next').click();await page.waitForFunction(()=>document.querySelector('#news-page').textContent.startsWith('Página 2'));
    assert.ok(lifecycle.requests.some(path=>path.startsWith('/api/intel/news')));lifecycle.checks.push('deferred-news-second-page');
    await page.evaluate(()=>{for(const country of ['ALL','US','ALL','RU']){const input=document.querySelector(`[data-country-toggle="${country}"]`);input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));}});
    await page.waitForFunction(()=>[...document.querySelectorAll('.country-selected-chips button')].map(node=>node.textContent).join(',')==='RU');
    await page.waitForFunction(()=>document.querySelectorAll('.news-item').length>0);lifecycle.checks.push('rapid-country-selection');
    await page.locator('#panel-advanced-intel').scrollIntoViewIfNeeded();await page.waitForTimeout(1000);
    assert.ok(lifecycle.requests.some(path=>path.startsWith('/api/intel/advanced-snapshot')));lifecycle.checks.push('details-on-visible-panel');
    const sockets=await page.evaluate(()=>window.validationSockets.length);
    await page.evaluate(()=>window.validationSockets.forEach(socket=>socket.close(1000,'fixture reconnect')));
    await page.waitForFunction(count=>window.validationSockets.length>count,sockets);await connected();lifecycle.checks.push('socket-reconnect');
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    await page.waitForTimeout(100);await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await connected();lifecycle.checks.push('bfcache-lifecycle-events');
    const second=await context.newPage();await second.goto(base);await second.waitForFunction(()=>document.querySelector('#ws-status-badge')?.textContent==='WS: connected');await second.close();lifecycle.checks.push('two-tabs');
    await page.locator('#agent-chat-open').click();await page.waitForFunction(()=>document.querySelector('.agent-chat-dialog').open);assert.ok(lifecycle.requests.includes('/api/agent/v1/models'));await page.locator('[data-close]').click();lifecycle.checks.push('explicit-chat-model-discovery');
    await page.goto(base+'/admin');await page.waitForTimeout(1000);await page.goto(base);await connected();lifecycle.checks.push('admin-dashboard');
    await page.reload();await connected();lifecycle.checks.push('warm-reload');
    await page.screenshot({path:join(output,'lifecycle-final.png'),fullPage:true});
  }catch(error){
    if(lifecyclePage){lifecycle.failedView=await lifecyclePage.evaluate(()=>({pagination:document.querySelector('#news-page')?.textContent,count:document.querySelector('#news-count')?.textContent,countries:document.querySelector('#country-filter-bar')?.innerText,news:[...document.querySelectorAll('.news-item h3')].map(node=>node.textContent).slice(0,3)}));await lifecyclePage.screenshot({path:join(output,'lifecycle-failure.png'),fullPage:true});}
    throw error;
  }finally{await context.close();}
  clearInterval(probeTimer);await probeTask;
  await runtime.app.locals.agentCall('state',{...auth,status:'incomplete',errorCode:'FIXTURE_COMPLETE'});
  report.acquisitions=acquisitions;report.storage=runtime.storageManager.getStatus();
  report.acceptance=report.errors.length?'failed':'deterministic-and-browser-fixture-only';
  assert.deepEqual(report.errors,[]);
}catch(error){report.failure=error.message;report.acceptance='failed';process.exitCode=1;}
finally{
  clearInterval(timer);clearInterval(probeTimer);clearInterval(sampler);await probeTask;await tickTask;await browser?.close();if(runtime)await runtime.stop();
  report.finishedAt=new Date().toISOString();writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({output,acceptance:report.acceptance,failure:report.failure,scenarios:report.scenarios.length}));
}
