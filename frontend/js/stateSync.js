export function validSyncManifest(value) {
  return Boolean(value && value.protocol===2 && typeof value.epoch==='string' && value.epoch.length>0 && value.epoch.length<=160 &&
    Number.isSafeInteger(value.revision) && value.revision>=0 && value.resources && typeof value.resources==='object' && !Array.isArray(value.resources) &&
    Object.keys(value.resources).length<=64 && Object.entries(value.resources).every(([key,revision])=>
      /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key) && !['constructor','prototype'].includes(key) && Number.isSafeInteger(revision) && revision>=0 && revision<=value.revision));
}
// Each tab owns one single-flight synchronizer and an explicit cursor per resource.
export class StateSynchronizer {
  constructor({ api, onUpdate, onStatus = () => {},profile=null,getFilters=()=>({}),onHydrate=()=>{} }) {
    this.api = api; this.onUpdate = onUpdate; this.onStatus = onStatus;
    this.epoch = null; this.applied = {}; this.target = {}; this.revision = 0;
    this.task = null; this.timer = null; this.closed = false; this.failures = 0;
    this.controller = new AbortController();this.generation=0;
    this.conflicts=new Map();this.blockedUntil=new Map();this.manifestTask=null;this.bootstrapTask=null;
    Object.assign(this,{profile,getFilters,onHydrate});this.compactTask=null;this.compactKey=null;
  }
  accept(message) {
    if(this.closed)return;
    const raw = message.data || {};
    const advertised=this.profile?raw.profiles?.[this.profile]:null;
    const data=advertised?{...raw,resources:advertised.resources}:raw;
    if (!data.epoch) return;
    if (this.epoch !== data.epoch) {
      if(this.epoch)this.controller.abort(); this.controller = new AbortController();
      this.epoch = data.epoch; this.applied = {}; this.target = {}; this.revision = 0;
      this.conflicts.clear();this.blockedUntil.clear();
    }
    for(const [resource,revision] of Object.entries(data.resources || {})){
      if(Number.isSafeInteger(revision) && revision>=0)this.target[resource]=Math.max(this.target[resource] ?? 0,revision);
    }
    this.revision = Math.max(this.revision, data.revision || 0);
    if(this.profile && this.lastHydration && !Object.keys(this.target).some(key=>this.applied[key]!==this.target[key]))return;
    this.drain();
  }
  async requestSnapshot({signal}={}) {
    if(this.closed)return;
    if(this.bootstrapTask)return this.bootstrapTask;
    this.bootstrapTask=this.loadSnapshot(signal).finally(()=>{this.bootstrapTask=null;});
    return this.bootstrapTask;
  }
  async loadSnapshot(signal) {
    if(this.profile){await this.syncCompact(signal || this.controller.signal);if(this.profile)return;}
    const previousEpoch=this.epoch;
    const manifest=await this.api.getSyncSnapshot({}, {signal:signal || this.controller.signal});
    if(this.closed)return;
    // A delayed HTTP reply must not undo a backend restart already announced by WS.
    if(this.epoch !== previousEpoch && this.epoch && manifest.epoch !== this.epoch)return this.task;
    this.accept({type:'resync:required:v2',data:manifest});
    return this.task;
  }
  async syncCompact(signal) {
    const filters=this.getFilters(),key=JSON.stringify(filters),previousEpoch=this.epoch,generation=this.generation;
    if(!this.compactTask || this.compactKey!==key){
      this.compactKey=key;
      const task=this.api.getDashboardBootstrap(filters,{signal});
      this.compactTask=task;
      task.finally(()=>{if(this.compactTask===task)this.compactTask=null;}).catch(()=>{});
    }
    let payload;
    try{payload=await this.compactTask;}catch(error){
      if(error.status===404 || ['SYNC_PROFILE_UNKNOWN','DASHBOARD_BUDGET_EXCEEDED'].includes(error.code)){
        this.profile=null;this.applied={};this.target={};this.lastHydration=null;return;
      }
      throw error;
    }
    if(this.closed || generation!==this.generation || key!==JSON.stringify(this.getFilters()))return;
    if(this.epoch!==previousEpoch && this.epoch && payload.epoch!==this.epoch)return;
    if(payload.profile!==this.profile || payload.protocol!==1 || !validSyncManifest({...payload,protocol:2}))throw Error('Invalid dashboard bootstrap');
    if(this.epoch && payload.epoch!==this.epoch){this.applied={};this.target={};}
    this.epoch=payload.epoch;
    for(const [resource,revision]of Object.entries(payload.resources))this.target[resource]=Math.max(this.target[resource]||0,revision);
    if(Object.entries(payload.resources).some(([resource,revision])=>(this.applied[resource]||0)>revision))return;
    const signature=JSON.stringify([payload.epoch,payload.resources,payload.analysis,key]);
    if(this.lastHydration!==signature){this.onHydrate(payload);this.onUpdate(payload.data);this.lastHydration=signature;}
    Object.assign(this.applied,payload.resources);
    if(Object.keys(this.target).every(resource=>this.applied[resource]===this.target[resource]))this.onStatus('synchronized');
  }
  recoverManifest(details,signal) {
    if(validSyncManifest(details))return Promise.resolve(details);
    if(!this.manifestTask)this.manifestTask=this.api.getSyncSnapshot({}, {signal}).finally(()=>{this.manifestTask=null;});
    return this.manifestTask;
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
    if(this.profile){await this.syncCompact(this.controller.signal);if(this.profile)return;}
    while (!this.closed) {
      const epoch = this.epoch, signal = this.controller.signal;
      const pending=Object.keys(this.target).filter(k=>this.applied[k]!==this.target[k]);
      if (!pending.length) { this.failures = 0; this.onStatus('synchronized'); return; }
      const keys=pending.filter(key=>(this.blockedUntil.get(key)||0)<=Date.now());
      if(!keys.length){
        const delay=Math.max(1,Math.min(...pending.map(key=>this.blockedUntil.get(key)||Date.now()))-Date.now());
        this.timer=setTimeout(()=>{this.timer=null;this.drain();},delay);return;
      }
      let update = {}, versions = {};
      for (const resource of keys) {
        const revision = this.target[resource]; let cursor = 0; const fragments = [];
        try {
          do {
            const page = await this.api.getSyncSnapshot({ resource, epoch, revision, cursor }, { signal });
            if (page.epoch !== epoch || page.revision !== revision || page.cursor !== cursor || typeof page.fragment!=='string' ||
                (page.nextCursor!==null && (!Number.isSafeInteger(page.nextCursor)||page.nextCursor<=cursor))) throw new Error('Invalid synchronization page');
            fragments.push(page.fragment); cursor = page.nextCursor;
            this.onStatus('progress');
          } while (cursor !== null && !signal.aborted);
          if (signal.aborted || epoch !== this.epoch) return;
          update[resource] = JSON.parse(fragments.join('')); versions[resource] = revision;
          this.conflicts.delete(resource);this.blockedUntil.delete(resource);
        } catch (error) {
          if (epoch !== this.epoch) return;
          if (error.status === 409) {
            // Resources are independently versioned, as in WS partial updates.
            // Never discard an already complete resource because a later one
            // changed. No fragment or partially decoded resource is published.
            if(Object.keys(versions).length){this.onUpdate(update);Object.assign(this.applied,versions);}
            update={};versions={};
            const count=(this.conflicts.get(resource)||0)+1;this.conflicts.set(resource,count);
            if(count>=2)this.blockedUntil.set(resource,Date.now()+Math.min(2000,500*2**Math.min(count-2,2))*(.5+Math.random()*.5));
            const manifest = await this.recoverManifest(error.details,signal);
            this.accept({ data: manifest });
            if(epoch!==this.epoch)return;
            continue;
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
