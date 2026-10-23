import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compactResource, DASHBOARD_PROFILE } from '../state/dashboardProjection.js';

export const SYNC_POLICY = Object.freeze({pageBytes:64*1024,cacheBytes:64*1024*1024,versionTtlMs:60000,retainedLimit:16,downloadsPerClient:2});
const memoryBytes = encoded => Math.max(Buffer.byteLength(encoded),encoded.length*2)+256;
const hash = encoded => createHash('sha256').update(encoded).digest('hex');
const safeBoundary = (text,end) => end>0 && end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]) && /[\uDC00-\uDFFF]/.test(text[end]) ? end-1 : end;

// All representations are immutable and shared by references. Downloads pin a
// representation, not a SQLite transaction; all reservations share one budget.
export class StateSync {
  constructor(stateManager,{historyLimit=256,pageChars=null,pageBytes=SYNC_POLICY.pageBytes,cacheBytes=SYNC_POLICY.cacheBytes,versionTtlMs=SYNC_POLICY.versionTtlMs,retainedLimit=SYNC_POLICY.retainedLimit,now=Date.now}={}) {
    Object.assign(this,{stateManager,historyLimit,pageChars,pageBytes,cacheBytes,versionTtlMs,retainedLimit,now});
    this.epoch=randomUUID();this.revision=0;this.history=[];this.versions={};this.fingerprints=new Map();
    this.dashboardVersions={};this.dashboardFingerprints=new Map();
    this.references=new Map();this.cache=new Map();this.serialized=new Map();this.retained=new Map();this.downloads=new Map();this.pageLeases=new Map();this.missReasons=new Map();
    this.metrics={retainedBytes:0,representationBytes:0,reservedBytes:0,expiredVersions:0,evictedVersions:0,capacityRejected:0,serializations:0,serializationMs:0,httpBytes:0,conflicts:0};
    for(const resource of this.keys())this.serialized.set(resource,this.capture(resource));
    this.trim();
  }
  keys(){return this.stateManager.getSyncKeys?.() || Object.keys(this.stateManager.getSnapshot()).filter(key=>!['admin','signalCorpus','marketSignalCorpus'].includes(key));}
  capture(resource) {
    const started=performance.now();
    const value=this.stateManager.getSyncResource ? this.stateManager.getSyncResource(resource) : this.stateManager.getSnapshot()[resource];
    const encoded=JSON.stringify(value??null);
    const representation={encoded,hash:hash(encoded),bytes:memoryBytes(encoded)};
    this.metrics.serializations++;this.metrics.serializationMs+=performance.now()-started;
    return representation;
  }
  manifest(){
    // An advertised initial revision owns bytes even before its first GET.
    for(const key of this.keys())if(!this.fingerprints.has(key)){
      const representation=this.serialized.get(key) || this.capture(key);this.serialized.set(key,representation);this.fingerprints.set(key,representation.hash);
    }
    this.trim();
    return {protocol:2,epoch:this.epoch,revision:this.revision,resources:Object.fromEntries(this.keys().map(key=>[key,this.versions[key]||0])),snapshotUrl:'/api/intel/sync',changesUrl:'/api/intel/changes',profiles:{[DASHBOARD_PROFILE]:{protocol:1,resources:{...this.dashboardVersions}}}};
  }
  change(resources) {
    const changed=[];
    for(const key of [...new Set(resources)].filter(key=>this.keys().includes(key))) {
      const representation=this.capture(key);
      if(this.fingerprints.get(key)===representation.hash)continue;
      const previous=this.serialized.get(key) || this.cache.get(key);
      if(previous)this.retained.set(`${key}:${this.versions[key]||0}`,{representation:previous,expiresAt:this.now()+this.versionTtlMs,resource:key});
      this.serialized.set(key,representation);this.cache.delete(key);this.fingerprints.set(key,representation.hash);changed.push(key);
    }
    if(!changed.length){this.trim();return null;}
    const entry={epoch:this.epoch,revision:++this.revision,resources:{}};
    for(const key of changed){
      this.versions[key]=this.revision;entry.resources[key]=this.revision;
      const value=this.stateManager.getSyncResource?this.stateManager.getSyncResource(key):this.stateManager.getSnapshot()[key];
      const compact=compactResource(key,value);
      if(compact===undefined || key==='pipelineStatus')continue;
      const semantic=key==='market'?{...compact,updatedAt:undefined,revision:undefined,session:{...compact.session,checkedAt:undefined}}:
        key==='meta'?{...compact,lastRefreshAt:undefined,refreshStatus:undefined}:compact;
      const fingerprint=hash(JSON.stringify(semantic));
      if(this.dashboardFingerprints.get(key)!==fingerprint){this.dashboardFingerprints.set(key,fingerprint);this.dashboardVersions[key]=this.revision;}
    }
    this.trim();this.history.push(entry);if(this.history.length>this.historyLimit)this.history.shift();return entry;
  }
  changes(epoch,since) {
    if(epoch!==this.epoch || !Number.isSafeInteger(since) || since<0 || since>this.revision || since<(this.history[0]?.revision||1)-1)return {...this.manifest(),resyncRequired:true};
    return {epoch:this.epoch,revision:this.revision,resyncRequired:false,resources:Object.assign({},...this.history.filter(entry=>entry.revision>since).map(entry=>entry.resources))};
  }
  representations(){return new Set([...this.serialized.values(),...this.cache.values(),...[...this.retained.values()].map(item=>item.representation),...[...this.downloads.values(),...this.pageLeases.values()].map(item=>item.representation)]);}
  removedVersion(key,code){
    this.missReasons.set(key,{code,expiresAt:this.now()+this.versionTtlMs});
    while(this.missReasons.size>256)this.missReasons.delete(this.missReasons.keys().next().value);
  }
  trim() {
    for(const [key,item] of this.missReasons)
      if(item.expiresAt<=this.now())this.missReasons.delete(key);
    for(const [id,item] of this.downloads)
      if(item.expiresAt<=this.now())this.downloads.delete(id);
    for(const [id,item] of this.pageLeases)
      if(item.expiresAt<=this.now())this.pageLeases.delete(id);
    const pinned=new Set([...this.downloads.values(),...this.pageLeases.values()].map(item=>item.representation));
    for(const [key,item] of this.retained)if(item.expiresAt<=this.now()){
      this.retained.delete(key);
      this.removedVersion(key,'SYNC_REVISION_EXPIRED');
      this.metrics.expiredVersions++;
    }
    const bytes=()=>[...this.representations()].reduce((sum,item)=>sum+item.bytes,0)
      +(this.downloads.size+this.pageLeases.size)*512+this.missReasons.size*192;
    // Expel the oldest revision from the busiest resource first.
    while(this.retained.size>this.retainedLimit || bytes()>this.cacheBytes) {
      const counts=new Map();
      for(const item of this.retained.values())counts.set(item.resource,(counts.get(item.resource)||0)+1);
      // A reservation owns its own reference. Removing a historical lookup
      // must not invalidate that reservation or make this index unbounded.
      const candidates=[...this.retained].filter(([,item])=>
        this.retained.size>this.retainedLimit || !pinned.has(item.representation));
      candidates.sort((a,b)=>(counts.get(b[1].resource)||0)-(counts.get(a[1].resource)||0));
      if(!candidates.length)break;
      this.retained.delete(candidates[0][0]);
      this.removedVersion(candidates[0][0],'SYNC_REVISION_EVICTED');
      this.metrics.evictedVersions++;
    }
    for(const [key,item] of this.serialized)if(bytes()>this.cacheBytes && !pinned.has(item)){
      this.serialized.delete(key);
      this.cache.delete(key);
    }
    this.metrics.representationBytes=bytes();
    this.metrics.retainedBytes=[...new Set([...this.retained.values()].map(item=>item.representation))].reduce((sum,item)=>sum+item.bytes,0);
    this.metrics.reservedBytes=[...pinned].reduce((sum,item)=>sum+item.bytes,0);
  }
  resolve(resource,revision) {
    const current=this.versions[resource]||0;
    if(revision!==current)return this.retained.get(`${resource}:${revision}`)?.representation || this.pageLeases.get(`${resource}:${revision}`)?.representation;
    let representation=this.serialized.get(resource) || this.cache.get(resource);
    if(!representation){
      representation=this.capture(resource);
      if(this.fingerprints.has(resource) && this.fingerprints.get(resource)!==representation.hash)return null;
      if(representation.bytes>this.cacheBytes)return null;
      this.serialized.set(resource,representation);this.fingerprints.set(resource,representation.hash);this.trim();
    }
    return representation;
  }
  page({resource,epoch,revision,cursor=0,downloadId,profile,clientKey='anonymous',filterKey=''}={}) {
    this.trim();
    if(!this.keys().includes(resource))return {status:404,code:'SYNC_RESOURCE_UNKNOWN'};
    if(epoch && epoch!==this.epoch)return this.conflict('SYNC_EPOCH_CHANGED');
    if(!Number.isSafeInteger(cursor)||cursor<0)return {status:400,code:'SYNC_CURSOR_INVALID'};
    const requested=revision??(this.versions[resource]||0);
    if(!Number.isSafeInteger(requested)||requested<0)return {status:400,code:'SYNC_REVISION_INVALID'};
    let representation,download;
    if(downloadId){
      download=this.downloads.get(downloadId);
      if(!download)return this.conflict('SYNC_DOWNLOAD_EXPIRED');
      if(download.resource!==resource || download.revision!==requested || download.profile!==profile ||
          download.clientKey!==clientKey || download.filterKey!==filterKey)
        return {status:400,code:'SYNC_DOWNLOAD_MISMATCH'};
      representation=download.representation;
    }else{
      representation=this.resolve(resource,requested);
      if(!representation)return this.conflict(this.missReasons.get(`${resource}:${requested}`)?.code || 'SYNC_REVISION_EXPIRED');
      if(profile){
        if(cursor!==0)return {status:400,code:'SYNC_DOWNLOAD_REQUIRED'};
        const extra=this.representations().has(representation)?0:representation.bytes;
        const clientDownloads=[...this.downloads.values()].filter(item=>item.clientKey===clientKey).length;
        if(this.downloads.size>=128 || clientDownloads>=SYNC_POLICY.downloadsPerClient ||
            this.metrics.representationBytes+extra+512>this.cacheBytes){
          this.metrics.capacityRejected++;
          return {status:503,code:'SYNC_CAPACITY_EXHAUSTED',retryAfterMs:1000};
        }
        const id=randomUUID();
        download={id,resource,revision:requested,representation,profile,clientKey,filterKey,
          expiresAt:this.now()+this.versionTtlMs};
        this.downloads.set(id,download);
        this.trim();
      }
    }
    const encoded=representation.encoded;
    if(cursor>encoded.length)return {status:400,code:'SYNC_CURSOR_INVALID'};
    const dataAt=end=>({epoch:this.epoch,revision:requested,resource,encoding:'json-fragments-v1',
      cursor,nextCursor:end<encoded.length?end:null,fragment:encoded.slice(cursor,end),
      ...(download?{downloadId:download.id,expiresAt:new Date(download.expiresAt).toISOString()}: {})});
    const fits=end=>Buffer.byteLength(JSON.stringify({ok:true,data:dataAt(end)}))<=this.pageBytes;
    let low=cursor,high=Math.min(encoded.length,cursor+(this.pageChars||this.pageBytes));
    while(low<high){
      const middle=Math.ceil((low+high)/2);
      if(fits(middle))low=middle;
      else high=middle-1;
    }
    const end=safeBoundary(encoded,low);
    if((end===cursor && cursor<encoded.length) || !fits(end))return {status:413,code:'SYNC_PAGE_BUDGET_EXCEEDED'};
    const data=dataAt(end);
    this.metrics.httpBytes+=Buffer.byteLength(JSON.stringify({ok:true,data}));
    const leaseKey=`${resource}:${requested}`;
    if(!profile && data.nextCursor!==null && !this.pageLeases.has(leaseKey)) {
      if(this.pageLeases.size>=128 || this.metrics.representationBytes+512>this.cacheBytes){
        this.metrics.capacityRejected++;
        return {status:503,code:'SYNC_CAPACITY_EXHAUSTED',retryAfterMs:1000};
      }
      this.pageLeases.set(leaseKey,{representation,expiresAt:this.now()+this.versionTtlMs});
      this.trim();
    }
    return {status:200,data};
  }
  conflict(code){this.metrics.conflicts++;return {status:409,code,manifest:this.manifest()};}
}
