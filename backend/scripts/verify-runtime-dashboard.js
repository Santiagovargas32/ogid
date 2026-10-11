// Optional browser dependency stays outside the project: see the audit commands.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
createRequire(import.meta.url)('../tests/testSetup.cjs');process.env.LOG_LEVEL='error';
const {createAppServer}=await import('../server.js');
const {chromium}=await import(process.env.OGID_PLAYWRIGHT_MODULE||'playwright');
const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,market:{enabled:false,historyPersist:false,tickers:['GD','BA']},news:{providers:[],rssFeeds:[]}});
const manager=runtime.orchestrator.stateManager;
const articles=Array.from({length:60},(_,i)=>({id:`fixture-${i}`,identity:`fixture-${i}`,provider:'rss',sourceName:'Fixture publisher',title:`Fixture Israel conflict report ${i}`,url:`https://fixture.test/${i}`,publishedAt:'2026-10-11T12:00:00Z',receivedAt:'2026-10-11T12:00:00Z',countryMentions:['IL'],threatLevel:'monitoring',topicTags:['conflict']}));
function publish(news){const snapshot=manager.updateIntel({news,signalCorpus:news,newsSourceMode:'live',newsSourceMeta:{provider:'fixture'},watchlistCountries:['IL']});runtime.socketServer.broadcast('update',runtime.orchestrator.buildUpdatePayload(snapshot),snapshot.meta);}
publish(articles);await runtime.start();
const base=`http://127.0.0.1:${runtime.server.address().port}`;
let browser,page;
const result={checks:[],errors:[],requests:{}};
try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});result.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1366,height:768},reducedMotion:'reduce'});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.host===new URL(base).host){
      if(process.env.OGID_DASHBOARD_SOURCE&&url.pathname==='/js/dashboard.js')return route.fulfill({body:await readFile(process.env.OGID_DASHBOARD_SOURCE),contentType:'text/javascript'});
      if(url.pathname.startsWith('/api/'))result.requests[url.pathname]=(result.requests[url.pathname]||0)+1;return route.continue();
    }
    const asset=url.pathname.includes('bootstrap')?(url.pathname.endsWith('.css')?'bootstrap.css':'bootstrap.js'):url.pathname.includes('chart')?'chart.js':null;
    if(asset)return route.fulfill({body:await readFile(join(process.env.OGID_UI_CDN||'/tmp/ogid-runtime-audit/cdn',asset)),contentType:asset.endsWith('.css')?'text/css':'text/javascript'});
    return route.abort();
  });
  let wsBlocked=false;const transports=[];
  // Simulate an accepted transport that never delivers a snapshot. This must
  // not suppress HTTP recovery, even though the browser fires an open event.
  await context.routeWebSocket('**/ws',ws=>{if(wsBlocked){transports.push({ws,upstream:{close(){}}});return;}const upstream=ws.connectToServer();transports.push({ws,upstream});});
  await context.addInitScript(()=>{
    let chart;
    Object.defineProperty(window,'Chart',{configurable:true,get:()=>chart,set:value=>{
      chart=value;const update=chart.prototype.update;
      chart.prototype.update=function(...args){window.__chartUpdates=(window.__chartUpdates||0)+1;return update.apply(this,args);};
    }});
  });
  page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));
  await page.goto(base);await page.locator('.news-item').first().waitFor();
  await page.waitForTimeout(1000);
  await page.evaluate(()=>{window.__row=document.querySelector('.news-item');window.__chartBefore=window.__chartUpdates;});
  const snapshot=manager.getSnapshot();
  const marketUpdate=runtime.orchestrator.buildMarketUpdatePayload(snapshot);
  result.payloadBytes={full:Buffer.byteLength(JSON.stringify(runtime.orchestrator.buildUpdatePayload(snapshot))),market:Buffer.byteLength(JSON.stringify(marketUpdate))};
  for(let i=0;i<20;i++)runtime.socketServer.broadcast('update',marketUpdate,snapshot.meta);
  await page.waitForTimeout(200);
  const rendering=await page.evaluate(()=>({newsRowPreserved:window.__row===document.querySelector('.news-item'),chartUpdatesForUnchangedData:window.__chartUpdates-window.__chartBefore}));
  assert.equal(rendering.newsRowPreserved,true);assert.equal(rendering.chartUpdatesForUnchangedData,0);result.rendering=rendering;
  result.checks.push('20 unchanged updates preserve news DOM and perform zero chart updates');
  wsBlocked=true;for(const transport of transports){transport.ws.close();transport.upstream.close();}
  const offline={...articles[0],id:'fixture-offline',identity:'fixture-offline',title:'Fixture article acquired during disconnection',publishedAt:new Date().toISOString()};
  publish([offline,...articles]);
  await page.waitForFunction(()=>document.querySelector('.news-item[data-news-identity="fixture-offline"]'),{},{timeout:25_000});
  result.checks.push('HTTP stored fallback recovers selected news during WS outage');
  const snapshotsAtRecovery=result.requests['/api/intel/snapshot'];
  wsBlocked=false;
  for(const transport of transports){transport.ws.close();transport.upstream.close();}
  await page.waitForFunction(()=>document.querySelector('#ws-status-badge')?.textContent==='WS: connected',{},{timeout:30_000});
  assert.equal(await page.locator('.news-item[data-news-identity="fixture-offline"]').count(),1);
  await page.waitForTimeout(1000);
  assert.equal(result.requests['/api/intel/snapshot'],snapshotsAtRecovery);
  result.checks.push('reconnect uses one WS snapshot without a duplicate HTTP resync');
  const admin=await context.newPage();admin.on('pageerror',e=>result.errors.push(e.message));
  await admin.goto(base+'/admin');await admin.locator('#server-summary-body .diagnostic-item').first().waitFor();
  result.checks.push('Admin diagnostics render');await admin.close();
  const mobile=await context.newPage();mobile.on('pageerror',e=>result.errors.push(e.message));
  await mobile.setViewportSize({width:390,height:844});await mobile.goto(base);await mobile.locator('.news-item').first().waitFor();
  await mobile.waitForFunction(()=>document.querySelector('#ws-status-badge')?.textContent==='WS: connected');
  assert.equal(runtime.socketServer.clientCount(),2);
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  result.checks.push('two simultaneous dashboard tabs; mobile viewport without overflow');
  assert.deepEqual(result.errors,[]);await context.close();
  if(process.env.OGID_UI_RESULT)await writeFile(process.env.OGID_UI_RESULT,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}catch(error){
  result.failure=error.message.split('\n')[0];
  if(page&&!page.isClosed())result.state=await page.evaluate(()=>({ws:document.querySelector('#ws-status-badge')?.textContent,newButton:document.querySelector('#news-new-button')?.textContent,offlineRows:document.querySelectorAll('.news-item[data-news-identity="fixture-offline"]').length}));
  if(process.env.OGID_UI_RESULT)await writeFile(process.env.OGID_UI_RESULT,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));throw error;
}finally{await browser?.close();await runtime.stop();}
