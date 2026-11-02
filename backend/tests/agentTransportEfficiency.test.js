import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenCodeClient} from '../services/agent/opencodeClient.js';

test('matched replay including pagination and final reconciliation reduces full HTTP message reads at least eighty percent',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1000});let terminal=false;
 const fetchImpl=async url=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/message'))return Response.json(u.searchParams.has('cursor')?{data:[{id:'target',type:'user',time:{created:1}}]}:{data:[{id:'answer',type:'assistant',time:{created:2,...(terminal?{completed:180000}:{})},finish:terminal?'stop':undefined,content:[{type:'text',text:terminal?'Final con citas':'Progreso'}]}],cursor:{next:'page-two'}});
  return Response.json({data:{id:'s',outcome:terminal?'succeeded':null,time:{idle:terminal?180001:0}}});
 };
 const baseline=new OpenCodeClient({password:'fixture',fetchImpl}),cached=new OpenCodeClient({password:'fixture',fetchImpl});
 for(let i=0;i<90;i++){await baseline.progress('s',undefined,'target');await cached.progress('s',undefined,'target',{cache:true});t.mock.timers.tick(2000);}
 terminal=true;cached.eventHints.add('s|target');
 const previous=await baseline.progress('s',undefined,'target'),final=await cached.progress('s',undefined,'target',{cache:true});
 assert.deepEqual(final,previous);assert.equal(final.text,'Final con citas');assert.equal(final.idle,true);
 assert.equal(baseline.messageHttpReads,182);assert.equal(cached.messageHttpReads,cached.messagePageReads*2);
 assert.ok(1-cached.messageHttpReads/baseline.messageHttpReads>=0.8);
 assert.ok(cached.messageResponseBytes>0&&cached.messageResponseBytes<baseline.messageResponseBytes);
});
