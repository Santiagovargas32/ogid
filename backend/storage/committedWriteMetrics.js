// Fixed labels only: no SQL bindings, article IDs, provider data or unbounded
// snapshot keys enter telemetry. Bytes describe bindings, not disk/WAL writes.
const tables=new Set(['articles','article_revisions','article_observations','article_sources','article_aliases','article_countries','article_instruments','article_topics','article_permitted_excerpts','sources','runtime_meta','pipeline_checkpoints','pipeline_stage_state','candles','candle_validations','event_outbox','geopolitical_alerts','awareness_events']);
const snapshots=new Map([
 ['provider-quota','provider-quota'],['rss','rss-public'],['rss-canonical','rss-legacy'],
 ['rss-canonical-v2','rss-summary'],['rss-canonical-corpus:v3','rss-corpus'],['pipeline-stage','pipeline-stage'],
]);
export function writeMetricBucket(table,args){
 if(table==='runtime_snapshots'){
  const kind=String(args[0]||'');
  const bucket=snapshots.get(kind)||(kind.startsWith('rss-article:')?'rss-body':kind.startsWith('rss-canonical-feed-articles:')?'rss-feed-articles':kind.startsWith('rss-canonical-feed:')?'rss-feed':'other');
  return 'snapshot:'+bucket;
 }
 if(table?.startsWith('news_comparison_'))return 'news-comparisons';
 return tables.has(table)?table:'other';
}
const empty=()=>({transactions:0,statements:0,rowsChanged:0,bindingBytes:0,largestBindingBytes:0});
export function mergeWrites(target,source){
 for(const [bucket,value]of source||[]){
  const prior=target.get(bucket)||{statements:0,rowsChanged:0,bindingBytes:0,largestBindingBytes:0};
  prior.statements+=value.statements;prior.rowsChanged+=value.rowsChanged;prior.bindingBytes+=value.bindingBytes;
  prior.largestBindingBytes=Math.max(prior.largestBindingBytes,value.largestBindingBytes);target.set(bucket,prior);
 }
 return target;
}
export class CommittedWriteMetrics{
 constructor(){this.total=empty();this.buckets=new Map();this.lastCommittedAt=null;}
 committed(writes){
  if(!writes?.size)return;
  const combined={statements:0,rowsChanged:0,bindingBytes:0,largestBindingBytes:0};
  for(const [bucket,value]of writes){
   const row=this.buckets.get(bucket)||empty();row.transactions++;
   for(const field of ['statements','rowsChanged','bindingBytes']){row[field]+=value[field];combined[field]+=value[field];}
   row.largestBindingBytes=Math.max(row.largestBindingBytes,value.largestBindingBytes);
   combined.largestBindingBytes=Math.max(combined.largestBindingBytes,value.largestBindingBytes);this.buckets.set(bucket,row);
  }
  this.total.transactions++;
  for(const field of ['statements','rowsChanged','bindingBytes'])this.total[field]+=combined[field];
  this.total.largestBindingBytes=Math.max(this.total.largestBindingBytes,combined.largestBindingBytes);this.lastCommittedAt=new Date().toISOString();
 }
 status(){return {scope:'committed instrumented run statements; logical binding bytes, excluding triggers/indexes/physical I/O; bucket transaction counts can overlap',lastCommittedAt:this.lastCommittedAt,total:{...this.total},buckets:Object.fromEntries([...this.buckets].map(([key,value])=>[key,{...value}]))};}
}
