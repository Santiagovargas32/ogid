import {createHash} from 'node:crypto';

const format='ogid-provider-quota-chunks-v1',chunkItems=256;
const sha=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>Object.assign(Error('Incomplete provider quota checkpoint'),{code:'STORAGE_QUOTA_CHECKPOINT_INCOMPLETE',statusCode:503});
const pathKey=(provider,field)=>JSON.stringify([provider,field]);
const own=(object,key)=>object!==null&&typeof object==='object'&&Object.hasOwn(object,key);
const set=(object,key,value)=>Object.defineProperty(object,key,{value,writable:true,enumerable:true,configurable:true});
const hashes=packet=>new Set((packet?.arrays||[]).flatMap(array=>array.refs.map(ref=>ref.sha256)));

// KMP finds the longest old suffix equal to a new prefix in linear time,
// retaining duplicates and order even when expired events leave the front.
function overlap(oldValues,nextValues){
 if(!oldValues.length||!nextValues.length)return 0;
 const pattern=nextValues.map(value=>JSON.stringify(value)),prefix=new Uint32Array(pattern.length);
 for(let i=1,j=0;i<pattern.length;i++){
  while(j&&pattern[i]!==pattern[j])j=prefix[j-1];
  if(pattern[i]===pattern[j])j++;prefix[i]=j;
 }
 let matched=0;
 for(const value of oldValues){
  const encoded=JSON.stringify(value);
  while(matched&&(matched===pattern.length||pattern[matched]!==encoded))matched=prefix[matched-1];
  if(pattern[matched]===encoded)matched++;
 }
 return matched;
}
function suffixRefs(refs,start){
 const result=[];let position=0;
 for(const ref of refs){
  const end=position+ref.count;
  if(end>start){const skipped=Math.max(0,start-position);result.push({...ref,offset:ref.offset+skipped,count:ref.count-skipped});}
  position=end;
 }
 return result;
}

// Only the durable representation changes. Business callers keep the complete
// JSON quota state, with identical counters, ordered events and recovery data.
export class ProviderQuotaSnapshot{
 constructor(db){this.db=db;}
 readPacket(){
  const row=this.db.prepare("SELECT payload_json FROM runtime_snapshots WHERE kind='provider-quota'").get();
  if(!row)return {value:null,packet:null,chunks:new Map()};
  const parsed=JSON.parse(row.payload_json),chunks=new Map();
  if(parsed?.storageFormat!==format||own(parsed,'providers'))return {value:parsed,packet:null,chunks};
  if(!Array.isArray(parsed.arrays)||!own(parsed,'state')||!/^[a-f0-9]{64}$/.test(parsed.sha256||''))throw invalid();
  const value=structuredClone(parsed.state),paths=new Set();
  for(const array of parsed.arrays){
   if(typeof array?.provider!=='string'||typeof array.field!=='string'||!Array.isArray(array.refs)||!own(value?.providers,array.provider))throw invalid();
   const provider=value.providers[array.provider],key=pathKey(array.provider,array.field);
   if(paths.has(key)||!own(provider?.events,array.field)||!Array.isArray(provider.events[array.field])||provider.events[array.field].length)throw invalid();
   paths.add(key);const events=[];
   for(const ref of array.refs){
    if(!/^[a-f0-9]{64}$/.test(ref?.sha256||'')||!Number.isSafeInteger(ref.offset)||ref.offset<0||!Number.isSafeInteger(ref.count)||ref.count<1||ref.count>chunkItems)throw invalid();
    let stored=chunks.get(ref.sha256);
    if(!stored){
     stored=this.db.prepare('SELECT item_count,payload_json FROM provider_quota_chunks WHERE chunk_sha256=?').get(ref.sha256);
     if(!stored||sha(stored.payload_json)!==ref.sha256)throw invalid();
     chunks.set(ref.sha256,stored);
    }
    // Every reference gets its own JSON object graph, as a flat snapshot did.
    const data=JSON.parse(stored.payload_json);
    if(!Array.isArray(data)||data.length!==stored.item_count||data.length<1||data.length>chunkItems)throw invalid();
    if(ref.offset+ref.count>data.length)throw invalid();
    for(let n=ref.offset;n<ref.offset+ref.count;n++)events.push(data[n]);
   }
   set(provider.events,array.field,events);
  }
  if(sha(JSON.stringify(value))!==parsed.sha256)throw invalid();
  return {value,packet:parsed,chunks};
 }
 load(){return this.db.transaction(()=>this.readPacket().value).deferred();}
 save(payload,at){
  return this.db.transaction(()=>{
   const encoded=JSON.stringify(payload),digest=sha(encoded),previous=this.readPacket();
   if(previous.packet?.sha256===digest)return;
   const state=JSON.parse(encoded),arrays=[],known=hashes(previous.packet);
   const priorArrays=new Map((previous.packet?.arrays||[]).map(array=>[pathKey(array.provider,array.field),array]));
   for(const [provider,value]of Object.entries(state?.providers||{})){
    if(!value?.events||typeof value.events!=='object'||Array.isArray(value.events))continue;
    for(const [field,events]of Object.entries(value.events)){
     if(!Array.isArray(events))continue;
     const prior=priorArrays.get(pathKey(provider,field));
     const old=prior?previous.value.providers[provider].events[field]:[];
     const retained=prior?overlap(old,events):0;
     const refs=prior?suffixRefs(prior.refs,old.length-retained):[];
     let through=retained;
     // Rebuild the partial tail, avoiding one new chunk per appended event.
     if(refs.at(-1)?.count<chunkItems)through-=refs.pop().count;
     for(let n=through;n<events.length;n+=chunkItems){
      const items=events.slice(n,n+chunkItems),json=JSON.stringify(items),key=sha(json);
      if(!known.has(key)){
       const result=this.db.prepare('INSERT OR IGNORE INTO provider_quota_chunks VALUES(?,?,?)').run(key,items.length,json);
       if(!result.changes){const existing=this.db.prepare('SELECT item_count,payload_json FROM provider_quota_chunks WHERE chunk_sha256=?').get(key);if(existing?.item_count!==items.length||existing.payload_json!==json)throw invalid();}
       known.add(key);
      }
      refs.push({sha256:key,offset:0,count:items.length});
     }
     arrays.push({provider,field,refs});set(value.events,field,[]);
    }
   }
   const packet={storageFormat:format,sha256:digest,state,arrays},next=hashes(packet);
   this.db.prepare("INSERT INTO runtime_snapshots VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json WHERE runtime_snapshots.payload_json!=excluded.payload_json").run('provider-quota',at,JSON.stringify(packet));
   for(const key of hashes(previous.packet))if(!next.has(key))this.db.prepare('DELETE FROM provider_quota_chunks WHERE chunk_sha256=?').run(key);
  }).immediate();
 }
}
