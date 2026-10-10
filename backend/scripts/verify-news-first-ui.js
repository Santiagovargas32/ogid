// Browser opcional: OGID_PLAYWRIGHT_MODULE apunta a una instalación local de playwright.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createAppServer} from '../server.js';
const {chromium}=await import(process.env.OGID_PLAYWRIGHT_MODULE || 'playwright');
const output=new URL('../../docs/news-first/screenshots/',import.meta.url);await mkdir(output,{recursive:true});
const runtime=createAppServer({port:0,disableBackgroundRefresh:true,market:{enabled:false,historyPersist:false},news:{providers:['rss'],rssFeeds:[],rssAggregateFeedsPerRun:1}});
const manager=runtime.orchestrator.stateManager;
const articles=Array.from({length:60},(_,i)=>({id:`fixture-${i}`,identity:`fixture-${i}`,provider:'rss',title:['Missile strike and sanctions raise regional pressure','Diplomatic talks resume as governments review ceasefire','Shipping routes adjust after security advisory'][i%3]+` · ${i+1}`,sourceName:['Reuters fixture','BBC fixture','Official release fixture'][i%3],publisher:['Reuters fixture','BBC fixture','Official release fixture'][i%3],description:'Fixture de verificación: los equipos siguen los acontecimientos regionales y sus efectos en las rutas comerciales.',excerpt:'Fixture de verificación: los equipos siguen los acontecimientos regionales y sus efectos en las rutas comerciales.',url:`https://fixture.test/${i}`,leadImageUrl:i===0?'https://fixture.test/broken.jpg':null,publishedAt:new Date(Date.now()-i*60000).toISOString(),receivedAt:new Date().toISOString(),countryMentions:['US','IL','IR'],threatLevel:['critical','elevated','monitoring'][i%3],severityOrigin:'rss-classifier-rules',topicTags:['conflict','shipping']}));
function publish(items){const snapshot=manager.updateIntel({news:items,signalCorpus:items,newsSourceMode:'live',newsSourceMeta:{provider:'rss',rssIngestion:{active:false,availability:'healthy',lastSuccessAt:new Date().toISOString()}},watchlistCountries:['US','IL','IR']});runtime.socketServer.broadcast('update',runtime.orchestrator.buildUpdatePayload(snapshot),snapshot.meta);}
publish(articles);await runtime.start();
const base=`http://127.0.0.1:${runtime.server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const result={browser:browser.version(),layouts:[],errors:[],checks:[]};
const cdnRoot=process.env.OGID_UI_CDN || '/tmp/ogid-ui-cdn';
async function routes(context,before=false){
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.host===new URL(base).host){
   if(before&&(!url.pathname.startsWith('/api/')&&url.pathname!='/ws')){
    const path=url.pathname==='/'?'index.html':url.pathname==='/admin'?'admin.html':url.pathname.slice(1);
    try{const body=await readFile(join(process.env.OGID_BEFORE_UI||'/tmp/ogid-before-ui/frontend',path));await route.fulfill({body,contentType:path.endsWith('.html')?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});return;}catch{}
   }
   return route.continue();
  }
  const resource=url.pathname.includes('bootstrap')?(url.pathname.endsWith('.css')?'bootstrap.css':'bootstrap.js'):url.pathname.includes('chart')?'chart.js':url.pathname.includes('leaflet')?(url.pathname.endsWith('.css')?'leaflet.css':'leaflet.js'):null;
  if(resource){const body=await readFile(join(cdnRoot,resource));return route.fulfill({body,contentType:resource.endsWith('.css')?'text/css':'text/javascript'});}
  return route.abort(); // Tiles, vídeos e imágenes externas no forman parte del fixture.
 });
}
try{
 const beforeContext=await browser.newContext({viewport:{width:1366,height:768},ignoreHTTPSErrors:true});await routes(beforeContext,true);const before=await beforeContext.newPage();await before.goto(base);await before.waitForTimeout(1000);await before.screenshot({path:new URL('before-1366.png',output).pathname});const beforeAdmin=await beforeContext.newPage();await beforeAdmin.route('**/api/news/aggregate?**',()=>new Promise(()=>{}));await beforeAdmin.goto(base+'/admin');await beforeAdmin.waitForTimeout(800);result.beforeAdminWithPendingRss=await beforeAdmin.locator('#server-summary-body .diagnostic-item').count();assert.equal(result.beforeAdminWithPendingRss,0);await beforeAdmin.screenshot({path:new URL('admin-before.png',output).pathname});await beforeContext.close();
 const context=await browser.newContext({viewport:{width:1366,height:768},reducedMotion:'reduce',ignoreHTTPSErrors:true});await routes(context);const page=await context.newPage();page.on('pageerror',error=>result.errors.push(error.message));
 let wsBlocked=false;const socketRoutes=[];await context.routeWebSocket('**/ws',ws=>{if(wsBlocked){ws.close();return;}const upstream=ws.connectToServer();socketRoutes.push({ws,upstream});});
 const start=Date.now();await page.goto(base);await page.locator('.news-item').first().waitFor();result.firstFeedMs=Date.now()-start;
 assert.equal(await page.locator('.news-new-marker').count(),0);
 assert.equal(await page.locator('.news-item img.news-thumb').count(),await page.locator('.news-item').count());
 const placeholder=await page.locator('.news-thumb').first().getAttribute('src');assert.match(placeholder,/news-placeholder/);result.checks.push('each article keeps a lazy image and placeholder');
 const first=await page.locator('.news-item').first().getAttribute('data-news-identity');
 await page.evaluate(()=>{window.__fixtureRow=document.querySelector('.news-item');});
 runtime.socketServer.broadcast('update',{market:manager.getSnapshot().market},manager.getSnapshot().meta);await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.__fixtureRow===document.querySelector('.news-item')),true);result.checks.push('market update preserves DOM identity');
 await page.locator('#news-feed').evaluate(el=>{el.scrollTop=350;});await page.locator('.news-item .news-title-button').nth(4).focus();const scrollBefore=await page.locator('#news-feed').evaluate(el=>el.scrollTop);
 const item={...articles[0],id:'fixture-new',identity:'fixture-new',title:'Nueva noticia crítica del fixture',publishedAt:new Date().toISOString()};publish([item,...articles]);await page.waitForTimeout(150);
 assert.equal(await page.locator('.news-item').first().getAttribute('data-news-identity'),first);assert.equal(await page.locator('#news-feed').evaluate(el=>el.scrollTop),scrollBefore);assert.ok((await page.locator('#news-new-button').innerText()).includes('1'));result.checks.push('new batch preserves reading scroll and focus');
 publish([item,...articles.filter(a=>a.id!==first)]);await page.waitForTimeout(100);assert.equal(await page.locator('.news-item').first().getAttribute('data-news-identity'),first);result.checks.push('reading row survives removal from selected window until acknowledgement');
 await page.locator('#news-new-button').click();await page.waitForTimeout(100);assert.equal(await page.locator('.news-item').first().getAttribute('data-news-identity'),'fixture-new');
 await page.locator('.news-title-button').first().click();await page.locator('#news-detail-drawer.show').waitFor();assert.ok((await page.locator('#news-detail-title').innerText()).includes('Nueva'));publish([{...item,title:'Nueva noticia crítica actualizada'},...articles]);await page.waitForTimeout(100);assert.equal(await page.locator('#news-detail-drawer.show').count(),1);assert.ok((await page.locator('#news-detail-title').innerText()).includes('actualizada'));result.checks.push('drawer stays open across editorial revision');
 await page.locator('#news-detail-drawer .btn-close').click();await page.waitForTimeout(350);
 // Cortar el transporte real del browser; el fallback sigue leyendo estado almacenado.
 wsBlocked=true;for(const socket of socketRoutes){socket.ws.close();socket.upstream.close();}
 const disconnected={...articles[0],id:'fixture-offline',identity:'fixture-offline',title:'Noticia durante desconexión',publishedAt:new Date().toISOString()};publish([disconnected,item,...articles]);
 await page.locator('#news-new-button').waitFor({state:'visible',timeout:22000});
 await page.waitForFunction(()=>document.querySelector('#news-new-button').textContent.includes('1'),{},{timeout:22000});
 assert.equal(await page.locator('.news-item[data-news-identity="fixture-offline"]').count(),1);result.checks.push('stored fallback recovers new selected article during socket outage');
 wsBlocked=false;await page.waitForFunction(()=>document.querySelector('#ws-status-badge')?.textContent.toLowerCase().includes('connected'),{},{timeout:20000});
 assert.ok((await page.locator('#news-new-button').innerText()).includes('1'));result.checks.push('socket reconnect keeps baseline without duplicate novelty');
 for(const [width,height] of [[1920,1080],[1366,768],[390,844]]){await page.setViewportSize({width,height});await page.screenshot({path:new URL(`after-${width}.png`,output).pathname});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false,`overflow at ${width}`);result.layouts.push({width,height,overflow});}
 const admin=await context.newPage();admin.on('pageerror',error=>result.errors.push(error.message));
 await admin.route('**/api/news/aggregate?**',()=>new Promise(()=>{}));const adminStart=Date.now();await admin.goto(base+'/admin');await admin.locator('#server-summary-body .diagnostic-item').first().waitFor();result.firstAdminMs=Date.now()-adminStart;assert.equal(await admin.locator('#history-form').count(),0);await admin.screenshot({path:new URL('admin-after.png',output).pathname});result.checks.push('Admin partial render with hanging RSS');await admin.close();
 assert.deepEqual(result.errors,[]);await context.close();
 console.log(JSON.stringify(result,null,2));await writeFile(new URL('../ui-verification.json',output),JSON.stringify(result,null,2)+'\n');
}finally{await browser.close();await runtime.stop();}
