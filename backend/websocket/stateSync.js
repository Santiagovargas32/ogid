import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// The journal contains invalidations, never historical facts. Facts remain in SQL.
export class StateSync {
  constructor(stateManager, { historyLimit = 256, pageChars = 8_000, cacheBytes = 64 * 1024 * 1024 } = {}) {
    this.stateManager = stateManager; this.epoch = randomUUID(); this.revision = 0;
    this.historyLimit = historyLimit; this.pageChars = pageChars; this.cacheBytes = cacheBytes;
    this.history = []; this.versions = {}; this.fingerprints = new Map(); this.references = new Map(); this.cache = new Map();
    this.metrics = { serializations: 0, serializationMs: 0, httpBytes: 0 };
  }
  keys() { return this.stateManager.getSyncKeys?.() || Object.keys(this.stateManager.getSnapshot()).filter(k => !['admin','signalCorpus','marketSignalCorpus'].includes(k)); }
  manifest() { return { protocol: 2, epoch: this.epoch, revision: this.revision, resources: Object.fromEntries(this.keys().map(k => [k, this.versions[k] || 0])), snapshotUrl: '/api/intel/sync', changesUrl: '/api/intel/changes' }; }
  change(resources) {
    const keys = [...new Set(resources)].filter(k => this.keys().includes(k)).filter(key => {
      const value = this.stateManager.getSyncResource?.(key);
      if (value !== undefined && this.references.get(key) === value && this.fingerprints.has(key)) return false;
      const started = performance.now();
      const encoded = JSON.stringify(value ?? this.stateManager.getSnapshot()[key] ?? null);
      const hash = createHash('sha256').update(encoded).digest('hex');
      this.metrics.serializations++; this.metrics.serializationMs += performance.now() - started;
      this.references.set(key, value);
      if (this.fingerprints.get(key) === hash) return false;
      this.fingerprints.set(key, hash); return true;
    });
    if (!keys.length) return null;
    const entry = { epoch: this.epoch, revision: ++this.revision, resources: {} };
    for (const key of keys) { this.versions[key] = this.revision; entry.resources[key] = this.revision; this.cache.delete(key); }
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
  page({ resource, epoch, revision, cursor = 0 }) {
    if (!this.keys().includes(resource)) return { status: 404, code: 'SYNC_RESOURCE_UNKNOWN' };
    const current = this.versions[resource] || 0;
    if ((epoch && epoch !== this.epoch) || (revision !== undefined && revision !== current)) return { status: 409, code: 'SYNC_REVISION_EXPIRED', manifest: this.manifest() };
    if (!Number.isSafeInteger(cursor) || cursor < 0) return { status: 400, code: 'SYNC_CURSOR_INVALID' };
    let encoded = this.cache.get(resource);
    if (!encoded) {
      const started = performance.now();
      const value = this.stateManager.getSyncResource?.(resource) ?? this.stateManager.getSnapshot()[resource];
      encoded = JSON.stringify(value ?? null);
      this.metrics.serializations++; this.metrics.serializationMs += performance.now() - started;
      // Cache is a bounded performance optimization, not a capacity limit on facts.
      const bytes = Buffer.byteLength(encoded);
      if (bytes <= this.cacheBytes) {
        while ([...this.cache.values()].reduce((n,s) => n + Buffer.byteLength(s), 0) + bytes > this.cacheBytes) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(resource, encoded);
      }
    }
    if (cursor > encoded.length) return { status: 400, code: 'SYNC_CURSOR_INVALID' };
    const end = Math.min(cursor + this.pageChars, encoded.length);
    const data = { epoch: this.epoch, revision: current, resource, encoding: 'json-fragments-v1', cursor, nextCursor: end < encoded.length ? end : null, fragment: encoded.slice(cursor, end) };
    this.metrics.httpBytes += Buffer.byteLength(JSON.stringify(data));
    return { status: 200, data };
  }
}
