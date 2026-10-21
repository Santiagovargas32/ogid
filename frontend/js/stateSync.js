// Each tab owns one single-flight synchronizer and an explicit cursor per resource.
export class StateSynchronizer {
  constructor({ api, onUpdate, onStatus = () => {} }) {
    this.api = api; this.onUpdate = onUpdate; this.onStatus = onStatus;
    this.epoch = null; this.applied = {}; this.target = {}; this.revision = 0;
    this.task = null; this.timer = null; this.closed = false; this.failures = 0;
    this.controller = new AbortController();this.generation=0;
  }
  accept(message) {
    if(this.closed)return;
    if(message.type === "ws:ready:v2" || message.type === "resync:required:v2"){clearTimeout(this.timer);this.timer=null;this.failures=0;}
    const data = message.data || {};
    if (!data.epoch) return;
    if (this.epoch !== data.epoch) {
      this.controller.abort(); this.controller = new AbortController();
      this.epoch = data.epoch; this.applied = {}; this.target = {}; this.revision = 0;
    }
    for(const [resource,revision] of Object.entries(data.resources || {})){
      if(Number.isSafeInteger(revision) && revision>=0)this.target[resource]=Math.max(this.target[resource] ?? 0,revision);
    }
    this.revision = Math.max(this.revision, data.revision || 0);
    this.drain();
  }
  async requestSnapshot({signal}={}) {
    if(this.closed)return;
    const previousEpoch=this.epoch;
    const manifest=await this.api.getSyncSnapshot({}, {signal:signal || this.controller.signal});
    if(this.closed)return;
    // A delayed HTTP reply must not undo a backend restart already announced by WS.
    if(this.epoch !== previousEpoch && this.epoch && manifest.epoch !== this.epoch)return this.task;
    this.accept({type:'resync:required:v2',data:manifest});
    return this.task;
  }
  drain() {
    if (this.closed || this.task || this.timer) return this.task;
    const generation=this.generation;
    this.task = this.sync().catch(error => {
      if (this.closed || generation!==this.generation) return;
      this.onStatus('degraded', error);
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, this.failures++)) * (.5 + Math.random() * .5);
      this.timer = setTimeout(() => { this.timer = null; this.drain(); }, delay);
    }).finally(() => {
      this.task = null;
      if (!this.timer && !this.closed && Object.keys(this.target).some(k => this.applied[k] !== this.target[k])) this.drain();
    });
    return this.task;
  }
  async sync() {
    this.onStatus('syncing');
    while (!this.closed) {
      const epoch = this.epoch, signal = this.controller.signal;
      const keys = Object.keys(this.target).filter(k => this.applied[k] !== this.target[k]);
      if (!keys.length) { this.failures = 0; this.onStatus('synchronized'); return; }
      const update = {}, versions = {};
      for (const resource of keys) {
        const revision = this.target[resource]; let cursor = 0; const fragments = [];
        try {
          do {
            const page = await this.api.getSyncSnapshot({ resource, epoch, revision, cursor }, { signal });
            if (page.epoch !== epoch || page.revision !== revision || page.cursor !== cursor) throw new Error('Invalid synchronization page');
            fragments.push(page.fragment); cursor = page.nextCursor;
          } while (cursor !== null && !signal.aborted);
          if (signal.aborted || epoch !== this.epoch) return;
          update[resource] = JSON.parse(fragments.join('')); versions[resource] = revision;
        } catch (error) {
          if (epoch !== this.epoch) return;
          if (error.status === 409) {
            // Resources are independently versioned, as in WS partial updates.
            // Never discard an already complete resource because a later one
            // changed. No fragment or partially decoded resource is published.
            if(Object.keys(versions).length){this.onUpdate(update);Object.assign(this.applied,versions);}
            const manifest = await this.api.getSyncSnapshot({}, { signal });
            this.accept({ data: manifest }); return;
          }
          throw error;
        }
      }
      if (epoch !== this.epoch || signal.aborted) return;
      this.onUpdate(update); Object.assign(this.applied, versions);
    }
  }
  close() { this.closed = true;this.generation++; clearTimeout(this.timer);this.timer=null; this.controller.abort(); }
  resume(){
    if(!this.closed)return;
    this.closed=false;this.controller=new AbortController();this.applied={};this.failures=0;
    void this.requestSnapshot().catch(error=>{this.onStatus('degraded',error);this.drain();});
  }
}
