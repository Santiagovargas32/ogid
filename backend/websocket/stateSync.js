import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// The journal contains invalidations, never historical facts. Facts remain in SQL.
export class StateSync {
  constructor(stateManager, { historyLimit = 256, pageChars = 8_000, cacheBytes = 64 * 1024 * 1024, versionTtlMs = 60000, retainedLimit = 16, now = Date.now } = {}) {
    this.stateManager = stateManager; this.epoch = randomUUID(); this.revision = 0;
    this.historyLimit = historyLimit; this.pageChars = pageChars; this.cacheBytes = cacheBytes;
    this.history = []; this.versions = {}; this.fingerprints = new Map(); this.references = new Map(); this.cache = new Map();this.serialized=new Map();
    Object.assign(this,{versionTtlMs,retainedLimit,now});this.retained=new Map();
    this.metrics = { retainedBytes:0,expiredVersions:0,serializations: 0, serializationMs: 0, httpBytes: 0 };
  }
  keys() { return this.stateManager.getSyncKeys?.() || Object.keys(this.stateManager.getSnapshot()).filter(k => !['admin','signalCorpus','marketSignalCorpus'].includes(k)); }
  manifest() { return { protocol: 2, epoch: this.epoch, revision: this.revision, resources: Object.fromEntries(this.keys().map(k => [k, this.versions[k] || 0])), snapshotUrl: '/api/intel/sync', changesUrl: '/api/intel/changes' }; }
  change(resources) {
    const keys = [...new Set(resources)].filter(k => this.keys().includes(k)).filter(key => {
      const value = this.stateManager.getSyncResource ? this.stateManager.getSyncResource(key) : this.stateManager.getSnapshot()[key];
      const started = performance.now();
      const encoded = JSON.stringify(value ?? null);
      const hash = createHash('sha256').update(encoded).digest('hex');
      this.metrics.serializations++; this.metrics.serializationMs += performance.now() - started;
      this.references.set(key, value);
      this.serialized.set(key,encoded);
      if (this.fingerprints.get(key) === hash) return false;
      this.fingerprints.set(key, hash); return true;
    });
    if (!keys.length){this.trim();return null;}
    const entry = { epoch: this.epoch, revision: ++this.revision, resources: {} };
    for (const key of keys) {
      const previous=this.versions[key] || 0,encoded=this.cache.get(key);
      if(encoded)this.retained.set(`${key}:${previous}`,{encoded,expiresAt:this.now()+this.versionTtlMs});
      this.versions[key] = this.revision; entry.resources[key] = this.revision; this.cache.delete(key);
    }
    this.trim();
    this.history.push(entry); if (this.history.length > this.historyLimit) this.history.shift();
    return entry;
  }
  changes(epoch, since) {
    if (epoch !== this.epoch || !Number.isSafeInteger(since) || since < 0 || since > this.revision || since < (this.history[0]?.revision || 1) - 1) {
      return { ...this.manifest(), resyncRequired: true };
    }
    const entries = this.history.filter(e => e.revision > since);
    return { epoch: this.epoch, revision: this.revision, resyncRequired: false, resources: Object.assign({}, ...entries.map(e => e.resources)) };
  }
  trim(){
    for(const [key,value]of this.retained)if(value.expiresAt<=this.now()){this.retained.delete(key);this.metrics.expiredVersions++;}
    const bytes=()=>[...this.cache.values(),...this.serialized.values(),...[...this.retained.values()].map(value=>value.encoded)].reduce((n,value)=>n+Math.max(Buffer.byteLength(value),value.length*2),0);
    while(this.serialized.size && bytes()>this.cacheBytes)this.serialized.delete(this.serialized.keys().next().value);
    while(this.retained.size>this.retainedLimit || (this.retained.size && bytes()>this.cacheBytes))this.retained.delete(this.retained.keys().next().value);
    while(this.cache.size && bytes()>this.cacheBytes)this.cache.delete(this.cache.keys().next().value);
    while(this.serialized.size && bytes()>this.cacheBytes)this.serialized.delete(this.serialized.keys().next().value);
    this.metrics.retainedBytes=[...this.retained.values()].reduce((n,value)=>n+Math.max(Buffer.byteLength(value.encoded),value.encoded.length*2),0);
  }
  page({ resource, epoch, revision, cursor = 0 }) {
    this.trim();
    if (!this.keys().includes(resource)) return { status: 404, code: 'SYNC_RESOURCE_UNKNOWN' };
    const current = this.versions[resource] || 0,requested=revision ?? current;
    if (epoch && epoch !== this.epoch) return { status: 409, code: 'SYNC_REVISION_EXPIRED', manifest: this.manifest() };
    if (!Number.isSafeInteger(cursor) || cursor < 0) return { status: 400, code: 'SYNC_CURSOR_INVALID' };
    let encoded=requested===current?this.cache.get(resource):this.retained.get(`${resource}:${requested}`)?.encoded;
    if(requested!==current && !encoded)return {status:409,code:'SYNC_REVISION_EXPIRED',manifest:this.manifest()};
    if (!encoded) {
      const started = performance.now();
      const value = this.stateManager.getSyncResource ? this.stateManager.getSyncResource(resource) : this.stateManager.getSnapshot()[resource];
      encoded = this.serialized.get(resource) ?? JSON.stringify(value ?? null);
      if(!this.serialized.has(resource)){this.metrics.serializations++; this.metrics.serializationMs += performance.now() - started;}
      if(Math.max(Buffer.byteLength(encoded),encoded.length*2)<=this.cacheBytes){this.cache.set(resource,encoded);this.trim();}
    }
    if (cursor > encoded.length) return { status: 400, code: 'SYNC_CURSOR_INVALID' };
    const end = Math.min(cursor + this.pageChars, encoded.length);
    const data = { epoch: this.epoch, revision: requested, resource, encoding: 'json-fragments-v1', cursor, nextCursor: end < encoded.length ? end : null, fragment: encoded.slice(cursor, end) };
    this.metrics.httpBytes += Buffer.byteLength(JSON.stringify(data));
    return { status: 200, data };
  }
}
