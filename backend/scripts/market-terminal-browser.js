// Operator-run browser regression using the real dashboard markup and chart
// library, with frozen UI data. No OGID backend, SQLite or provider traffic.
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';
import assert from 'node:assert/strict';
const output=process.argv[2];if(!output)throw Error('Usage: node scripts/market-terminal-browser.js NEW-private-output-directory');
mkdirSync(output,{mode:0o700});
const frontend=fileURLToPath(new URL('../../frontend/',import.meta.url));
const html=readFileSync(join(frontend,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>',`<script type="module">
import {mountMarketTerminal,loadTerminalChartLibrary,renderTerminalChart} from '/js/marketTerminal.js';
let chart;
window.terminal=mountMarketTerminal({onChange:async active=>{
 chart?.destroy();chart=null;
 if(!active)return;
 const originalLibrary=await loadTerminalChartLibrary();
 const library={...originalLibrary,createChart(...args){window.fixtureChart=originalLibrary.createChart(...args);return window.fixtureChart;}};
 const canvas=document.getElementById('market-ohlcv-chart');canvas.hidden=true;
 let target=document.getElementById('terminal-price-chart');if(!target){target=document.createElement('div');target.id='terminal-price-chart';canvas.after(target);}
 chart=renderTerminalChart(target,[{openTime:'2026-11-10T00:00:00Z',open:100,high:105,low:98,close:104,volume:123},{openTime:'2026-11-11T00:00:00Z',open:104,high:107,low:100,close:102,volume:null}], '1day',library);
 window.fixtureSeries=chart;
 window.chartReady=true;
}});
window.fixtureReady=true;
</script></body>`);
const server=createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
 const file=resolve(frontend,'.'+pathname);
 if(!file.startsWith(frontend)){res.writeHead(403).end();return;}
 try{const content=readFileSync(file);res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(content);}catch{res.writeHead(404).end();}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const profile=resolve(output,'profile');
const browser=spawn(process.env.OGID_BROWSER_BINARY||'/home/fedora/.cache/ms-playwright/chromium-1194/chrome-linux/chrome',['--headless','--disable-background-networking','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
let socket,sequence=0,diagnostics='';const pending=new Map(),events=[];
const report={fixtureOnly:true,checks:[],errors:[]};
try{
 const endpoint=await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('Browser startup timeout')),15000);browser.once('exit',()=>{clearTimeout(timer);fail(Error('Browser exited: '+diagnostics.slice(-1000)));});browser.stderr.on('data',chunk=>{diagnostics+=chunk.toString();const match=diagnostics.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);ok(match[1]);}});});
 socket=new WebSocket(endpoint);await once(socket,'open');
 socket.addEventListener('message',message=>{const value=JSON.parse(message.data);if(value.id){const item=pending.get(value.id);if(item){pending.delete(value.id);clearTimeout(item.timer);value.error?item.reject(Error(value.error.message)):item.resolve(value.result);}}else if(events.length<10000)events.push(value);});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const page=(method,params={})=>send(method,params,sessionId);
 await page('Runtime.enable');await page('Page.enable');await page('Network.enable');
 const evaluate=async expression=>{const result=await page('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;};
 const until=async expression=>{for(let n=0;n<80;n++){if(await evaluate(expression))return;await pause(100);}throw Error('Browser condition timeout: '+expression);};
 for(const width of [1280,992,768,390]){
  await page('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===390});
  await page('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
  await until('window.fixtureReady===true');
  await evaluate("localStorage.removeItem('ogid:market-terminal');document.querySelector('.view-nav button').click()");
  await until('window.chartReady===true');
  assert.match(await evaluate("document.getElementById('terminal-connection-status').textContent"),/Actualización en espera/);
  await evaluate('window.terminal.setConnection(true)');
  assert.match(await evaluate("document.getElementById('terminal-connection-status').textContent"),/Actualizaciones conectadas/);
  const metrics=JSON.parse(await evaluate(`JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,chartWidth:document.querySelector('.terminal-chart-panel').getBoundingClientRect().width,feedWidth:document.querySelector('[data-feed-slot]').getBoundingClientRect().width,chartTop:document.querySelector('.terminal-chart-panel').getBoundingClientRect().top,feedTop:document.querySelector('[data-feed-slot]').getBoundingClientRect().top,rows:document.querySelectorAll('.terminal-series-table tbody tr').length,active:window.terminal.active,ids:[...document.querySelectorAll('[id]')].map(x=>x.id)})`));
  assert.equal(metrics.active,true);assert.equal(metrics.rows,2);assert.equal(metrics.ids.length,new Set(metrics.ids).size);
  assert.ok(metrics.scrollWidth<=width+1,JSON.stringify(metrics));
  if(width>=992){assert.ok(Math.abs(metrics.chartWidth/metrics.feedWidth-1.5)<.05);assert.ok(Math.abs(metrics.chartTop-metrics.feedTop)<2);}else assert.ok(metrics.feedTop>metrics.chartTop);
  await evaluate("document.querySelector('.terminal-series-table').parentElement.open=true;document.querySelector('#terminal-price-chart button').click()");
  const range=await evaluate('window.fixtureChart.timeScale().getVisibleLogicalRange()');
  await evaluate("window.previousCanvas=document.querySelector('#terminal-price-chart canvas');window.fixtureSeries.update([{openTime:'2026-11-10T00:00:00Z',open:100,high:108,low:98,close:106,volume:200},{openTime:'2026-11-11T00:00:00Z',open:104,high:107,low:100,close:102,volume:null}])");
  assert.equal(await evaluate("window.previousCanvas===document.querySelector('#terminal-price-chart canvas')&&document.querySelector('.terminal-series-table tbody tr').cells[4].textContent==='106'"),true);
  const after=await evaluate('window.fixtureChart.timeScale().getVisibleLogicalRange()');
  assert.ok(Math.abs(range.from-after.from)<.01&&Math.abs(range.to-after.to)<.01,'refresh preserves zoom');
  const shot=await page('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(output,`terminal-${width}.png`),Buffer.from(shot.data,'base64'),{mode:0o600});
  await evaluate("document.querySelector('[data-classic]').click()");
  assert.equal(await evaluate("!window.terminal.active&&document.querySelector('.dashboard-primary-row #panel-news')!==null&&document.querySelector('#panel-market .market-ohlcv-header')!==null"),true);
  report.checks.push({width,layoutAndRestore:true,chart:true,tableRows:metrics.rows});
 }
 report.errors=events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.text);
 assert.deepEqual(report.errors,[]);
 report.apiRequests=events.filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.url.includes('/api/')).length;
 assert.equal(report.apiRequests,0);
 writeFileSync(resolve(output,'result.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify(report));await send('Browser.close');
}catch(error){writeFileSync(resolve(output,'error.json'),JSON.stringify({message:error.message,diagnostics:diagnostics.slice(-1000)},null,2),{mode:0o600});throw error;}
finally{socket?.close();for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Browser closed'));}if(browser.exitCode===null)browser.kill('SIGTERM');await new Promise(ok=>server.close(ok));}
