// Browser smoke for the affected Admin sections, using actual modules/CSS and
// controlled DTOs. It starts no OGID runtime and cannot invoke a real provider.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const chrome=process.env.OGID_TEST_CHROMIUM;
if(!chrome)throw Error('Set OGID_TEST_CHROMIUM to an installed Chromium binary.');
const output=resolve(process.argv[2]||join(tmpdir(),'ogid-agent-admin-view'));
mkdirSync(output,{recursive:true,mode:0o700});
const profile=mkdtempSync(join(tmpdir(),'ogid-admin-chrome-'));
const frontend=fileURLToPath(new URL('../../frontend/',import.meta.url));
const script=`
import {renderAgentRuntime,renderAgentOperations} from '/js/agentOperationsView.js';
import {renderNewsQuality} from '/js/newsQualityView.js';
import {mountAgentAdmin} from '/js/agentAdmin.js';
const now=new Date().toISOString(),hash='a'.repeat(64);
window.fixtureRuntime={components:{broker:{state:'running',pid:123,telemetry:{sampledAt:now,resident:'gpt-oss-20b',queue:0,lastSuccess:{at:now},lastFailure:{at:now,causeCode:'LLAMACPP_OUTPUT_FORMAT'}}},opencode:{state:'running',pid:124,telemetry:{version:'2.0.31',checkedAt:now,apiState:'available',lastFailure:{at:now,code:'AGENT_OPENCODE_TURN_FAILED'}}},worker:{state:'running',pid:125,telemetry:{checkedAt:now,generations:[{jobId:'active-fixture',fence:2,task:'instrument_outlook',phase:'inference'}]}}},services:{mcp:{state:'unverified',expectedContract:{version:'1.9.0',hash},profile:'agent-evidence',permittedTools:['ogid_agent_evidence','ogid_agent_evidence_chunk','ogid_agent_clusters','ogid_get_capabilities','ogid_health']},llamacpp:{state:'unknown',observedAt:null}}};
const jobs=Array.from({length:50},(_,i)=>({jobId:'job-'+i+'-0123456789abcdef',task:'instrument_outlook',scope:'us-equity-oracle',model:'llamacpp/gpt-oss-20b',status:'failed',fence:2,errorCode:'AGENT_OPENCODE_TURN_FAILED',createdAt:now,updatedAt:now,snapshotId:'snapshot-fixture-'+i}));
const data={sampledAt:now,since:now,runtime:window.fixtureRuntime,mode:'shadow',backgroundModel:'llamacpp/gpt-oss-20b',jobs:[{status:'failed',count:50}],sinceCounts:[{status:'failed',count:3}],current:{publications:0,completed:0,failed:3,active:1,executions:4,candidates:3,repairs:1,evidenceReads:2,lastSuccessAt:null,lastFailureAt:now},recentJobs:jobs,runs:jobs.map(j=>({jobId:j.jobId,fence:j.fence,metadata:{phase:'inference',terminalError:{causeCode:'LLAMACPP_OUTPUT_FORMAT'},lastToolFailure:{operationId:'agent.evidence.chunk',code:'INVALID_ARGUMENTS',validation:{issues:[{path:['evidenceId'],code:'invalid_type',expected:'string'}]}}}})),recentPublications:[],devices:[],taskModes:{instrument_outlook:'shadow'},modelCatalog:{backgroundModel:'llamacpp/gpt-oss-20b',state:'not-collected',models:[{id:'llamacpp/gpt-oss-20b',alias:'gpt-oss-20b',context:32768,ready:false,selectable:false,state:'unknown'}]}};
window.fixtureRequests=[];window.storageUnavailable=false;
window.fetch=async path=>{window.fixtureRequests.push(String(path));if(path!=='/api/admin/agent')throw Error('Unexpected provider/API call');return new Response(JSON.stringify({data}),{status:window.storageUnavailable?503:200,headers:{'content-type':'application/json'}});};
renderAgentRuntime(window.fixtureRuntime,document.getElementById('agent-process-body'));
renderNewsQuality(document.getElementById('news-quality-current'),{revision:4,eligibleCount:1,sourceMode:'stale',latestGeopoliticalPublishedAt:new Date(Date.now()-1900000).toISOString(),lastSuccessfulCheckAt:new Date(Date.now()-20000).toISOString(),projectionGeneratedAt:now,freshnessPolicy:{version:'news-freshness-v2',publicationMs:1800000,acquisitionMs:600000},freshness:{contentStatus:'stale',acquisitionStatus:'current',publicationAgeMs:1900000,acquisitionAgeMs:20000,evaluatedAt:now},staleReasons:['content-publication-expired']});
window.fixtureLoseObservation=()=>renderAgentRuntime({...window.fixtureRuntime,observationLost:true},document.getElementById('agent-process-body'));
window.fixtureUnknownIdentity=()=>renderAgentRuntime({...window.fixtureRuntime,services:{...window.fixtureRuntime.services,mcp:{state:'degraded',identity:{hash:null}}}},document.getElementById('agent-process-body'));
window.fixtureController=mountAgentAdmin();
window.fixtureReady=true;
`;
const html=`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/styles.css"><style>body{margin:0}main{padding:1rem;max-width:100%;box-sizing:border-box}section{margin-bottom:1rem;min-width:0}.table{border-collapse:collapse;width:100%}.table th,.table td{padding:.5rem;border-bottom:1px solid #415164}p{overflow-wrap:anywhere}button,select{font:inherit;padding:.5rem}.diagnostic-list{min-width:0}</style><main><h1>OGID · Operación del agente</h1><section class="diagnostic-card"><header class="diagnostic-card-header">Componentes del agente</header><div id="agent-process-body"></div></section><section class="diagnostic-card"><header class="diagnostic-card-header">News Provider Flow</header><div class="diagnostic-list" id="news-quality-current"></div></section><section class="diagnostic-card"><header class="diagnostic-card-header">Control del analista</header><div id="agent-admin-body"></div></section><section class="diagnostic-card"><header class="diagnostic-card-header">Actividad y resultados <span id="agent-activity-updated"></span></header><div id="agent-activity-body" class="diagnostic-list"></div><div id="agent-publications-body" class="diagnostic-list"></div></section></main><script type="module" src="/fixture.js"></script></html>`;
const server=createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
 if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(script);return;}
 const path=resolve(frontend,'.'+new URL(req.url,'http://localhost').pathname);
 if(!path.startsWith(frontend)||!existsSync(path)){res.writeHead(404).end();return;}
 res.setHeader('content-type',path.endsWith('.css')?'text/css':'text/javascript');res.end(readFileSync(path));
});
let browser,ws;const result={checks:[],views:[],status:'failed'};
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');
 browser=spawn(chrome,['--headless','--no-sandbox','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile],{stdio:'ignore'});
 const portPath=join(profile,'DevToolsActivePort');
 for(let i=0;i<100&&!existsSync(portPath);i++)await wait(100);
 const [port,path]=readFileSync(portPath,'utf8').trim().split('\n');
 ws=new WebSocket('ws://127.0.0.1:'+port+path);await once(ws,'open');
 let sequence=0;const pending=new Map();
 ws.on('message',bytes=>{const m=JSON.parse(bytes);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const command=(method,params)=>send(method,params,sessionId);
 const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
 await command('Page.enable');await command('Runtime.enable');await command('Emulation.setLocaleOverride',{locale:'es-ES'});await command('Emulation.setTimezoneOverride',{timezoneId:'Europe/Madrid'});
 for(const [name,width,height]of [['desktop',1440,1100],['mobile',390,1100]]){
  await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:name==='mobile'});
  await command('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
  for(let i=0;i<100;i++){if(await evaluate("window.fixtureReady&&document.querySelectorAll('#agent-activity-body tbody tr').length===50"))break;await wait(100);}
  const view=await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cards:document.querySelectorAll('#agent-process-body article').length,rows:document.querySelectorAll('#agent-activity-body tbody tr').length,requests:fixtureRequests,allErrors:document.getElementById('agent-activity-body').textContent.includes('LLAMACPP_OUTPUT_FORMAT')&&document.getElementById('agent-activity-body').textContent.includes('INVALID_ARGUMENTS'),contractPending:document.getElementById('agent-process-body').textContent.includes('Contrato sin verificar')})`);
  assert.equal(view.cards,5);assert.equal(view.rows,50);assert.equal(view.allErrors,true);assert.equal(view.contractPending,true);assert.ok(view.requests.every(p=>p==='/api/admin/agent'));assert.ok(view.scrollWidth<=width+1,'layout must stay within viewport');
  const png=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(output,name+'.png'),Buffer.from(png.data,'base64'),{mode:0o600});result.views.push({name,...view});
 }
 await evaluate('fixtureUnknownIdentity();');
 assert.equal(await evaluate("document.getElementById('agent-process-body').textContent.includes('Contrato observado: desconocida')"),true);
 await evaluate('fixtureLoseObservation();storageUnavailable=true;');
 assert.equal(await evaluate("[...document.querySelectorAll('#agent-process-body .diagnostic-pill')].every(n=>n.textContent==='Desconocido')"),true);
 await wait(5200);
 assert.equal(await evaluate("document.getElementById('agent-admin-body').textContent.includes('Actividad almacenada no disponible')&&document.querySelectorAll('#agent-activity-body tbody tr').length===50"),true);
 result.checks.push('Five component cards; unknown/unverified states; both final and MCP errors; bounded 50 jobs; no automatic model/provider requests; desktop/mobile viewport; storage failure retains activity');result.status='passed';
}finally{
 ws?.close();browser?.kill('SIGTERM');if(browser)await Promise.race([once(browser,'exit').catch(()=>{}),wait(3000)]);browser?.kill('SIGKILL');
 server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
}
