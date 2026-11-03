import {createHash} from 'node:crypto';
import {RUNTIME_POLICY} from '../config/runtimePolicy.js';
import {checkOperation,committedOperationItems,yieldOperationResources} from '../services/shared/operationContext.js';

const version='ogid-rss-articles-v1',prefix='rss-article:v4:';
const refPrefix='rss-article-refs:v4:';
const sha=value=>createHash('sha256').update(value).digest('hex');
const incomplete=()=>Object.assign(Error('Incomplete durable RSS articles'),{code:'STORAGE_RSS_CHECKPOINT_INCOMPLETE'});

// Immutable article bodies are shared by feed, corpus and public descriptors.
// Stage bounded FULL commits first; publishing the descriptor remains atomic.
// A failed/cancelled stage leaves the previous checkpoint readable. Unreferenced
// staged bodies are harmless and reusable after restart, never an acknowledged
// acquisition or a second business writer.
export class SqlRssArticles {
  constructor(runtime){
    this.runtime=runtime;this.epoch=runtime.db.prepare('SELECT 1 FROM runtime_snapshots WHERE kind GLOB ? LIMIT 1').get(prefix+'*')?1:0;
    this.prunedEpoch=0;this.cursor=null;
  }
  get needsPrune(){return this.cursor!==null||this.epoch!==this.prunedEpoch;}
  recordReferences(kind,payload){
    const owner=kind==='rss'||kind==='rss-canonical-corpus:v3'||kind.startsWith('rss-canonical-feed-articles:');
    if(!owner)return;
    const db=this.runtime.db,row=db.prepare('SELECT payload_json FROM runtime_snapshots WHERE kind=?').get(kind),old=row?JSON.parse(row.payload_json):null;
    const descriptor=value=>kind==='rss'?value?.items:value;
    const previous=descriptor(old),next=descriptor(payload);
    const refs=value=>{
      if(value?.version!==version)return new Set();
      if(!Array.isArray(value.refs)||!value.refs.every(key=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key)))throw incomplete();
      return new Set(value.refs);
    };
    const before=refs(previous),after=refs(next);
    const read=db.prepare('SELECT value_json FROM runtime_meta WHERE key=?'),write=db.prepare('INSERT INTO runtime_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json');
    const exists=db.prepare('SELECT 1 FROM runtime_snapshots WHERE kind=?');
    for(const key of new Set([...before,...after])){
      if(before.has(key)===after.has(key))continue;
      const record=read.get(refPrefix+key),count=record?JSON.parse(record.value_json):0,delta=after.has(key)?1:-1;
      if(!Number.isSafeInteger(count)||count<0||count+delta<0||!exists.get(prefix+key))throw incomplete();
      write.run(refPrefix+key,JSON.stringify(count+delta));this.epoch++;
    }
  }
  capture(articles){
    if(!Array.isArray(articles))throw incomplete();
    const bodies=new Map(),refs=[],digest=createHash('sha256');digest.update('[');
    for(const article of articles){
      const payload=JSON.stringify(article)??'null',key=sha(payload);
      if(refs.length)digest.update(',');digest.update(payload);refs.push(key);bodies.set(key,payload);
    }
    digest.update(']');
    return {descriptor:{version,refs,sha256:digest.digest('hex')},bodies};
  }
  async stage(captured){
    const db=this.runtime.db,entries=[...captured.bodies],missing=[];
    const present=db.prepare('SELECT kind FROM runtime_snapshots WHERE kind IN (SELECT value FROM json_each(?))');
    for(let offset=0;offset<entries.length;offset+=RUNTIME_POLICY.storage.readPageRows){
      const page=entries.slice(offset,offset+RUNTIME_POLICY.storage.readPageRows);
      const known=new Set(present.all(JSON.stringify(page.map(([key])=>prefix+key))).map(row=>row.kind));
      missing.push(...page.filter(([key])=>!known.has(prefix+key)));
    }
    for(let offset=0;offset<missing.length;){
      await yieldOperationResources();checkOperation();
      const start=offset,started=performance.now();let bytes=0;
      db.transaction(()=>{
        while(offset<missing.length){
          const [key,payload]=missing[offset],size=Buffer.byteLength(payload);
          if(offset>start&&(offset-start>=RUNTIME_POLICY.storage.commitBatchRows||bytes+size>RUNTIME_POLICY.storage.commitBatchBytes||performance.now()-started>=RUNTIME_POLICY.storage.commitBatchMs))break;
          this.runtime.save(prefix+key,JSON.parse(payload));offset++;bytes+=size;
        }
      }).immediate();
      this.epoch++;
      committedOperationItems(offset-start);
      await new Promise(resolve=>setImmediate(resolve));
    }
    captured.bodies.clear();return captured.descriptor;
  }
  // Called only by the writer's quiescent maintenance lane, after acquisition
  // commands have finished staging. Readers pin a consistent SQLite snapshot.
  // Reference changes share the descriptor transaction; zero-reference cache
  // bodies, including abandoned stages, can then be removed in bounded pages.
  // Historical article facts/revisions and legacy recovery bases are untouched.
  prune({limit=RUNTIME_POLICY.storage.readPageRows,budgetMs=RUNTIME_POLICY.storage.maintenancePageMs}={}){
    if(!this.needsPrune)return {hasMore:false,processed:0,removed:0};
    if(this.cursor===null){this.cursor='';this.passEpoch=this.epoch;}
    const db=this.runtime.db,rows=db.prepare('SELECT kind,length(CAST(payload_json AS BLOB)) bytes FROM runtime_snapshots WHERE kind GLOB ? AND kind>? ORDER BY kind LIMIT ?').all(prefix+'*',this.cursor,limit);
    const read=db.prepare('SELECT value_json FROM runtime_meta WHERE key=?'),removeBody=db.prepare('DELETE FROM runtime_snapshots WHERE kind=?'),removeCount=db.prepare('DELETE FROM runtime_meta WHERE key=?');
    let processed=0,removed=0,bytes=0,cursor=this.cursor;const started=performance.now();
    db.transaction(()=>{
      for(const {kind,bytes:size}of rows){
        const key=refPrefix+kind.slice(prefix.length),row=read.get(key),count=row?JSON.parse(row.value_json):0;
        if(!Number.isSafeInteger(count)||count<0)throw incomplete();
        if(count===0){
          if(removed&&(removed>=RUNTIME_POLICY.storage.commitBatchRows||bytes+size>RUNTIME_POLICY.storage.commitBatchBytes))break;
          removeBody.run(kind);removeCount.run(key);removed++;bytes+=size;
        }
        cursor=kind;processed++;if(performance.now()-started>=budgetMs)break;
      }
    }).immediate();
    this.cursor=cursor;
    if(processed===rows.length&&rows.length<limit){this.cursor=null;this.prunedEpoch=this.passEpoch;}
    return {hasMore:this.needsPrune,processed,removed};
  }
  load(value){
    if(Array.isArray(value))return value;
    if(value?.version!==version||!Array.isArray(value.refs)||!value.refs.every(key=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key))||!/^[a-f0-9]{64}$/.test(value.sha256||''))throw incomplete();
    const read=this.runtime.db.prepare('SELECT payload_json FROM runtime_snapshots WHERE kind=?'),seen=new Map(),articles=[],digest=createHash('sha256');digest.update('[');
    for(const key of value.refs){
      let payload=seen.get(key);
      if(payload===undefined){payload=read.get(prefix+key)?.payload_json;if(typeof payload!=='string'||sha(payload)!==key)throw incomplete();seen.set(key,payload);}
      if(articles.length)digest.update(',');digest.update(payload);articles.push(JSON.parse(payload));
    }
    digest.update(']');if(digest.digest('hex')!==value.sha256)throw incomplete();return articles;
  }
}
