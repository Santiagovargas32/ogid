import {RUNTIME_POLICY} from '../config/runtimePolicy.js';

// Keep the original checkpoint as a recovery base. New cycles update only the
// feeds they polled, instead of rewriting every cached article in every feed.
export class SqlRssCanonicalState {
  constructor(runtime){this.runtime=runtime;this.legacy=false;}
  load(){
    const current=this.runtime.load('rss-canonical-v2');
    const legacy=!current || current.legacy ? this.runtime.load('rss-canonical') : null;
    this.legacy=Boolean(legacy);
    const states={...(legacy?.states || {})};
    for(const row of this.runtime.db.prepare("SELECT kind,payload_json FROM runtime_snapshots WHERE kind GLOB 'rss-canonical-feed:*'").iterate())states[row.kind.slice('rss-canonical-feed:'.length)]=JSON.parse(row.payload_json);
    return current || legacy || Object.keys(states).length ? {...legacy,...current,states} : null;
  }
  async save(pipeline,selectedIds){
    const entries=selectedIds.map(id=>[`rss-canonical-feed:${id}`,pipeline.states.get(id)]);
    entries.push(['rss-canonical-v2',{version:2,legacy:this.legacy,corpus:pipeline.corpus,metrics:pipeline.metrics}]);
    for(let offset=0;offset<entries.length;){
      const started=performance.now();let bytes=0,rows=0;
      // One FULL commit per bounded page, rather than per polled feed. Nested
      // runtime saves remain savepoints on the same business writer.
      this.runtime.db.transaction(()=>{
        while(offset<entries.length){
          const [kind,payload]=entries[offset],size=Buffer.byteLength(JSON.stringify(payload));
          if(rows&&(rows>=RUNTIME_POLICY.storage.commitBatchRows||bytes+size>RUNTIME_POLICY.storage.commitBatchBytes||performance.now()-started>=RUNTIME_POLICY.storage.commitBatchMs))break;
          this.runtime.save(kind,payload);offset++;rows++;bytes+=size;
        }
      }).immediate();
      await new Promise(resolve=>setImmediate(resolve));
    }
  }
}
