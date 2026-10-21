import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeSocket } from '../../frontend/js/websocket.js';
import { SmartPollLoop } from '../../frontend/js/smartPollLoop.js';

class FakeSocket {
  static OPEN=1;
  static instances=[];
  constructor(url){this.url=url;this.readyState=0;this.listeners=new Map();FakeSocket.instances.push(this);}
  addEventListener(name,listener){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(listener);}
  emit(name,event={}){for(const listener of this.listeners.get(name)||[])listener(event);}
  close(){this.readyState=3;this.emit('close',{code:1000,reason:'client',wasClean:true});}
}
function browser(t){
  const window=new EventTarget(); window.location={protocol:'http:',host:'ogid.local:3000'};
  const document=new EventTarget();document.hidden=false;
  const previous={window:globalThis.window,document:globalThis.document,WebSocket:globalThis.WebSocket};
  Object.assign(globalThis,{window,document,WebSocket:FakeSocket});FakeSocket.instances=[];
  t.after(()=>Object.assign(globalThis,previous));
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(Math,'random',()=>.5);
}

test('reconnect backs off after short-lived opens, resyncs once and cleans timers',t=>{
  browser(t);const messages=[],states=[];
  const realtime=new RealtimeSocket({onMessage:message=>messages.push(message),onStatusChange:(status,diagnostics)=>states.push([status,diagnostics])});
  realtime.connect();realtime.connect();
  assert.equal(FakeSocket.instances.length,1);
  assert.equal(realtime.socket.url,'ws://ogid.local:3000/ws');
  for(let i=0;i<5;i++){
    const socket=realtime.socket;socket.readyState=1;socket.emit('open');
    socket.emit('message',{data:JSON.stringify({type:'snapshot',data:{revision:i}})});
    socket.readyState=3;socket.emit('close',{code:1013,reason:'resync-required',wasClean:true});
    const delay=Math.round(Math.min(750*2**i,15_000)*.75);
    t.mock.timers.tick(delay-1);assert.equal(realtime.socket,socket);
    t.mock.timers.tick(1);assert.notEqual(realtime.socket,socket);
    socket.emit('close',{code:1006}); // stale listeners cannot schedule another reconnect
  }
  assert.equal(messages.length,5);
  assert.equal(realtime.reconnectAttempts,5);
  assert.equal(states.find(([,d])=>d?.code===1013)[1].reason,'resync-required');
  realtime.close();const count=FakeSocket.instances.length;
  t.mock.timers.tick(120_000);assert.equal(FakeSocket.instances.length,count);
});

test('stable connection resets retries; HTTPS uses wss; policy close uses HTTP fallback',t=>{
  browser(t);window.location.protocol='https:';
  const statuses=[];const realtime=new RealtimeSocket({onStatusChange:status=>statuses.push(status)});
  realtime.reconnectAttempts=8;realtime.connect();
  assert.equal(realtime.socket.url,'wss://ogid.local:3000/ws');
  realtime.socket.readyState=1;realtime.socket.emit('open');
  t.mock.timers.tick(30_000);assert.equal(realtime.reconnectAttempts,0);
  realtime.socket.readyState=3;realtime.socket.emit('close',{code:1008,reason:'policy'});
  t.mock.timers.tick(120_000);assert.equal(FakeSocket.instances.length,1);
  assert.equal(statuses.at(-1),'error');realtime.close();
});

test('polling stop and restart cannot publish a cancelled response or overlap tasks',async t=>{
  browser(t);let release,calls=0;const data=[];
  const pending=new Promise(resolve=>{release=resolve;});
  const loop=new SmartPollLoop({task:async()=>{calls++;return calls===1?pending:'fresh';},onData:value=>data.push(value)});
  loop.start();loop.start();loop.stop();loop.start();
  assert.equal(calls,1);
  release('obsolete');await pending;await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(data,[]);
  t.mock.timers.tick(60_000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);assert.deepEqual(data,['fresh']);
  loop.stop();
});

test('pagehide/pageshow restores one connection and one poller without duplicate listeners',async t=>{
 browser(t);let calls=0;
 const realtime=new RealtimeSocket({});const loop=new SmartPollLoop({task:async()=>++calls});
 realtime.connect();loop.start();await new Promise(resolve=>setImmediate(resolve));
 const old=realtime.socket;old.readyState=1;old.emit('open');
 window.dispatchEvent(new Event('pagehide'));assert.equal(loop.stopped,true);assert.equal(old.readyState,3);
 const show=new Event('pageshow');Object.defineProperty(show,'persisted',{value:true});window.dispatchEvent(show);window.dispatchEvent(show);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(FakeSocket.instances.length,2);assert.equal(calls,2);
 loop.stop();realtime.close();window.dispatchEvent(show);assert.equal(FakeSocket.instances.length,2);
});

test('an OPEN socket without application traffic recovers and hidden tabs get a grace period',t=>{
 browser(t);let now=0;const statuses=[];
 const realtime=new RealtimeSocket({now:()=>now,staleMs:60000,onStatusChange:state=>statuses.push(state)});
 realtime.connect();realtime.socket.readyState=1;realtime.socket.emit('open');
 document.hidden=true;now=60000;t.mock.timers.tick(60000);assert.equal(statuses.at(-1),'connected');
 document.hidden=false;now=120000;t.mock.timers.tick(60000);assert.equal(statuses.at(-1),'reconnecting');
 assert.equal(realtime.lastClose.reason,'application-heartbeat-stalled');
 t.mock.timers.tick(1000);assert.equal(FakeSocket.instances.length,2);realtime.close();
});

test('API creates a new page cancellation scope after bfcache restoration',async t=>{
 browser(t);window.location.origin='http://ogid.local:3000';
 const original=globalThis.fetch;const signals=[];
 globalThis.fetch=async(_path,options)=>{signals.push(options.signal);options.signal.throwIfAborted();return Response.json({data:{ok:true}});};
 t.after(()=>{globalThis.fetch=original;});
 const {request}=await import('../../frontend/js/api.js?processing-lifecycle');
 await request('/fixture');window.dispatchEvent(new Event('pagehide'));assert.equal(signals[0].aborted,true);
 const show=new Event('pageshow');Object.defineProperty(show,'persisted',{value:true});window.dispatchEvent(show);
 assert.deepEqual(await request('/fixture'),{ok:true});assert.equal(signals[1].aborted,false);
});
