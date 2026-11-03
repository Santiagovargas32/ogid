import {RUNTIME_POLICY} from '../config/runtimePolicy.js';

// Keep legacy checkpoints as recovery bases. Poll metadata changes on every
// check; article bodies and the retained corpus change independently. Store
// each body with its descriptor in the same transaction, without rewriting a
// large body merely to advance a validator, timestamp or cycle counter.
export class SqlRssCanonicalState {
  constructor(runtime){this.runtime=runtime;this.legacy=false;}
  load(){
    const current=this.runtime.load('rss-canonical-v2');
    const legacy=!current || current.legacy ? this.runtime.load('rss-canonical') : null;
    this.legacy=Boolean(legacy);
    const states={...(legacy?.states || {})};
    for(const row of this.runtime.db.prepare("SELECT kind,payload_json FROM runtime_snapshots WHERE kind GLOB 'rss-canonical-feed:*'").iterate()){
      const id=row.kind.slice('rss-canonical-feed:'.length),value=JSON.parse(row.payload_json);
      if(value.articlesExternal===true){
        const {articlesExternal:_external,...state}=value;
        const articles=this.runtime.load(`rss-canonical-feed-articles:${id}`);
        if(!Array.isArray(articles))throw Object.assign(Error('Missing durable RSS articles'),{code:'STORAGE_RSS_CHECKPOINT_INCOMPLETE'});
        states[id]={...state,articles};
      }else states[id]=value;
    }
    if(!current && !legacy && !Object.keys(states).length)return null;
    if(current?.corpusExternal===true){
      const {corpusExternal:_external,...summary}=current,corpus=this.runtime.load('rss-canonical-corpus:v3');
      if(!Array.isArray(corpus))throw Object.assign(Error('Missing durable RSS corpus'),{code:'STORAGE_RSS_CHECKPOINT_INCOMPLETE'});
      return {...legacy,...summary,corpus,states};
    }
    return {...legacy,...current,states};
  }
  async save(pipeline,selectedIds){
    const entries=selectedIds.map(id=>{
      const {articles,...state}=pipeline.states.get(id);
      return [[`rss-canonical-feed-articles:${id}`,articles],[`rss-canonical-feed:${id}`,{...state,articlesExternal:true}]];
    });
    // Retain the existing summary key and metrics for operational readers.
    entries.push([['rss-canonical-corpus:v3',pipeline.corpus],['rss-canonical-v2',{version:3,legacy:this.legacy,corpusExternal:true,metrics:pipeline.metrics}]]);
    for(let offset=0;offset<entries.length;){
      const started=performance.now();let bytes=0,rows=0;
      // One FULL commit per bounded page, rather than per polled feed. Nested
      // runtime saves remain savepoints on the same business writer.
      this.runtime.db.transaction(()=>{
        while(offset<entries.length){
          const group=entries[offset],size=group.reduce((n,[_kind,payload])=>n+Buffer.byteLength(JSON.stringify(payload)),0);
          if(rows&&(rows>=RUNTIME_POLICY.storage.commitBatchRows||bytes+size>RUNTIME_POLICY.storage.commitBatchBytes||performance.now()-started>=RUNTIME_POLICY.storage.commitBatchMs))break;
          for(const [kind,payload]of group)this.runtime.save(kind,payload);
          offset++;rows++;bytes+=size;
        }
      }).immediate();
      await new Promise(resolve=>setImmediate(resolve));
    }
  }
}
