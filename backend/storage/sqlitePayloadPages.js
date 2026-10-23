import {RUNTIME_POLICY} from '../config/runtimePolicy.js';
// Versioned, byte-bounded payload reads shared by immutable news and candle windows.
export class PayloadCache {
  constructor(maxBytes=64*1024*1024){if(!Number.isSafeInteger(maxBytes) || maxBytes<0)throw Error('Invalid news payload cache budget');this.maxBytes=maxBytes;this.rows=new Map();this.bytes=0;this.hits=0;this.misses=0;this.evictions=0;}
  key(table,row){
    if(row.revision===undefined || (table==='articles' && row.last_seen_at===undefined))return null;
    return JSON.stringify([table,row.rowid,row.revision,row.last_seen_at ?? row.fetched_at ?? null]);
  }
  get(key){
    const item=key && this.rows.get(key);if(!item){this.misses++;return undefined;}
    this.rows.delete(key);this.rows.set(key,item);this.hits++;return item.payload;
  }
  set(key,payload){
    if(!key || typeof payload!=='string')return;
    const bytes=Math.max(Buffer.byteLength(payload),payload.length*2)+key.length*2+256;
    if(bytes>this.maxBytes)return;
    const previous=this.rows.get(key);if(previous){this.bytes-=previous.bytes;this.rows.delete(key);}
    while(this.bytes+bytes>this.maxBytes){const oldest=this.rows.keys().next().value;this.bytes-=this.rows.get(oldest).bytes;this.rows.delete(oldest);this.evictions++;}
    this.rows.set(key,{payload,bytes});this.bytes+=bytes;
  }
  status(){return {hits:this.hits,misses:this.misses,evictions:this.evictions,bytes:this.bytes,maxBytes:this.maxBytes,items:this.rows.size};}
  clear(){this.rows.clear();this.bytes=0;}
}

// Resolve frozen references first. Within a bounded page, SQLite fetches payload
// pages by rowid, then consumers retain the original semantic order. Cold disks
// no longer seek across the archive in publication/headline order.
export function* physicalPages(reader,table,references,cache=null){
  const read=reader.prepare(`SELECT rowid,payload_json FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?)) ORDER BY rowid`);
  const one=reader.prepare(`SELECT payload_json FROM ${table} WHERE rowid=?`);
  function* resolve(page){
    const payloads=new Map(),missing=[];
    for(const row of page){const payload=cache?.get(cache.key(table,row));if(payload===undefined)missing.push(row);else payloads.set(row.rowid,payload);}
    if(missing.length){
      let bytes=0;
      for(const row of read.iterate(JSON.stringify(missing.map(row=>row.rowid)))){
        const size=Math.max(Buffer.byteLength(row.payload_json),row.payload_json.length*2);
        if(bytes+size>RUNTIME_POLICY.storage.readPageBytes)break;
        payloads.set(row.rowid,row.payload_json);bytes+=size;
      }
      // Oversized pages fall back to individual rows within the SAME read
      // transaction. No result is truncated to satisfy the memory budget.
      for(const row of missing)if(payloads.has(row.rowid))cache?.set(cache.key(table,row),payloads.get(row.rowid));
    }
    for(const ref of page){
      const payload=payloads.has(ref.rowid)?payloads.get(ref.rowid):one.get(ref.rowid)?.payload_json;
      yield {...ref,payload_json:payload};
    }
  }
  let page=[];
  for(const ref of references){page.push(ref);if(page.length===RUNTIME_POLICY.storage.readPageRows){yield* resolve(page);page=[];}}
  if(page.length)yield* resolve(page);
}

