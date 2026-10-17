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
