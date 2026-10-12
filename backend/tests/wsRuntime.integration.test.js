import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createSocketServer, validateWebSocketUpgradeOrigin } from '../websocket/socketServer.js';

async function fixture(t,options={}){
  const server=http.createServer((_req,res)=>res.end('ok'));
  const socketServer=createSocketServer({server,stateManager:{getSnapshot:()=>({meta:{},market:{quotes:{}}})},heartbeatMs:50,...options});
  server.listen(0,'0.0.0.0');await once(server,'listening');
  t.after(async()=>{await socketServer.close();await new Promise(resolve=>server.close(resolve));});
  return {server,socketServer,port:server.address().port};
}
async function connect(url,options={}){
  const socket=new WebSocket(url,options);await once(socket,'open');return socket;
}
async function close(socket){if(socket.readyState===WebSocket.CLOSED)return;const closed=once(socket,'close');socket.close(1000,'test-complete');await closed;}
async function rejected(url,options){
  const socket=new WebSocket(url,options);socket.on('error',()=>{});
  const [_req,response]=await once(socket,'unexpected-response');response.resume();socket.terminate();return response.statusCode;
}

test('origin policy validates LAN IP, .local, explicit local aliases and trusted proxy only',()=>{
  const req=(host,origin,remoteAddress='192.168.1.20',extra={})=>({headers:{host,origin,...extra},socket:{remoteAddress}});
  for(const host of ['192.168.1.10:3000','ogid.local:3000']){
    assert.equal(validateWebSocketUpgradeOrigin(req(host,`http://${host}`)).allowed,true);
    assert.equal(validateWebSocketUpgradeOrigin(req(host,'http://evil.example')).allowed,false);
  }
  assert.equal(validateWebSocketUpgradeOrigin(req('ogid.local:3000','http://ogid.local:3000','127.0.0.1'),{allowedOrigins:['http://ogid.local:3000']}).allowed,true);
  const proxy=req('127.0.0.1:3000','https://ogid.example','127.0.0.1',{'x-forwarded-host':'ogid.example','x-forwarded-proto':'https'});
  assert.equal(validateWebSocketUpgradeOrigin(proxy).allowed,false);
  assert.equal(validateWebSocketUpgradeOrigin(proxy,{trustedProxyIps:['127.0.0.1']}).allowed,true);
  proxy.headers['x-forwarded-proto']='https,http';
  assert.equal(validateWebSocketUpgradeOrigin(proxy,{trustedProxyIps:['127.0.0.1']}).allowed,false);
  proxy.headers={'host':'127.0.0.1:3000',origin:'https://ogid.example',forwarded:'for=192.168.1.20;proto=https;host="ogid.example"'};
  assert.equal(validateWebSocketUpgradeOrigin(proxy,{trustedProxyIps:['127.0.0.1']}).allowed,true);
});

test('real loopback handshake rejects invalid Origin and validates hostname/proxy headers',async t=>{
  const {port,socketServer}=await fixture(t,{trustedProxyIps:['127.0.0.1'],allowedOrigins:['http://ogid.local:3000']});
  const url=`ws://127.0.0.1:${port}/ws`;
  assert.equal(await rejected(url,{origin:'http://invalid.example'}),403);
  const alias=await connect(url,{origin:'http://ogid.local:3000',headers:{host:'ogid.local:3000'}});
  const proxy=await connect(url,{origin:'https://ogid.example',headers:{'x-forwarded-host':'ogid.example','x-forwarded-proto':'https'}});
  assert.equal(socketServer.clientCount(),2);
  await Promise.all([close(alias),close(proxy)]);
  assert.equal(socketServer.getHealth().metrics.upgradeRejected,1);
});

test('LAN interface on same host accepts HTTP and WS',async t=>{
  const address=Object.values(networkInterfaces()).flat().find(ip=>ip.family==='IPv4'&&!ip.internal)?.address;
  if(!address){t.skip('no non-loopback interface; physical LAN validation remains pending');return;}
  const {port}=await fixture(t);const origin=`http://${address}:${port}`;
  // testSetup forbids external HTTP; this is deliberately a local LAN socket.
  const status=await new Promise((resolve,reject)=>http.get(origin,res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
  assert.equal(status,200);
  const socket=await connect(`ws://${address}:${port}/ws`,{origin});await close(socket);
});

test('heartbeat tolerates one missed pong and closes a silent client with observable reason',async t=>{
  const {port,socketServer}=await fixture(t);
  const socket=await connect(`ws://127.0.0.1:${port}/ws`,{autoPong:false});
  const [code,reason]=await once(socket,'close');
  assert.equal(code,1001);assert.equal(reason.toString(),'heartbeat-timeout');
  assert.equal(socketServer.getHealth().metrics.heartbeatTimeouts,1);
  await socketServer.close(); // wait for the server-side close event as well
  assert.equal(socketServer.getHealth().recentEvents.filter(e=>e.type==='disconnect').length,1);
});

test('a budget smaller than the recovery manifest closes cleanly without recursive sends', async t => {
  const {port, socketServer} = await fixture(t, {transportLimits: {maxMessageBytes: 32}});
  const socket = await connect(`ws://127.0.0.1:${port}/ws`);
  const [code, reason] = await once(socket, 'close');
  assert.equal(code, 1013); assert.equal(reason.toString(), 'resync-required');
  await socketServer.close(); // The client close can precede the server close callback.
  const health = socketServer.getHealth();
  assert.equal(health.metrics.dropped, 2);
  assert.equal(health.lastDisconnection.requestedCloseCode, 1013);
  assert.equal(health.lastDisconnection.anomalous, false);
  assert.equal(health.lastDisconnection.closeFrameSent, true);
  assert.equal(health.lastDisconnection.closeFrameReceived, true);
});

test('ten simultaneous clients and repeated reconnects retain one upgrade handler',async t=>{
  const {server,port,socketServer}=await fixture(t);
  const sockets=await Promise.all(Array.from({length:10},()=>connect(`ws://127.0.0.1:${port}/ws`)));
  await delay(200);assert.equal(socketServer.clientCount(),10);assert.equal(socketServer.getHealth().metrics.heartbeatTimeouts,0);
  for(let round=0;round<5;round++){
    await close(sockets[0]);sockets[0]=await connect(`ws://127.0.0.1:${port}/ws`);
    assert.equal(server.listenerCount('upgrade'),1);assert.equal(socketServer.clientCount(),10);
  }
  await Promise.all(sockets.map(close));await socketServer.close();
  assert.equal(server.listenerCount('upgrade'),0);
});

test('saturated TCP client is isolated while healthy peer receives updates',async t=>{
  const {port,socketServer}=await fixture(t,{heartbeatMs:10_000});
  const slow=await connect(`ws://127.0.0.1:${port}/ws`);
  const fast=await connect(`ws://127.0.0.1:${port}/ws`);
  let fastUpdates=0;fast.on('message',raw=>{if(JSON.parse(raw).type==='fixture')fastUpdates++;});
  slow._socket.pause();
  const slowClosed=once(slow,'close');
  for(let i=0;i<500&&!socketServer.getHealth().metrics.dropped;i++){
    socketServer.broadcast('fixture',{payload:'x'.repeat(32_000)});
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.ok(socketServer.getHealth().metrics.dropped>0,'must reach real bufferedAmount limit');
  slow._socket.resume();
  const [code,reason]=await slowClosed;assert.equal(code,1013);assert.equal(reason.toString(),'resync-required');
  await delay(20);assert.ok(fastUpdates>0);assert.equal(fast.readyState,WebSocket.OPEN);
  await close(fast);
});
