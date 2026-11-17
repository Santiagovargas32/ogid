import {stableHash} from '../utils/stableHash.js';
import {AppError} from '../utils/error.js';

const KIND='cycle-continuation-v1';
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value);
const fail=code=>{throw new AppError(code,409,code);};
function assertJson(value,seen=new Set(),depth=0){
  if(depth>64)fail('CONTINUATION_INVALID_INPUT');
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
  if(!value||typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)fail('CONTINUATION_INVALID_INPUT');
  seen.add(value);for(const item of Object.values(value))assertJson(item,seen,depth+1);seen.delete(value);
}
function encode(value){
  assertJson(value);
  let text;
  try{text=JSON.stringify(value);if(text===undefined||stableHash(JSON.parse(text))!==stableHash(value))fail('CONTINUATION_INVALID_INPUT');}
  catch{fail('CONTINUATION_INVALID_INPUT');}
  if(Buffer.byteLength(text)>65536)fail('CONTINUATION_INPUT_TOO_LARGE');
  return text;
}

// Bounded phase descriptors only. Large inputs must use immutable references.
// The caller must commit a descriptor before starting its external effects.
export class CycleContinuations {
  constructor(db,{now=Date.now}={}){Object.assign(this,{db,now});}
  row(jobId){
    if(!identifier(jobId))fail('CONTINUATION_INVALID_INPUT');
    const row=this.db.prepare('SELECT * FROM acquisition_jobs WHERE job_id=? AND kind=?').get(jobId,KIND);
    if(!row)fail('CONTINUATION_UNKNOWN');
    return {...row,descriptor:JSON.parse(row.job_json)};
  }
  admit({jobId,scope,phase,input}){
    if(![jobId,scope,phase].every(identifier))fail('CONTINUATION_INVALID_INPUT');
    const inputHash=stableHash(JSON.parse(encode(input))),at=new Date(this.now()).toISOString();
    return this.db.transaction(()=>{
      const existing=this.db.prepare('SELECT job_id FROM acquisition_jobs WHERE job_id=?').get(jobId);
      if(existing){const row=this.row(jobId);if(row.descriptor.intentHash!==stableHash([scope,phase,inputHash]))fail('STORAGE_IDEMPOTENCY_CONFLICT');return this.view(row);}
      const active=this.db.prepare("SELECT job_id FROM acquisition_jobs WHERE kind=? AND status='pending' AND json_extract(job_json,'$.scope')=?").get(KIND,scope);
      if(active)fail('CONTINUATION_SCOPE_BUSY');
      const descriptor={version:1,scope,phase,input,inputHash,intentHash:stableHash([scope,phase,inputHash]),cursor:0,owner:null,fence:0,leaseUntil:0,lastTransition:null};
      this.db.prepare('INSERT INTO acquisition_jobs VALUES(?,?,?,\'pending\',?,?,?)').run(jobId,jobId,KIND,at,at,encode(descriptor));
      return this.view(this.row(jobId));
    }).immediate();
  }
  view(row){return {jobId:row.job_id,status:row.status,...row.descriptor};}
  claim({jobId,owner}){
    if(!identifier(owner))fail('CONTINUATION_INVALID_INPUT');
    return this.db.transaction(()=>{
      const row=this.row(jobId),d=row.descriptor;
      if(row.status!=='pending')return null;
      if(d.owner&&d.leaseUntil>this.now())return d.owner===owner?this.view(row):null;
      Object.assign(d,{owner,fence:d.fence+1,leaseUntil:this.now()+90000});
      this.save(row);return this.view(row);
    }).immediate();
  }
  assertOwner(row,{owner,fence}){
    if(row.descriptor.owner!==owner||row.descriptor.fence!==fence||row.descriptor.leaseUntil<=this.now())fail('CONTINUATION_LEASE_LOST');
  }
  save(row){this.db.prepare('UPDATE acquisition_jobs SET status=?,updated_at=?,job_json=? WHERE job_id=? AND kind=?').run(row.status,new Date(this.now()).toISOString(),encode(row.descriptor),row.job_id,KIND);}
  renew(auth){return this.db.transaction(()=>{const row=this.row(auth.jobId);this.assertOwner(row,auth);if(row.status!=='pending')fail('CONTINUATION_STATE');row.descriptor.leaseUntil=this.now()+90000;this.save(row);return this.view(row);}).immediate();}
  advance({jobId,owner,fence,cursor,phase,input,complete=false,transitionId},apply=()=>null){
    if(!identifier(transitionId)||!identifier(phase)||!Number.isSafeInteger(cursor)||cursor<0||typeof complete!=='boolean')fail('CONTINUATION_INVALID_INPUT');
    const frozen=JSON.parse(encode(input)),hash=stableHash([cursor,phase,frozen,complete]);
    return this.db.transaction(()=>{
      const row=this.row(jobId),d=row.descriptor;
      // A lost ACK can acknowledge this exact transition after lease expiry,
      // but never after ownership has moved to a different fenced attempt.
      if(d.owner!==owner||d.fence!==fence)fail('CONTINUATION_LEASE_LOST');
      if(d.lastTransition?.id===transitionId){if(d.lastTransition.hash!==hash)fail('STORAGE_IDEMPOTENCY_CONFLICT');return {...this.view(row),replayed:true};}
      this.assertOwner(row,{owner,fence});
      if(row.status!=='pending'||d.cursor!==cursor)fail('CONTINUATION_STATE');
      const result=apply();if(result?.then)fail('STORAGE_ASYNC_TRANSACTION');
      Object.assign(d,{phase,input:frozen,inputHash:stableHash(frozen),cursor:cursor+1,lastTransition:{id:transitionId,hash}});
      if(complete)row.status='complete';
      this.save(row);return this.view(row);
    }).immediate();
  }
  release(auth){return this.db.transaction(()=>{const row=this.row(auth.jobId);this.assertOwner(row,auth);if(row.status!=='pending')fail('CONTINUATION_STATE');row.descriptor.owner=null;row.descriptor.leaseUntil=0;this.save(row);return this.view(row);}).immediate();}
  get({jobId}){return this.view(this.row(jobId));}
  scope({scope}){
    if(!identifier(scope))fail('CONTINUATION_INVALID_INPUT');
    const row=this.db.prepare("SELECT job_id FROM acquisition_jobs WHERE kind=? AND status='pending' AND json_extract(job_json,'$.scope')=?").get(KIND,scope);
    return row?this.get({jobId:row.job_id}):null;
  }
  pending({after=''}={}){
    if(after!==''&&!identifier(after))fail('CONTINUATION_INVALID_INPUT');
    return this.db.prepare("SELECT job_id AS jobId,json_extract(job_json,'$.scope') AS scope,json_extract(job_json,'$.phase') AS phase,json_extract(job_json,'$.cursor') AS cursor FROM acquisition_jobs WHERE kind=? AND status='pending' AND job_id>? ORDER BY job_id LIMIT 64").all(KIND,after);
  }
  recoverPage({after=''}={}){
    return this.db.transaction(()=>{
      const page=this.pending({after});
      for(const {jobId}of page){const row=this.row(jobId);if(row.descriptor.owner){row.descriptor.owner=null;row.descriptor.leaseUntil=0;this.save(row);}}
      return {count:page.length,after:page.at(-1)?.jobId||after};
    }).immediate();
  }
}
