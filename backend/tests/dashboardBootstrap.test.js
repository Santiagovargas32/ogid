import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAppServer} from '../server.js';
import {assertStorageVolume} from '../storage/volumeGuard.js';

test('dashboard bootstrap is compact, conditional, stored-only and full v2 details remain consistent',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'ogid-dashboard-contract-'));
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,
    news:{providers:[],rssFeeds:[]},market:{enabled:false,historyPersist:false,historyDir:directory,tickers:[],initialTickers:[]},agent:{mode:'off'}});
  t.after(async()=>{await runtime.stop();rmSync(directory,{recursive:true,force:true});});
  await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
  let acquisition=0;runtime.app.locals.rssAggregator.refresh=()=>{acquisition++;throw Error('unexpected acquisition');};
  const state=runtime.orchestrator.stateManager.state;
  const news=Array.from({length:35},(_,i)=>({id:`story-${i}`,revision:1,title:`Russia conflict ${i}`,url:`https://fixture.invalid/${i}`,provider:'rss',sourceName:'fixture',countryMentions:['RU'],publishedAt:new Date(Date.now()-i*1000).toISOString(),excerpt:'ñ🌎'.repeat(20)}));
  state.news=news;state.market={...state.market,quotes:{GD:{price:123.45,changePct:1.2,source:'fixture',currency:'USD'}},timeseries:{GD:Array.from({length:7000},(_,i)=>({timestamp:new Date(i*1000).toISOString(),price:i}))}};
  const original=structuredClone(state.market);
  runtime.socketServer.broadcast('update',{news:state.news,market:state.market});
  const response=await fetch(base+'/api/intel/bootstrap?profile=dashboard-v1&countries=ALL&limit=20');
  assert.equal(response.status,200);const text=await response.text();assert.ok(Buffer.byteLength(text)<=128*1024);
  const payload=JSON.parse(text).data;assert.equal(payload.profile,'dashboard-v1');assert.equal(payload.data.news.length,20);assert.equal(payload.data.market.quotes.GD.price,123.45);assert.equal(payload.data.market.timeseries,undefined);assert.equal(payload.agent.mode,'off');assert.equal(payload.analysis.lifecycle.snapshotAvailable,false);
  const etag=response.headers.get('etag');assert.ok(etag);
  const conditional=await fetch(base+'/api/intel/bootstrap?profile=dashboard-v1&countries=ALL&limit=20',{headers:{'If-None-Match':etag}});assert.equal(conditional.status,304);assert.equal(await conditional.text(),'');
  assert.equal((await fetch(base+'/api/intel/bootstrap?profile=unknown')).status,400);
  assert.equal((await fetch(base+'/api/intel/bootstrap?profile=dashboard-v1&limit=21')).status,400);
  const manifest=runtime.socketServer.sync.manifest();let cursor=0,downloadId,parts=[];
  do{
    const query=new URLSearchParams({resource:'market',epoch:manifest.epoch,revision:String(manifest.resources.market),cursor:String(cursor),profile:'dashboard-v1',...(downloadId?{downloadId}:{})});
    const page=await fetch(base+'/api/intel/sync?'+query,{headers:{'x-ogid-client':'test-client'}});assert.equal(page.status,200);const raw=await page.text();assert.ok(Buffer.byteLength(raw)<=65536);
    const data=JSON.parse(raw).data;downloadId=data.downloadId;parts.push(data.fragment);cursor=data.nextCursor;
    if(parts.length===1){state.market={...state.market,timeseries:{GD:[]}};runtime.socketServer.broadcast('update',{market:state.market});}
  }while(cursor!==null);
  assert.deepEqual(JSON.parse(parts.join('')),original);assert.equal(acquisition,0);
  const mismatch=runtime.socketServer.sync.page({resource:'market',epoch:manifest.epoch,revision:manifest.resources.market,profile:'dashboard-v1',downloadId,clientKey:'other'});assert.equal(mismatch.status,400);
  runtime.socketServer.sync.now=()=>Date.now()+61000;
  assert.equal(runtime.socketServer.sync.page({resource:'market',epoch:manifest.epoch,revision:manifest.resources.market,profile:'dashboard-v1',downloadId,clientKey:'test-client'}).code,'SYNC_DOWNLOAD_EXPIRED');
});
test('external database guard refuses missing or unwritable deployment volumes without fallback',()=>{
  assert.doesNotThrow(()=>assertStorageVolume('/tmp/fixture.sqlite',{mountpoint:()=>assert.fail()}));
  assert.throws(()=>assertStorageVolume('/srv/bitcoin/ogid/db/ogid.sqlite',{mountpoint:()=>{throw Error();}}),{code:'STORAGE_VOLUME_UNAVAILABLE'});
  assert.throws(()=>assertStorageVolume('/srv/bitcoin/ogid/db/ogid.sqlite',{mountpoint:()=>{},access:()=>{throw Error();}}),{code:'STORAGE_VOLUME_READ_ONLY'});
});
