import test from 'node:test';
import assert from 'node:assert/strict';
import { SectionRefresh } from '../../frontend/js/adminRefresh.js';
import { setTimeout as delay } from 'node:timers/promises';
test('Admin renders while RSS is pending; retains old values, guards overlap and aborts teardown', async () => {
 const rendered=[], statuses=[];const sections=new SectionRefresh({onStatus:(...a)=>statuses.push(a)});
 await sections.refresh([{key:'rss',load:async()=>({items:['old']}),render:v=>rendered.push(v)}]);
 let calls=0,aborted=false;
 const defs=[{key:'health',load:async()=>{calls++;return {ok:true};},render:v=>rendered.push(v)},{key:'rss',load:signal=>new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),30);signal.addEventListener('abort',()=>{clearTimeout(timer);aborted=true;reject(Error('cancelled'));});}),render:()=>assert.fail()}];
 const pending=sections.refresh(defs);assert.equal(sections.refresh(defs),pending);await delay(5);assert.equal(calls,1);assert.equal(rendered.at(-1).ok,true);
 await pending;assert.equal(sections.values.get('rss').items[0],'old');assert.ok(statuses.some(([k,s])=>k==='rss'&&s==='stale'));
 const stopped=sections.refresh(defs);sections.stop();await stopped;assert.equal(aborted,true);
});
test('request bounds body, supports cancellation, auth errors and Retry-After dates', async () => {
 globalThis.window={location:{origin:'http://localhost'},addEventListener(){}};
 const {request}=await import('../../frontend/js/api.js');const original=globalThis.fetch;
 try {
 globalThis.fetch=async(_url,{signal})=>({ok:true,status:200,json:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)))});
 const keepAlive=delay(50);await assert.rejects(request('/test',{}, {timeoutMs:15}),{code:'REQUEST_TIMEOUT'});await keepAlive;
 const controller=new AbortController();const pending=request('/test',{}, {signal:controller.signal});await delay(1);controller.abort();await assert.rejects(pending,{code:'REQUEST_CANCELLED'});
 globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'ADMIN_AUTH_REQUIRED'}}),{status:401,headers:{'Retry-After':new Date(Date.now()+10000).toUTCString()}});
 await assert.rejects(request('/test'),e=>e.status===401&&e.code==='ADMIN_AUTH_REQUIRED'&&e.retryAfterSec>0&&/autorizado/.test(e.message));
 }finally{globalThis.fetch=original;delete globalThis.window;}
});
test('conditional browser reads retain the previous representation and never parse an empty 304',async()=>{
 globalThis.window={location:{origin:'http://localhost'},addEventListener(){}};
 const {request}=await import('../../frontend/js/api.js'),original=globalThis.fetch;
 let calls=0;
 try{
  globalThis.fetch=async(_url,options)=>{
   calls++;
   if(calls===1)return Response.json({ok:true,data:{revision:1,items:['retained']}},{headers:{ETag:'W/"fixture"'}});
   assert.equal(options.headers['If-None-Match'],'W/"fixture"');
   return {status:304,ok:false,headers:new Headers(),json:()=>assert.fail('304 body must not be parsed')};
  };
  const first=await request('/conditional-fixture',{}, {revalidate:true});
  const cached=await request('/conditional-fixture',{}, {revalidate:true});
  assert.equal(cached,first);assert.deepEqual(cached.items,['retained']);assert.equal(calls,2);
 }finally{globalThis.fetch=original;delete globalThis.window;}
});
