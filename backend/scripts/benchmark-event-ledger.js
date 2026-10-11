import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
createRequire(import.meta.url)('../tests/testSetup.cjs');
process.env.LOG_LEVEL='error';
const {EventLedger}=await import('../services/research/eventLedger.js');
const {ResearchStore}=await import('../services/research/researchStore.js');
const store=new ResearchStore();
for(let i=0;i<10_000;i++)store.state.events[`event-${i}`]={eventId:`event-${i}`,identityVersion:'source-publication-v2',instrumentIds:[],quality:{identityVerified:true},updatedAt:'2026-10-11T12:00:00Z',receivedAt:'2026-10-11T12:00:00Z',title:`Unrelated country report ${i}`,summary:'Permitted metadata. '.repeat(8),evidence:[{id:`e-${i}`,title:`Unrelated country report ${i}`,excerpt:'Permitted excerpt. '.repeat(8),url:`https://fixture.test/${i}`,originGroup:'unverified-origin'}]};
const ledger=new EventLedger({store});
globalThis.gc?.();const memoryBefore=process.memoryUsage();
const samples=[];const cpu=process.cpuUsage();
for(let i=0;i<20;i++){const t=performance.now();const result=ledger.search({instrumentIds:['us-equity-general-dynamics'],limit:10});if(result.total)throw Error('fixture-match-error');samples.push(performance.now()-t);}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({rows:10_000,rounds:20,p50Ms:samples[10],p95Ms:samples[19],cpu:process.cpuUsage(cpu),memoryBefore,memoryAfter:process.memoryUsage()},null,2));
