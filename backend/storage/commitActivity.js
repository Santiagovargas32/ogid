// Volatile scheduling counters, never a second source of durable state.
export const createCommitBuffer=()=>new SharedArrayBuffer(32);
export class CommitActivity {
  constructor(buffer){this.values=new BigUint64Array(buffer);}
  committed(bytes){
    // Preserve the first unacknowledged commit time through a continuous trickle.
    // A concurrent checkpoint can make this time conservative, never too new.
    if(Atomics.load(this.values,0)===Atomics.load(this.values,3))Atomics.store(this.values,2,BigInt(Date.now()));
    Atomics.add(this.values,1,BigInt(Math.max(4096,Math.ceil(bytes))));Atomics.add(this.values,0,1n);
  }
}
export function acknowledgeCommits(buffer,generation){if(buffer)Atomics.store(new BigUint64Array(buffer),3,BigInt(generation));}
export function readCommits(buffer){
  if(!buffer)return null;const v=new BigUint64Array(buffer);
  return {generation:Number(Atomics.load(v,0)),bytes:Number(Atomics.load(v,1)),at:Number(Atomics.load(v,2))};
}
