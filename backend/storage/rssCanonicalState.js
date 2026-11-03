import {RUNTIME_POLICY} from '../config/runtimePolicy.js';
import {yieldOperationResources} from '../services/shared/operationContext.js';
import {SqlRssArticles} from './rssArticles.js';

// Keep legacy checkpoints as recovery bases. Poll metadata changes on every
// check; article bodies and the retained corpus change independently. Store
// each body with its descriptor in the same transaction, without rewriting a
// large body merely to advance a validator, timestamp or cycle counter.
export class SqlRssCanonicalState {
  constructor(runtime){this.runtime=runtime;this.articles=runtime.rssArticles || new SqlRssArticles(runtime);this.legacy=false;}
  load(){
    return this.runtime.db.transaction(()=>this.read()).deferred();
  }
  read(){
    const current=this.runtime.load('rss-canonical-v2');
    const legacy=!current || current.legacy ? this.runtime.load('rss-canonical') : null;
    this.legacy=Boolean(legacy);
    const states={...(legacy?.states || {})};
    for(const row of this.runtime.db.prepare("SELECT kind,payload_json FROM runtime_snapshots WHERE kind GLOB 'rss-canonical-feed:*'").iterate()){
      const id=row.kind.slice('rss-canonical-feed:'.length),value=JSON.parse(row.payload_json);
      if(value.articlesExternal===true){
        const {articlesExternal:_external,...state}=value;
        const articles=this.articles.load(this.runtime.load(`rss-canonical-feed-articles:${id}`));
        states[id]={...state,articles};
      }else states[id]=value;
    }
    if(!current && !legacy && !Object.keys(states).length)return null;
    if(current?.corpusExternal===true){
      const {corpusExternal:_external,...summary}=current,corpus=this.articles.load(this.runtime.load('rss-canonical-corpus:v3'));
      return {...legacy,...summary,corpus,states};
    }
    return {...legacy,...current,states};
  }
  async save(pipeline,selectedIds){
    // Capture every input before yielding: another cooperative operation may
    // update an in-memory snapshot while its immutable bodies are staged.
    const captured=selectedIds.map(id=>{
      const {articles,...state}=pipeline.states.get(id);
      return {id,state:structuredClone(state),articles:this.articles.capture(articles)};
    });
    const corpus=this.articles.capture(pipeline.corpus),metrics=structuredClone(pipeline.metrics),entries=[];
    for(const {id,state,articles}of captured){
      const descriptor=await this.articles.stage(articles);
      entries.push([[`rss-canonical-feed-articles:${id}`,descriptor],[`rss-canonical-feed:${id}`,{...state,articlesExternal:true}]]);
    }
    // Retain the existing summary key and metrics for operational readers.
    entries.push([['rss-canonical-corpus:v3',await this.articles.stage(corpus)],['rss-canonical-v2',{version:3,legacy:this.legacy,corpusExternal:true,metrics}]]);
    for(let offset=0;offset<entries.length;){
      await yieldOperationResources();
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
