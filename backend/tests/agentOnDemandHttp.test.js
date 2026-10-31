import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppServer} from '../server.js';
const model={alias:'fixture',state:'ready',context:8192,tools:true,structuredOutput:true,serverContextVerified:true,probe:{verifiedAt:'2026-10-31',wireNoFixedCap:true,streaming:true,cancellation:true}};
test('owned requests use writer lane; private results/evidence reject another device, anonymous and cross-origin callers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ogid-demand-http-'));const runtime=createAppServer({host:'127.0.0.1',port:0,disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(dir,'db.sqlite')},market:{enabled:false,provider:'',historyPersist:false},news:{providers:[],rssFeeds:[]},security:{allowLocalAdmin:false,adminApiToken:'fixture-admin'},agent:{mode:'shadow',manifest:{schemaVersion:'ogid-model-catalog-v1',defaultModel:'llamacpp/fixture',models:[model]},backgroundModel:'llamacpp/fixture'}});
 try{await runtime.start();const base='http://127.0.0.1:'+runtime.server.address().port;
 const enroll=async()=>{const r=await fetch(base+'/api/agent/v1/access/device',{method:'POST',headers:{Authorization:'Bearer fixture-admin','Content-Type':'application/json'},body:JSON.stringify({label:'fixture'})});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],data:(await r.json()).data};};
 const first=await enroll(),other=await enroll();const headers={Cookie:first.cookie,'x-ogid-csrf':first.data.csrf,'Content-Type':'application/json'};
 const sessionResponse=await fetch(base+'/api/agent/v1/chat/sessions',{method:'POST',headers,body:JSON.stringify({model:'llamacpp/fixture'})});assert.equal(sessionResponse.status,201);const session=(await sessionResponse.json()).data;
 const path='/api/agent/v1/chat/sessions/'+session.sessionId+'/requests';const input={key:'first',family:'brief',context:{view:'dashboard'}};
 assert.equal((await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,401);
 assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body:JSON.stringify(input)})).status,403);
 const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(r.status,202);const job=(await r.json()).data;
 assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,Cookie:other.cookie,'x-ogid-csrf':other.data.csrf},body:JSON.stringify(input)})).status,404);
 const call=runtime.app.locals.agentCall,auth={...await call('claim',{owner:'http'}),owner:'http'};assert.equal(auth.jobId,job.jobId);const snapshot=await call('snapshot',auth);
 const evidence='/api/agent/v1/evidence?snapshotId='+snapshot.snapshotId;
 assert.equal((await fetch(base+evidence)).status,401);assert.equal((await fetch(base+evidence,{headers:{Cookie:other.cookie}})).status,404);assert.equal((await fetch(base+evidence,{headers:{Cookie:first.cookie}})).status,200);
 assert.equal((await fetch(base+'/api/agent/v1/runs/'+job.jobId,{headers:{Cookie:other.cookie}})).status,404);
 await call('cancel',{...auth,internal:true});
 }finally{await runtime.stop();rmSync(dir,{force:true,recursive:true});}
});
