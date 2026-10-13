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
