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

test('conversation pages and small admissions do not wait for analytical heavy work; critical pressure still defers generation requests',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-conversation-admission-')),gate=new ResourceAdmission({enabled:true});
 gate.observe({availableBytes:8*1024**3,memoryFull:0,ioFull:0});
 const storage=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite'),pressure:gate});
 const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storageManager:storage,market:{provider:'',historyPersist:false,historyDir:directory},news:{providers:[],rssFeeds:[]},agent:{mode:'off'}});
 try{
  await runtime.start();const call=runtime.app.locals.agentCall,device=await call('deviceCreate'),other=await call('deviceCreate');
  const config=runtime.app.locals.agentConfig;config.mode='shadow';config.taskModes.global_intelligence_brief='shadow';config.manifest.models.push({alias:'fixture',state:'available',context:8192});
  const session=await call('sessionCreate',{deviceId:device.deviceId,model:'llamacpp/fixture'});
  gate.acquire('held-calculation');
  const base='http://127.0.0.1:'+runtime.server.address().port;
  const request=(path,{method='GET',body,who=device,csrf=who.csrf}={})=>fetch(base+path,{method,headers:{Cookie:'ogid_device='+who.token,'x-ogid-csrf':csrf,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(2000)});
  const list=await request('/api/agent/v1/chat/sessions?limit=20');assert.equal(list.status,200);assert.equal((await list.json()).data.items[0].sessionId,session.sessionId);
  const created=await request('/api/agent/v1/chat/sessions',{method:'POST',body:{model:'llamacpp/fixture',title:'explicit session'}});assert.equal(created.status,201);await created.body.cancel();
  const path='/api/agent/v1/chat/sessions/'+session.sessionId;
  const admitted=await request(path+'/requests',{method:'POST',body:{family:'brief',key:'bounded',context:{view:'dashboard'}}});assert.equal(admitted.status,202);const job=(await admitted.json()).data;
  const messages=await request(path+'/messages?limit=40&latest=1');assert.equal(messages.status,200);assert.equal((await messages.json()).data.activeRun.jobId,job.jobId);
  const replay=await request(path+'/requests',{method:'POST',body:{family:'brief',key:'bounded',context:{view:'dashboard'}}});assert.equal((await replay.json()).data.jobId,job.jobId);
  const denied=await request(path+'/messages',{who:other});assert.equal(denied.status,404);await denied.body.cancel();
  const csrf=await request('/api/agent/v1/chat/sessions',{method:'POST',csrf:'invalid',body:{model:'llamacpp/fixture'}});assert.equal(csrf.status,403);await csrf.body.cancel();
  gate.observe({availableBytes:8*1024**3,memoryFull:0,ioFull:99});
  const history=await request(path+'/messages');assert.equal(history.status,200);await history.body.cancel();
  const deferred=await request(path+'/requests',{method:'POST',body:{family:'brief',key:'critical',context:{view:'dashboard'}}});assert.equal(deferred.status,503);assert.equal((await deferred.json()).error.code,'STORAGE_RESOURCE_PRESSURE');
  const full=await request('/api/agent/v1/runs/'+job.jobId);assert.equal(full.status,503);await full.body.cancel();
  assert.equal(gate.owner,'held-calculation');
 }finally{gate.release('held-calculation');await runtime.stop();rmSync(directory,{recursive:true,force:true});}
});

test('shutdown ends an owned SSE stream and rejects a stream whose authorization was already in flight',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-sse-stop-'));
 const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite')},market:{provider:'',historyPersist:false,historyDir:directory},news:{providers:[],rssFeeds:[]},agent:{mode:'off'}});
 let reader,release,stop;
 try{
  await runtime.start();const call=runtime.app.locals.agentCall,device=await call('deviceCreate');
  const first=await call('sessionCreate',{deviceId:device.deviceId,model:'llamacpp/fixture'}),second=await call('sessionCreate',{deviceId:device.deviceId,model:'llamacpp/fixture'});
  const base='http://127.0.0.1:'+runtime.server.address().port,headers={Cookie:'ogid_device='+device.token};
  const response=await fetch(base+'/api/agent/v1/chat/sessions/'+first.sessionId+'/events',{headers,signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/reconcile/);
  let entered;const waiting=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  runtime.app.locals.agentCall=async(method,args)=>{if(method==='sessionAccess'&&args.sessionId===second.sessionId){entered();await blocked;}return call(method,args);};
  const opening=fetch(base+'/api/agent/v1/chat/sessions/'+second.sessionId+'/events',{headers,signal:AbortSignal.timeout(5000)});
  await waiting;stop=runtime.stop();release();
  const denied=await opening;assert.equal(denied.status,503);assert.equal((await denied.json()).error.code,'AGENT_SHUTTING_DOWN');
  assert.equal((await reader.read()).done,true);await stop;
  assert.equal(runtime.app.locals.agentSse.active,0);assert.equal(runtime.app.locals.agentSse.closed,1);assert.equal(runtime.app.locals.agentSseConnections.size,0);
  assert.deepEqual(runtime.app.locals.shutdownReport.unconfirmedPersistence,[]);assert.deepEqual(runtime.app.locals.shutdownReport.cleanupErrors,[]);
 }finally{release?.();await reader?.cancel().catch(()=>{});await(stop||runtime.stop());rmSync(directory,{recursive:true,force:true});}
});
