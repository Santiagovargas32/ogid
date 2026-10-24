import test from 'node:test';
import assert from 'node:assert/strict';
import {startAdvancedIntelligence} from '../../frontend/js/intelligence/advancedIntelligence.js';
const flush=()=>new Promise(r=>setImmediate(r));
function dom(){const nodes=new Map();const document={hidden:false,addEventListener(){},removeEventListener(){},getElementById(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',className:'',dataset:{},classList:{add(){},remove(){}}});return nodes.get(id);}};return {document,nodes};}
const snapshot=(at)=>({generatedAt:at,corpus:{},quality:{mode:'live'},methodology:{version:'fixture'},window:{label:'24h'},lifecycle:{status:'ready',snapshotAvailable:true}});

test('UI distinguishes preparation, keeps old data during refresh and never applies a response to changed filters',async()=>{
 const before=globalThis.document,{document,nodes}=dom();globalThis.document=document;let countries='RU',active=0,maxActive=0;
 const pending=[];const api={getAdvancedIntelligenceSnapshot:()=>{active++;maxActive=Math.max(active,maxActive);return new Promise(resolve=>pending.push(value=>{active--;resolve(value);}));}};
 const ui=startAdvancedIntelligence({api,getCountries:()=>countries});
 try{
  pending.shift()({generatedAt:null,lifecycle:{status:'preparing',jobStatus:'queued',retryAfterMs:2000}});await flush();assert.equal(nodes.get('panel-advanced-intel').dataset.advancedRefresh,'preparing');assert.doesNotMatch(nodes.get('advanced-intel-meta').innerHTML,/failed|unavailable/);
  let task=ui.refresh();pending.shift()(snapshot('2026-10-16T10:00:00Z'));await task;
  task=ui.refresh();pending.shift()({...snapshot('2026-10-16T10:00:00Z'),lifecycle:{status:'refreshing',jobStatus:'running'}});await task;assert.equal(nodes.get('panel-advanced-intel').dataset.advancedRefresh,'refreshing');assert.match(nodes.get('advanced-intel-meta').innerHTML,/Updating snapshot/);
  task=ui.refresh();countries='US';ui.refresh();pending.shift()(snapshot('2026-10-16T11:00:00Z'));await task;await flush();assert.doesNotMatch(nodes.get('advanced-intel-meta').innerHTML,/11:00/);
  pending.shift()({generatedAt:null,lifecycle:{status:'preparing',jobStatus:'running'}});await flush();assert.equal(nodes.get('panel-advanced-intel').dataset.advancedRefresh,'preparing');assert.doesNotMatch(nodes.get('advanced-intel-meta').innerHTML,/Generated/);
  task=ui.refresh();pending.shift()(snapshot('2026-10-16T12:00:00Z'));await task;assert.equal(nodes.get('panel-advanced-intel').dataset.advancedRefresh,'ok');assert.equal(maxActive,1);
 }finally{ui.stop();globalThis.document=before;}
});

test('polling follows its job through long calculations without another admission',async()=>{
 const before=globalThis.document,{document,nodes}=dom();globalThis.document=document;let admissions=0,polls=0,complete=false;
 const old=snapshot('2026-10-16T10:00:00Z');
 const api={getAdvancedIntelligenceSnapshot:async()=>{admissions++;return {...old,lifecycle:{status:'refreshing',jobId:'job-long',jobStatus:'queued'}};},getAdvancedJobStatus:async({jobId})=>{assert.equal(jobId,'job-long');polls++;return complete?snapshot('2026-10-16T12:00:00Z'):{...old,lifecycle:{status:'refreshing',jobId,jobStatus:'running'}};}};
 const ui=startAdvancedIntelligence({api,getCountries:()=> 'US'});
 try{
  await flush();for(let n=0;n<4;n++)await ui.refresh();assert.equal(admissions,1);assert.equal(polls,4);
  assert.equal(nodes.get('panel-advanced-intel').dataset.advancedRefresh,'refreshing');assert.match(nodes.get('advanced-intel-meta').innerHTML,/Updating snapshot/);
  complete=true;await ui.refresh();assert.equal(admissions,1);assert.equal(nodes.get('panel-advanced-intel').dataset.advancedRefresh,'ok');
 }finally{ui.stop();globalThis.document=before;}
});
