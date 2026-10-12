import {createRequire} from 'node:module';
import {writeFile,copyFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
const {chromium}=await import(process.env.OGID_PLAYWRIGHT_MODULE || 'playwright');
createRequire(import.meta.url)('../tests/testSetup.cjs');process.env.LOG_LEVEL='error';
const sqlSource=process.env.OGID_BROWSER_SOURCE_DB;let databasePath,directory,instruments=[];
if(sqlSource){
 directory=await mkdtemp(join(process.env.OGID_BROWSER_ROOT || tmpdir(),'ogid-browser-sql-'));databasePath=join(directory,'candidate.sqlite');await copyFile(sqlSource,databasePath);
 const db=new Database(databasePath,{readonly:true});
 const snapshot=JSON.parse(db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='market'").get().payload_json);
 const ids=Object.values(snapshot.quotes || {}).map(q=>q.instrumentId);
 instruments=db.prepare('SELECT metadata_json FROM instruments').all().map(r=>JSON.parse(r.metadata_json)).filter(i=>ids.includes(i.instrumentId));db.close();
 if(!instruments.length)throw Error('browser-fixture-no-instruments');globalThis.__OGID_TEST_MARKET_INSTRUMENTS__=instruments;
}
const {createAppServer}=await import('../server.js');
const feed=createServer((req,res)=>res.end(`<rss><channel><item><title>Fixture Israel conflict browser reconnect ${round}</title><link>http://127.0.0.1/story/browser/${round}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`));let round=1;
feed.listen(0,'127.0.0.1');await once(feed,'listening');
const options={port:0,host:'127.0.0.1',disableBackgroundRefresh:true,news:{rssAggregateIntervalMs:1,providers:['rss'],rssFeeds:[{url:`http://127.0.0.1:${feed.address().port}/rss`,label:'Browser fixture',minPollIntervalMs:1}]},market:{enabled:false,provider:'',historyPersist:false},awareness:{mode:'off'},ai:{mode:'off',provider:'none'}};
if(sqlSource){
 const symbols=instruments.map(i=>i.canonicalSymbol),byYahoo=new Map(instruments.map(i=>[i.providerSymbols?.yahoo || i.canonicalSymbol,i]));
 options.storage={enabled:true,businessEnabled:true,databasePath};
 options.market={...options.market,enabled:true,provider:'yahoo',initialTickers:symbols,tickers:symbols,historyDir:directory,dailyCandles:{enabled:false},intradayCandles:{enabled:false}};
 options.awareness={mode:'visible'};
 options.marketDataService={fetchQuotes:async requested=>requested.map(symbol=>({symbol,price:100,previousClose:99,changePercent:1,volume:1000,currency:byYahoo.get(symbol)?.currency || 'USD',exchange:byYahoo.get(symbol)?.exchange || 'NYSE',timezone:byYahoo.get(symbol)?.timezone || 'America/New_York',timestamp:new Date().toISOString(),marketState:'CLOSED'}))};
}
let runtime=createAppServer(options);const wsSockets=new Set();let upgradeTracker;
const trackSockets=()=>{upgradeTracker=(_req,socket)=>{wsSockets.add(socket);socket.once("close",()=>wsSockets.delete(socket));};runtime.server.on("upgrade",upgradeTracker);};
const stopBackend=async()=>{runtime.server.removeListener("upgrade",upgradeTracker);await runtime.stop();};
trackSockets();let browser;const result={pages:[],errors:[],requests:0,legacySnapshotRequests:0,steps:[]};
try{
 await runtime.start();await runtime.orchestrator.runCycle('browser-fixture');const base=`http://127.0.0.1:${runtime.server.address().port}`;
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext();
 const pages=[];
 for(let count=0;count<10;count++){
  const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));page.on('request',request=>{result.requests++;if(new URL(request.url()).pathname==='/api/intel/snapshot')result.legacySnapshotRequests++;});
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#ws-status-badge')?.textContent==='WS: connected',{timeout:20000});pages.push(page);
  if(count===4)result.steps.push({stage:'five-tabs',clients:runtime.socketServer.clientCount()});
 }
 result.steps.push({stage:'ten-tabs',clients:runtime.socketServer.clientCount()});
 const before=await Promise.all(pages.map(p=>p.evaluate(()=>document.querySelector('#news-feed')?.textContent || document.body.textContent)));
 await context.setOffline(true);for(const socket of wsSockets)socket.destroy();await delay(1500);round++;
 if(sqlSource)await runtime.orchestrator.runNewsCycle('browser-offline-news',{allowExhaustedProviders:true});
 else{await runtime.app.locals.rssAggregator.refresh({force:true});await runtime.orchestrator.runNewsCycle('browser-offline-news',{rssOnly:true});}
 result.steps.push({stage:'backend-updated',titles:runtime.orchestrator.stateManager.state.news.map(n=>n.title),clients:runtime.socketServer.clientCount()});await context.setOffline(false);
 await Promise.all(pages.map(p=>p.waitForFunction(()=>document.querySelector('#ws-status-badge')?.textContent==='WS: connected',{timeout:30000})));
 await Promise.all(pages.map(p=>p.waitForFunction(()=>document.querySelector("#news-feed")?.textContent.includes("reconnect 2"),{timeout:30000})));
 result.steps.push({stage:'reconnected',clients:runtime.socketServer.clientCount()});
 if(sqlSource){
  const previousEpoch=runtime.socketServer.sync.epoch;options.port=runtime.server.address().port;
  await stopBackend();await delay(500);runtime=createAppServer(options);trackSockets();await runtime.start();await runtime.orchestrator.runCycle('browser-restart');
  await Promise.all(pages.map(p=>p.waitForFunction(()=>document.querySelector('#ws-status-badge')?.textContent==='WS: connected'&&document.querySelector('#news-feed')?.textContent.includes('reconnect 2'),{timeout:30000})));
  result.steps.push({stage:'backend-restarted-same-port',clients:runtime.socketServer.clientCount(),newEpoch:previousEpoch!==runtime.socketServer.sync.epoch});
  await Promise.all(pages.map(p=>p.waitForFunction(count=>document.querySelectorAll('#market-quotes-body tr').length===count,instruments.length,{timeout:30000})));
  result.sqlite={instruments:instruments.length,analysisReadOnly:runtime.storageManager.getStatus().analysis.queryOnly,quoteRows:await Promise.all(pages.map(p=>p.locator('#market-quotes-body tr').count()))};
  const expectedPrices=Object.fromEntries(Object.entries(runtime.orchestrator.stateManager.state.market.quotes).map(([symbol,q])=>[symbol,Number.isFinite(q.price)?q.price.toFixed(2):'--']));
  result.sqlite.matchesServedPrices=await Promise.all(pages.map(p=>p.evaluate(expected=>[...document.querySelectorAll('#market-quotes-body tr')].every(row=>row.cells[1]?.textContent.trim()===expected[row.querySelector('strong')?.textContent.trim()]),expectedPrices)));
  if(result.sqlite.matchesServedPrices.some(value=>!value))throw Error('browser-quote-price-mismatch');
  await pages[0].evaluate(()=>{window.__ogidFixtureClock=Date.now;const now=Date.now();Date.now=()=>now;window.__ogidFixtureRow=document.querySelector('#market-quotes-body tr');window.__ogidFixtureNews=document.querySelector('#news-feed')?.firstElementChild;});
  runtime.app.locals.pipelineMonitor.update('fixture-render',{enabled:true,status:'running',lastRunAt:new Date().toISOString()});
  await pages[0].waitForFunction(()=>document.querySelector('#pipeline-status-badge')?.textContent.includes('fixture-render'));
  result.sqlite.unchangedNodes=await pages[0].evaluate(()=>({quotes:window.__ogidFixtureRow===document.querySelector('#market-quotes-body tr'),news:window.__ogidFixtureNews===document.querySelector('#news-feed')?.firstElementChild}));
  await pages[0].evaluate(()=>{Date.now=window.__ogidFixtureClock;});
  runtime.app.locals.pipelineMonitor.update('fixture-render',{status:'completed',lastSuccessAt:new Date().toISOString()});
  if(!result.sqlite.unchangedNodes.quotes || !result.sqlite.unchangedNodes.news)throw Error('browser-unnecessary-rerender');
 }
 for(let i=0;i<pages.length;i++)result.pages.push({index:i,connected:await pages[i].locator('#ws-status-badge').textContent(),news:await pages[i].evaluate(()=>document.querySelector('#news-feed')?.textContent || ''),beforeBytes:before[i].length});
 if(result.errors.length||result.legacySnapshotRequests||runtime.socketServer.clientCount()!==10)throw Error('browser-errors-or-client-count');
}catch(e){result.failure=e.message;result.diagnostic=await Promise.all((await browser?.contexts()[0]?.pages() || []).map(async p=>({status:await p.locator("#ws-status-badge").textContent(),news:await p.locator("#news-feed").textContent()})));process.exitCode=1;}
finally{await browser?.close();await stopBackend();await new Promise(r=>feed.close(r));await writeFile(process.env.OGID_BROWSER_ARTIFACT || '/tmp/ogid-browser-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
