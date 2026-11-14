import {setTimeout as pause} from 'node:timers/promises';
import {readCommits} from './commitActivity.js';

// Account only acknowledged native commits, using the existing
// SQL weight (bindings + statement overhead). This is producer pacing between
// pages, not an estimate or limit of physical device bandwidth.
export class CommittedWritePacer{
 constructor(buffer,{bytesPerSecond,burstBytes,now=()=>performance.now(),sleep=(ms,signal)=>pause(ms,undefined,{signal})}){
  if(!Number.isFinite(bytesPerSecond)||bytesPerSecond<=0||!Number.isFinite(burstBytes)||burstBytes<1)throw Error('Invalid committed write pacing budget');
  Object.assign(this,{buffer,bytesPerSecond,burstBytes,now,sleep});
  this.credit=burstBytes;this.lastRefill=now();this.observedBytes=readCommits(buffer)?.bytes||0;
  this.chargedBytes=0;this.waits=0;this.waitMs=0;this.active=0;this.workflows=0;
 }
 refill(){
  const instant=this.now(),elapsed=Math.max(0,instant-this.lastRefill);
  this.credit=Math.min(this.burstBytes,this.credit+elapsed*this.bytesPerSecond/1000);this.lastRefill=instant;
 }
 begin(){
  // Ignore commits from completed bootstrap/maintenance while no acquisition
  // existed. Retain debt from previous acquisitions and bounded idle credit.
  if(!this.workflows){this.refill();this.observedBytes=readCommits(this.buffer)?.bytes||0;}
  this.workflows++;let finished=false;
  return ()=>{if(finished)return;finished=true;this.account();this.workflows--;};
 }
 account(){
  this.refill();
  const bytes=readCommits(this.buffer)?.bytes||0,delta=Math.max(0,bytes-this.observedBytes);
  this.observedBytes=bytes;this.chargedBytes+=delta;this.credit-=delta;
 }
 status(){
  const refilled=Math.min(this.burstBytes,this.credit+Math.max(0,this.now()-this.lastRefill)*this.bytesPerSecond/1000);
  const pending=this.workflows?Math.max(0,(readCommits(this.buffer)?.bytes||0)-this.observedBytes):0;
  return {scope:'SQL weight during acquisition; not physical I/O; waits sum caller time',bytesPerSecond:this.bytesPerSecond,burstBytes:this.burstBytes,chargedBytes:this.chargedBytes,debtBytes:Math.max(0,pending-refilled),waits:this.waits,waitMs:this.waitMs,active:this.active,workflows:this.workflows};
 }
 async wait(signal){
  let started;
  try{
   for(;;){
    signal?.throwIfAborted();this.account();
    if(this.credit>=0)return;
    if(started===undefined){started=this.now();this.waits++;this.active++;}
    // Yield the event loop for fencing/control, cancellation and other work.
    // Charge once even when several cooperative workflows wait concurrently.
    await this.sleep(Math.min(1000,Math.max(1,-this.credit/this.bytesPerSecond*1000)),signal);
   }
  }finally{if(started!==undefined){this.active--;this.waitMs+=Math.max(0,this.now()-started);}}
 }
}
