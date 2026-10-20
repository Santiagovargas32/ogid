// Bounded read-only HTTP/WS observation against an already running local OGID.
import WebSocket from 'ws';
import {writeFileSync,readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {setTimeout as wait} from 'node:timers/promises';
import dotenv from 'dotenv';
const [base='http://127.0.0.1:3000',output,secondsText='1200']=process.argv.slice(2),seconds=Number(secondsText),url=new URL(base);
if(!output||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!Number.isFinite(seconds)||seconds<10||seconds>86400)throw Error('Usage: agent-live-probe http://127.0.0.1:PORT report.json [seconds=1200]');
const env={...dotenv.parse(readFileSync(new URL('../.env',import.meta.url))),...process.env};
const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
const report={startedAt:new Date().toISOString(),requestedSeconds:seconds,clients:10,slowClientPauseMs:5000,opened:0,unexpectedCloses:0,wsErrors:0,messages:0,bytes:0,http:{},state:'observing'};
const clients=[],timers=[],started=performance.now();let closing=false;
const percentile=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return a.length?a[Math.min(a.length-1,Math.ceil(a.length*p)-1)]:null;};
try{
 for(let i=0;i<10;i++){
  const ws=new WebSocket(new URL(env.WS_PATH||'/ws',base).href.replace(/^http/,'ws'));clients.push(ws);
  ws.on('open',()=>{report.opened++;if(i===9)timers.push(setInterval(()=>{ws._socket?.pause();const timer=setTimeout(()=>ws._socket?.resume(),5000);timers.push(timer);},20000));});
  ws.on('message',data=>{report.messages++;report.bytes+=data.length;});
  ws.on('close',code=>{if(!closing){report.unexpectedCloses++;report.lastUnexpectedCloseCode=code;}});
  ws.on('error',()=>{report.wsErrors++;});
 }
 while(!stop.signal.aborted && performance.now()-started<seconds*1000){
  for(const path of ['/api/health/ready','/api/admin/agent','/api/intel/news?limit=40&countries=ALL']){
   const metric=report.http[path]??={samples:[],statuses:{},errors:0,bytes:0};const begin=performance.now();
   try{const r=await fetch(new URL(path,base),{headers:env.ADMIN_API_TOKEN?{Authorization:`Bearer ${env.ADMIN_API_TOKEN}`}:{},redirect:'error',signal:AbortSignal.timeout(12000)});for await(const chunk of r.body)metric.bytes+=chunk.length;metric.statuses[r.status]=(metric.statuses[r.status]||0)+1;metric.samples.push(performance.now()-begin);if(r.status===404){report.invalidEndpoint=path;stop.abort();}}catch{metric.errors++;}
  }
  await wait(Math.min(10000,Math.max(1,seconds*1000-(performance.now()-started))),undefined,{signal:stop.signal}).catch(()=>{});
 }
 report.state=report.invalidEndpoint?'invalid-endpoint':stop.signal.aborted?'interrupted':'completed';if(report.invalidEndpoint)process.exitCode=1;
}finally{
 closing=true;for(const timer of timers){clearInterval(timer);clearTimeout(timer);}
 for(const ws of clients){ws._socket?.resume();if(ws.readyState===WebSocket.OPEN)ws.close(1000,'observation-complete');else if(ws.readyState===WebSocket.CONNECTING)ws.terminate();}
 await wait(1500);for(const ws of clients)if(ws.readyState!==WebSocket.CLOSED)ws.terminate();
 report.elapsedMs=Math.round(performance.now()-started);report.finishedAt=new Date().toISOString();
 report.http=Object.fromEntries(Object.entries(report.http).map(([k,m])=>[k,{requests:m.samples.length,errors:m.errors,statuses:m.statuses,bytes:m.bytes,p50Ms:percentile(m.samples,.5),p95Ms:percentile(m.samples,.95),p99Ms:percentile(m.samples,.99)}]));
 writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}
