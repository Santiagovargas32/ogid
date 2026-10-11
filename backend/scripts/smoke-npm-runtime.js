// Exercise the real npm start entrypoint with storage/background work isolated.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
const child=spawn('npm',['start'],{cwd:fileURLToPath(new URL('..',import.meta.url)),detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',HOST:'0.0.0.0',PORT:'0',DISABLE_BACKGROUND_REFRESH:'1',AI_PROVIDER:'none',AI_MODE:'off',AWARENESS_MODE:'off',MARKET_HISTORY_PERSIST:'0',MARKET_DAILY_CANDLES_ENABLED:'0',MARKET_INTRADAY_CANDLES_ENABLED:'0',LOG_LEVEL:'info'}});
let output='',errorOutput='',port;
const exited=once(child,'exit');
child.stdout.on('data',chunk=>{
  output=(output+chunk).slice(-128_000);
  for(const line of output.split('\n'))try{const event=JSON.parse(line);if(event.message==='server_started')port=event.port;}catch{}
});
child.stderr.on('data',chunk=>{errorOutput=(errorOutput+chunk).slice(-128_000);});
let socket;
const start=performance.now();
try{
  const deadline=performance.now()+15_000;
  while(!port&&performance.now()<deadline){if(child.exitCode!==null)throw Error('npm start exited');await delay(25);}
  if(!port)throw Error('npm start did not bind');
  const startupMs=performance.now()-start;
  const base=`http://127.0.0.1:${port}`;
  const health=await fetch(base+'/api/health/ready');if(health.status!==200)throw Error(`readiness ${health.status}`);
  socket=new WebSocket(base.replace('http:','ws:')+'/ws',{origin:base});
  const messages=[];socket.on('message',raw=>messages.push(JSON.parse(raw).type));
  await once(socket,'open');await delay(20);
  if(!messages.includes('snapshot'))throw Error('missing WS snapshot');
  const closed=once(socket,'close');
  process.kill(-child.pid,'SIGTERM');
  const [code,reason]=await closed;await exited;await delay(100);
  if(code!==1001||reason.toString()!=='server-shutdown')throw Error(`unexpected close ${code}`);
  if(!output.includes('server_stopped')||errorOutput.includes('shutdown_failed'))throw Error('shutdown did not complete');
  let released=false;try{await fetch(base+'/api/health/live');}catch{released=true;}
  if(!released)throw Error('port still listening after shutdown');
  console.log(JSON.stringify({command:'npm start',host:'0.0.0.0',profile:'isolated; no external requests or operator persistence',startupMs,ready:true,snapshot:true,closeCode:code,closeReason:reason.toString(),portReleased:true},null,2));
}finally{
  socket?.terminate();
  try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
}
