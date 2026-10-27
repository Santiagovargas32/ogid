import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { createInferenceBroker, InferenceQueue } from '../services/agent/broker.js';
import { createAgentInternalClient } from '../services/agent/internalClient.js';
import { IntelligenceWorker } from '../services/agent/worker.js';
import { ManagedAgentRuntime, prepareManagedAgentConfig } from '../services/agent/managedRuntime.js';
import { loadAgentConfig } from '../services/agent/config.js';
import { createAppServer } from '../server.js';
import { StorageManager } from '../storage/StorageManager.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AgentMaintenance } from '../services/agent/maintenance.js';
import { OpenCodeClient } from '../services/agent/opencodeClient.js';

const model = { alias: 'fixture', state: 'ready', context: 8192, tools: true, structuredOutput: true,
  serverContextVerified: true, probe: { verifiedAt: '2026-10-20', wireNoFixedCap: true, streaming: true, cancellation: true } };
const input = { model: 'fixture', messages: [{ role: 'user', content: 'fixture' }] };
async function brokerFixture(t, handler, policy = {}) {
  const upstream = createServer(handler);
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const queue = new InferenceQueue();
  const broker = createInferenceBroker({ upstream: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'fixture', token: 'fixture',
    manifest: { models: [model] }, queue, contextInspector: async () => ({}),
    policy: { headersMs: 80, idleMs: 80, totalMs: 1000, queueMs: 1000, ...policy } });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  t.after(async () => { broker.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => broker.close(r)), new Promise(r => upstream.close(r))]); });
  const request = (body = input) => fetch(`http://127.0.0.1:${broker.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(2000) });
  const health=async()=>{const r=await fetch(`http://127.0.0.1:${broker.address().port}/health`,{headers:{Authorization:'Bearer fixture'}});return r.json();};
  return { request, queue, health };
}
test('HTTP 200 model format errors and incomplete SSE release capacity and preserve the last failure after recovery',async t=>{
 let calls=0;
 const f=await brokerFixture(t,(_req,res)=>{
  calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
  if(calls===1)res.end('data: {"error":{"message":"The model produced output that does not match the expected peg-native format","status":200}}\n\n');
  else if(calls===2)res.end();
  else res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
 });
 for(const cause of ['LLAMACPP_OUTPUT_FORMAT','BROKER_INCOMPLETE_STREAM']){
  try{await(await f.request({...input,stream:true})).text();}catch{/* stream is deliberately terminated */}
  await wait(10);
  const state=(await f.health()).telemetry;
  assert.equal(state.lastFailure.causeCode,cause);assert.equal(state.active,null);assert.equal(f.queue.running,false);
  assert.equal(state.completed,0,'partial outputs never count as success');
 }
 await(await f.request({...input,stream:true})).text();
 const state=(await f.health()).telemetry;
 assert.equal(state.completed,1);assert.equal(state.failed,2);assert.equal(state.lastFailure.causeCode,'BROKER_INCOMPLETE_STREAM');assert.ok(state.lastSuccess);
 assert.ok(!JSON.stringify(state).includes('partial'));
});
test('broker releases the serial lane when upstream accepts but sends no headers', async t => {
  let calls = 0, closed = false;
  const f = await brokerFixture(t, (req, res) => {
    if (++calls === 1) { res.on('close', () => { closed = true; }); return; }
    res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
  });
  const first = await f.request(); assert.equal(first.status, 504);
  assert.equal((await first.json()).error.code, 'BROKER_HEADERS_TIMEOUT');
  assert.deepEqual(await (await f.request()).json(), { ok: true });
  await wait(20); assert.equal(closed, true); assert.equal(f.queue.running, false);
});
test('broker aborts a stream without progress and drains the following request', async t => {
  let calls = 0;
  const f = await brokerFixture(t, (_req, res) => {
    if (++calls === 1) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {}\n\n'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end('{}');
  });
  const first = await f.request({ ...input, stream: true });
  const started = performance.now();
  await assert.rejects(first.text());
  assert.ok(performance.now()-started < 1000, 'only the caller deadline stopped the stalled stream');
  assert.equal((await f.request()).status, 200); assert.equal(f.queue.running, false);
});
test('managed worker stays starting until a healthy control-plane report and diagnostics retain no private output', async t => {
  const directory=mkdtempSync(join(tmpdir(),'ogid-managed-readiness-'));
  const config=prepareManagedAgentConfig(loadAgentConfig({}, {mode:'shadow',backgroundModel:'llamacpp/fixture',manifest:{schemaVersion:'ogid-model-catalog-v1',models:[model]},managed:{worker:true,directory}}));
  const child=new EventEmitter();Object.assign(child,{pid:123456789,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
  const logs=[];const rt=new ManagedAgentRuntime({config,spawnImpl:()=>child,logger:{info:(...x)=>logs.push(x),warn:(...x)=>logs.push(x)}});
  rt.baseUrl='http://127.0.0.1:1';
  rt.signal=()=>{if(child.exitCode===null){child.exitCode=0;child.emit('exit',0,null);}};
  t.after(async()=>{await rt.stop();rmSync(directory,{recursive:true,force:true});});
  const launching=rt.launchComponent('worker');await wait(25);
  assert.equal(rt.status().components.worker.state,'starting');
  child.stderr.write('PRIVATE PROMPT Bearer private-secret AGENT_WORKER_UNAVAILABLE\n');
  for(let n=0;n<100;n++)child.stderr.write(n%2?'AGENT_TEST_A\n':'AGENT_TEST_B\n');
  child.emit('message',{type:'agent-worker-health',state:'connected'});await launching;
  assert.equal(rt.status().components.worker.state,'running');
  assert.ok(rt.status().components.worker.diagnostics.stderrBytes>0);
  assert.equal(JSON.stringify([logs,rt.status()]).includes('private-secret'),false);
  assert.equal(logs.filter(x=>x[0]==='agent_child_diagnostic').length,1);
  assert.ok(rt.status().components.worker.diagnostics.suppressedCodes>0);
  child.emit('message',{type:'agent-worker-health',state:'degraded',errorCode:'AGENT_WORKER_UNAVAILABLE'});
  assert.equal(rt.status().components.worker.state,'degraded');
  child.emit('message',{type:'agent-worker-health',state:'connected'});
  rt.components.worker.workerHealth.reportedAt=new Date(Date.now()-100000).toISOString();
  assert.equal(rt.status().components.worker.errorCode,'AGENT_WORKER_HEARTBEAT_STALE');
});

test('chat reads use the query reader, observe committed revocation, and claims pause when that reader fails', async t => {
  const directory=mkdtempSync(join(tmpdir(),'ogid-agent-read-lane-'));
  const storage=new StorageManager({enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite')});
  t.after(async()=>{await storage.close();rmSync(directory,{recursive:true,force:true});});
  await storage.start();
  const call=(method,args={})=>storage.request('agent.call',{method,args});
  const d=await call('deviceCreate',{}),session=await call('sessionCreate',{deviceId:d.deviceId,model:'llamacpp/fixture'});
  const sent=await call('send',{sessionId:session.sessionId,deviceId:d.deviceId,key:'fixture',text:'Fixture'});
  const writes=storage.getStatus().completed;
  const calls=[['deviceAuth',{token:d.token}],['sessionAccess',{sessionId:session.sessionId,deviceId:d.deviceId}],['messages',{sessionId:session.sessionId,deviceId:d.deviceId}],['run',{jobId:sent.jobId,internal:true}],['status',{}],['publications',{}]];
  for(const [method,args] of calls)await call(method,args);
  assert.equal(storage.getStatus().completed,writes);
  assert.equal(storage.queryManager.getStatus().readOnlyConnection,true);
  assert.equal(storage.queryManager.getStatus().queryOnly,true);
  await call('deviceRevoke',{deviceId:d.deviceId});
  assert.equal(await call('deviceAuth',{token:d.token}),null);
  await assert.rejects(call('sessionAccess',{sessionId:session.sessionId,deviceId:d.deviceId}),{code:'AGENT_SESSION_NOT_FOUND'});
  storage.queryManager.state='failed';
  try { await assert.rejects(call('claim',{owner:'fixture'}),{code:'STORAGE_QUERIES_UNAVAILABLE'}); }
  finally {storage.queryManager.state='ready';}
});

test('multiple SSE clients check lightweight authorization, close on revocation and release every interval', async t => {
  const directory=mkdtempSync(join(tmpdir(),'ogid-agent-sse-'));
  const runtime=createAppServer({port:0,host:'127.0.0.1',disableBackgroundRefresh:true,storage:{enabled:true,businessEnabled:true,databasePath:join(directory,'db.sqlite')},market:{provider:'',historyPersist:false},news:{providers:[],rssFeeds:[]},agent:{mode:'shadow',manifest:{schemaVersion:'ogid-model-catalog-v1',models:[model]}}});
  t.after(async()=>{await runtime.stop();rmSync(directory,{recursive:true,force:true});});
  await runtime.start();const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const call=runtime.app.locals.agentCall;
  const d=await call('deviceCreate'),s=await call('sessionCreate',{deviceId:d.deviceId,model:'llamacpp/fixture'});
  let histories=0,checks=0;
  runtime.app.locals.agentCall=(method,args)=>{if(method==='messages')histories++;if(method==='sessionAccess')checks++;return call(method,args);};
  const streams=await Promise.all(Array.from({length:4},()=>fetch(`${base}/api/agent/v1/chat/sessions/${s.sessionId}/events`,{headers:{Cookie:`ogid_device=${d.token}`},signal:AbortSignal.timeout(5000)})));
  const readers=streams.map(r=>r.body.getReader());for(const reader of readers)await reader.read();
  assert.equal(runtime.app.locals.agentSse.active,4);await wait(1100);assert.equal(histories,0);assert.ok(checks>=8);
  await call('deviceRevoke',{deviceId:d.deviceId});
  for(const reader of readers){while(!(await reader.read()).done){/* drain until revoked */}}
  assert.equal(runtime.app.locals.agentSse.active,0);assert.equal(runtime.app.locals.agentSse.closed,4);
  const stopped=checks;await wait(1100);assert.equal(checks,stopped);
});
test('broker returns client errors for malformed JSON and structures before upstream admission', async t => {
  let calls = 0;
  const f = await brokerFixture(t, (_req, res) => { calls++; res.end('{}'); });
  for (const body of ['{', 'null', '[]', '{}', { ...input, messages: null }, { ...input, tools: [null] }]) {
    const r = await f.request(body); assert.equal(r.status, 400); await r.body.cancel();
  }
  assert.equal(calls, 0);
});
test('broker rejects invalid upstream JSON before committing a successful response', async t => {
  const f = await brokerFixture(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('not-json'); });
  const r = await f.request(); assert.equal(r.status, 502); assert.equal((await r.json()).error.code, 'BROKER_INVALID_UPSTREAM');
});
test('queue deadline removes only the pending request without preempting valid active work',async t=>{
 let admitted=0;
 const f=await brokerFixture(t,()=>{admitted++;},{queueMs:30,headersMs:150});
 const active=f.request();await wait(30);
 const pending=await f.request();assert.equal(pending.status,504);assert.equal((await pending.json()).error.code,'BROKER_QUEUE_TIMEOUT');
 assert.equal(f.queue.running,true);assert.equal(f.queue.pending.length,0);assert.equal(admitted,1);
 assert.equal((await active).status,504);
});
test('total inference budget bounds an upstream that keeps sending progress forever',async t=>{
 const f=await brokerFixture(t,(_req,res)=>{
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {}\n\n');
  const timer=setInterval(()=>res.write('data: {}\n\n'),10);res.once('close',()=>clearInterval(timer));
 },{idleMs:80,totalMs:140});
 const r=await f.request({...input,stream:true}),start=performance.now();await assert.rejects(r.text());
 assert.ok(performance.now()-start<700);assert.equal(f.queue.running,false);
});
test('stream chunk budget does not cap accumulated response length',async t=>{
 const f=await brokerFixture(t,async(_req,res)=>{
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(let n=0;n<20;n++){res.write('x'.repeat(64));await wait(4);}res.end('\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
 },{maxChunkBytes:256});
 const r=await f.request({...input,stream:true});assert.ok((await r.text()).length>1280);
});
test('client disconnect aborts upstream and releases the active lane',async t=>{
 let closed=false;
 const f=await brokerFixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {}\n\n');res.once('close',()=>{closed=true;});});
 const r=await f.request({...input,stream:true});await r.body.cancel();
 for(let n=0;n<30 && !closed;n++)await wait(10);
 assert.equal(closed,true);assert.equal(f.queue.running,false);
});
test('internal client propagates caller cancellation without retrying a repeatable read', async () => {
  let calls = 0; const controller = new AbortController();
  const call = createAgentInternalClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', fetchImpl: async (_url, { signal }) => {
    calls++; await wait(1000, undefined, { signal }); return Response.json({ data: {} });
  } });
  const pending = call('run', {}, { signal: controller.signal }); controller.abort(new Error('stopped'));
  await assert.rejects(pending, /stopped/); assert.equal(calls, 1);
});
test('worker stop aborts an outstanding internal snapshot and releases the task', async () => {
  let entered; const started = new Promise(r => { entered = r; });
  let observedSignal;
  const worker = new IntelligenceWorker({ model: 'llamacpp/fixture', opencode: {}, call: async (method, _args, options) => {
    if (method === 'snapshot') { observedSignal = options?.signal; entered(); await wait(1000, undefined, { signal: observedSignal }); }
    return {};
  } });
  const task = worker.execute({ jobId: 'fixture', fence: 1, task: 'global_intelligence_brief', createdAt: new Date().toISOString() });
  await started; worker.stop(); await task; assert.equal(observedSignal?.aborted, true);
});
test('worker serializes heartbeats and aborts work immediately after lease loss', async () => {
  let active = 0, max = 0, beats = 0, aborted = false;
  const worker = new IntelligenceWorker({ model: 'llamacpp/fixture', opencode: {}, policy: { heartbeatMs: 10 }, call: async (method, _args, options) => {
    if (method === 'heartbeat') { beats++; max = Math.max(max, ++active); await wait(35); active--; throw Object.assign(Error('lost'), { code: 'AGENT_LEASE_LOST' }); }
    if (method === 'snapshot') { try { await wait(130, undefined, { signal: options?.signal }); } catch { aborted = true; throw options.signal.reason; } }
    return {};
  } });
  await worker.execute({ jobId: 'fixture', fence: 1, task: 'global_intelligence_brief', createdAt: new Date().toISOString() });
  assert.equal(max, 1); assert.equal(beats, 1); assert.equal(aborted, true);
});
test('a rejected progress cleanup cannot reject an unobserved worker task', async () => {
  const worker = new IntelligenceWorker({ model: 'llamacpp/fixture', opencode: {}, call: async method => {
    if (method === 'snapshot') throw Object.assign(Error('fixture'), { code: 'AGENT_LEASE_LOST' }); return {};
  }, onProgress: async () => { throw Error('progress unavailable'); } });
  await assert.doesNotReject(worker.execute({ jobId: 'fixture', fence: 1, createdAt: new Date().toISOString() }));
  assert.equal(worker.lastProgressErrorCode, 'AGENT_PROGRESS_UNAVAILABLE');
});
test('maintenance retains previous domain success when a later sweep fails',async()=>{
  let fail=false,now=Date.now();
  const m=new AgentMaintenance({enabled:true,now:()=>now,call:async()=>{},business:{advanced:{getSnapshot:async()=>{if(fail)throw Error('cold');}},conditions:{getSnapshot:async()=>{}},forecasts:{evaluate:async()=>{}}}});
  await m.tick();const success=m.status.domains.advanced.lastSuccessAt;
  fail=true;now+=60000;await m.tick();assert.equal(m.status.state,'degraded');assert.equal(m.status.domains.advanced.lastSuccessAt,success);
});
test('deterministic maintenance drains its durable backlog even when legacy input revisions stay unchanged',async()=>{
 let calls=0,advanced=0;
 const m=new AgentMaintenance({enabled:true,dependencies:async()=>({news:{revision:1},awareness:0,research:0,candles:{}}),call:async()=>({hasMore:++calls<3,durationMs:5,processed:100}),business:{advanced:{getSnapshot:async()=>{advanced++;}},conditions:{getSnapshot:async()=>{}},forecasts:{evaluate:async()=>{}}}});
 for(let n=0;n<4;n++)await m.tick();assert.equal(calls,3);assert.equal(advanced,1);assert.equal(m.status.domains.alerts.hasMore,false);await m.stop();
});
test('maintenance stop does not report a partial sweep as a new success',async()=>{
  let release,entered;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  const m=new AgentMaintenance({enabled:true,call:async()=>{entered();await gate;},business:{advanced:{getSnapshot:async()=>assert.fail('stopped sweep continued')},conditions:{getSnapshot:async()=>{}},forecasts:{evaluate:async()=>{}}}});
  const tick=m.tick();await started;const stopped=m.stop();release();await Promise.all([tick,stopped]);
  assert.equal(m.status.state,'stopped');assert.equal(m.status.lastSuccessAt,null);
});
test('a manual maintenance sweep replaces the pending timer instead of starting another timer chain',async(t)=>{
 const clear=t.mock.method(globalThis,'clearTimeout');
 const m=new AgentMaintenance({enabled:true,call:async()=>({hasMore:false}),business:{advanced:{getSnapshot:async()=>{}},conditions:{getSnapshot:async()=>{}},forecasts:{evaluate:async()=>{}}}});
 try{
  m.start();await m.task;const previous=m.timer;assert.ok(previous);
  await m.tick();assert.notEqual(m.timer,previous);assert.ok(clear.mock.calls.some(c=>c.arguments[0]===previous));
 }finally{await m.stop();}
});
test('durable alert pages continue while a slow analytical sweep is still running',async()=>{
 let release,entered,calls=0,analytical=0;
 const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 const m=new AgentMaintenance({enabled:true,call:async()=>({hasMore:++calls<3,durationMs:1,processed:100}),business:{advanced:{getSnapshot:async()=>{analytical++;entered();await gate;}},conditions:{getSnapshot:async()=>{}},forecasts:{evaluate:async()=>{}}}});
 const first=m.tick();await started;await wait(5);const second=m.tick();
 try{await wait(50);assert.equal(calls,2,'a pending analytical read must not hold the durable consumer');assert.equal(analytical,1,'analytical sweeps must not overlap');}
 finally{release();await Promise.all([first,second]);await m.stop();}
});
test('rapid input changes are coalesced without regenerating the analytical corpus on every control tick',async()=>{
 let now=0,revision=1,analytical=0;
 const m=new AgentMaintenance({enabled:true,now:()=>now,dependencies:async()=>({news:{revision},candles:{}}),call:async()=>({hasMore:false}),business:{advanced:{getSnapshot:async()=>{analytical++;}},conditions:{getSnapshot:async()=>{}},forecasts:{evaluate:async()=>{}}}});
 try{
  await m.tick();for(let n=0;n<5;n++){revision++;now+=100;await m.tick();}assert.equal(analytical,1);
  now=60000;await m.tick();assert.equal(analytical,2);
 }finally{await m.stop();}
});
test('stopping maintenance drains its accepted analytical operation and starts no later domains',async()=>{
 let release,entered,conditions=0;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 const m=new AgentMaintenance({enabled:true,call:async()=>({hasMore:false}),business:{advanced:{getSnapshot:async()=>{entered();await gate;}},conditions:{getSnapshot:async()=>{conditions++;}},forecasts:{evaluate:async()=>{}}}});
 const first=m.tick();await started;let finished=false;const stopped=m.stop().then(()=>{finished=true;});
 try{await wait(5);assert.equal(finished,false);}finally{release();await Promise.all([first,stopped]);}
 assert.equal(conditions,0);assert.equal(m.status.state,'stopped');assert.equal(m.timer,null);
});
test('OpenCode rejects and cancels error bodies without reading private upstream text',async()=>{
 let cancelled=false;
 const client=new OpenCodeClient({password:'fixture',fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:503})});
 await assert.rejects(client.session('fixture'),{code:'OPENCODE_HTTP_503'});assert.equal(cancelled,true);
 const invalid=new OpenCodeClient({password:'fixture',fetchImpl:async()=>new Response('private-invalid-json')});
 await assert.rejects(invalid.session('fixture'),e=>e.code==='OPENCODE_INVALID_RESPONSE' && !e.message.includes('private'));
});
