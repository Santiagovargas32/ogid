import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {ResourceAdmission} from '../storage/resourceAdmission.js';
import {StorageManager} from '../storage/StorageManager.js';
import {createAppServer} from '../server.js';

test('owned cancellation and SSE authorization retain control capacity under critical pressure without bypassing ownership, CSRF or payload admission',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-auth-control-')),gate=new ResourceAdmission({enabled:true});
 gate.observe({availableBytes:8*1024**3,memoryFull:0,ioFull:0});
 const storage=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite'),pressure:gate});
 const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storageManager:storage,market:{provider:'',historyPersist:false,historyDir:directory},news:{providers:[],rssFeeds:[]},agent:{mode:'off',publicOrigin:null}});
 try{
  await runtime.start();const call=runtime.app.locals.agentCall;
  const device=await call('deviceCreate'),other=await call('deviceCreate'),revoked=await call('deviceCreate');
  const session=await call('sessionCreate',{deviceId:device.deviceId,model:'llamacpp/fixture'});
  const queued=await call('send',{sessionId:session.sessionId,deviceId:device.deviceId,key:'cancel-control',text:'Explicit fixture; no inference',context:[]});
  await call('deviceRevoke',{deviceId:revoked.deviceId});
  gate.acquire('long-analysis');gate.observe({availableBytes:8*1024**3,memoryFull:0,ioFull:99});
  const base='http://127.0.0.1:'+runtime.server.address().port;
  const request=(d,path,{method='POST',csrf=d.csrf}={})=>fetch(base+path,{method,headers:{Cookie:'ogid_device='+d.token,'x-ogid-csrf':csrf,'Content-Type':'application/json',Origin:base},...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(5000)});
  const cancel='/api/agent/v1/runs/'+queued.jobId+'/cancel';
  const response=await request(device,cancel);assert.equal(response.status,200);await response.body.cancel();
  assert.equal((await call('runControl',{jobId:queued.jobId})).status,'cancelled');
  for(const [d,options,status,code]of [[device,{csrf:'invalid'},403,'AGENT_CSRF_REQUIRED'],[other,{},404,'AGENT_SESSION_NOT_FOUND'],[revoked,{},401,'AGENT_DEVICE_REQUIRED']]){
   const r=await request(d,cancel,options);assert.equal(r.status,status);assert.equal((await r.json()).error.code,code);
  }
  const full=await request(device,'/api/agent/v1/runs/'+queued.jobId,{method:'GET'});assert.equal(full.status,503);assert.equal((await full.json()).error.code,'STORAGE_RESOURCE_PRESSURE');
  const denied=await request(other,'/api/agent/v1/chat/sessions/'+session.sessionId+'/events',{method:'GET'});assert.equal(denied.status,404);await denied.body.cancel();
  const sse=await request(device,'/api/agent/v1/chat/sessions/'+session.sessionId+'/events',{method:'GET'});assert.equal(sse.status,200);
  const reader=sse.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/reconcile/);await reader.cancel();
  const deadline=performance.now()+1000;while(runtime.app.locals.agentSse.active&&performance.now()<deadline)await wait(10);
  assert.equal(runtime.app.locals.agentSse.active,0);assert.equal(gate.owner,'long-analysis');
 }finally{gate.release('long-analysis');await runtime.stop();rmSync(directory,{recursive:true,force:true});}
});
