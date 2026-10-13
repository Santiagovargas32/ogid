import test from "node:test";
import assert from "node:assert/strict";
import { PipelinePersistence } from "../storage/pipelinePersistence.js";

const storageError=code=>Object.assign(new Error(code),{code});

test("a successful stage save clears its previous failure without hiding another stage failure",async()=>{
  let failing=true;
  const persistence=new PipelinePersistence({request:async(_operation,{payload})=>{
    if(failing)throw storageError(payload.id === "news.normalize" ? "SQLITE_BUSY" : "SQLITE_FULL");
    return {persisted:true};
  }});
  for(const id of ["news.normalize","news.select"]){
    await assert.rejects(persistence.save("pipeline-stage",{id,stage:{status:"running"}}));
  }
  failing=false;
  await persistence.save("pipeline-stage",{id:"news.normalize",stage:{status:"completed"}});
  await assert.rejects(persistence.flush(),{code:"SQLITE_FULL"});
  await persistence.save("pipeline-stage",{id:"news.select",stage:{status:"completed"}});
  await persistence.flush();
  assert.equal(persistence.failure,null);
});

test("flush drains all accepted saves before reporting failure",async()=>{
  let release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const persistence=new PipelinePersistence({request:async(_operation,{kind})=>{
    if(kind === "failed")throw storageError("SQLITE_FULL");
    await barrier;return {persisted:true};
  }});
  const failed=persistence.save("failed",{});
  const saved=persistence.save("pending",{});
  await assert.rejects(failed);
  let finished=false;
  const flushing=persistence.flush().then(()=>assert.fail("failure expected"),error=>{finished=true;assert.equal(error.code,"SQLITE_FULL");});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(finished,false);
  release();await saved;await flushing;
  assert.equal(persistence.pending.size,0);
});

test("an older failed save cannot overwrite a newer successful save",async()=>{
  let rejectOld,calls=0;
  const persistence=new PipelinePersistence({request:()=>{
    if(++calls === 1)return new Promise((_resolve,reject)=>{rejectOld=reject;});
    return Promise.resolve({persisted:true});
  }});
  const old=persistence.save("market",{});
  await persistence.save("market",{});
  rejectOld(storageError("SQLITE_BUSY"));await assert.rejects(old);
  await persistence.flush();assert.equal(persistence.failure,null);
});

const appendOnlyRecords={
  "awareness-audit":[
    {recordedAt:"2026-10-13T18:18:28Z",event:{eventId:"event-1",revision:1}},
    {recordedAt:"2026-10-13T18:18:29Z",event:{eventId:"event-1",revision:2}}
  ],
  "awareness-poll":[
    {recordedAt:"2026-10-13T18:18:28Z",sourceId:"source-1",poll:{completedAt:"2026-10-13T18:18:28Z",outcome:"success"}},
    {recordedAt:"2026-10-13T18:18:29Z",sourceId:"source-1",poll:{completedAt:"2026-10-13T18:18:29Z",outcome:"success"}}
  ],
  quotes:[
    {updatedAt:"2026-10-13T18:18:28Z",quotes:{GD:{asOf:"2026-10-13T18:18:28Z",price:100,source:"yahoo"},LMT:{asOf:"2026-10-13T18:18:28Z",price:200,source:"yahoo"}}},
    {updatedAt:"2026-10-13T18:18:29Z",quotes:{GD:{asOf:"2026-10-13T18:18:29Z",price:101,source:"yahoo"},LMT:{asOf:"2026-10-13T18:18:29Z",price:201,source:"yahoo"}}}
  ]
};
const reordered=value=>value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reordered(item)])) : value;

for(const [kind,[first,second]]of Object.entries(appendOnlyRecords)){
  test(`${kind}: a different successful record cannot hide an unawaited failed save`,async()=>{
    let calls=0;
    const persisted=[];
    const persistence=new PipelinePersistence({request:async(_operation,{payload})=>{
      if(++calls === 1)throw storageError("SQLITE_BUSY");
      persisted.push(payload);return {persisted:true};
    }});
    // Fire and forget, as appendPollAudit is used by recordPoll().
    persistence.save(kind,first);
    await persistence.save(kind,second);
    await assert.rejects(persistence.flush(),{code:"SQLITE_BUSY"});
    await assert.rejects(persistence.flush(),{code:"SQLITE_BUSY"});
    assert.deepEqual(persisted,[second]);
    // Retry the same content in a new object, including reordered nested keys.
    await persistence.save(kind,reordered(first));
    await persistence.flush();
    assert.deepEqual(persisted,[second,reordered(first)]);
    assert.equal(persistence.failure,null);
    assert.equal(persistence.outcomes.size,0);
    assert.equal(persistence.pendingKeys.size,0);
  });

  test(`${kind}: a delayed failure remains visible after another record succeeds`,async()=>{
    let rejectFirst,calls=0;
    const persistence=new PipelinePersistence({request:()=>{
      if(++calls === 1)return new Promise((_resolve,reject)=>{rejectFirst=reject;});
      return Promise.resolve({persisted:true});
    }});
    const failed=persistence.save(kind,first);
    await persistence.save(kind,second);
    rejectFirst(storageError("SQLITE_BUSY"));
    await assert.rejects(failed,{code:"SQLITE_BUSY"});
    await assert.rejects(persistence.flush(),{code:"SQLITE_BUSY"});
    await persistence.save(kind,reordered(first));
    await persistence.flush();
    assert.equal(persistence.failure,null);
  });
}
