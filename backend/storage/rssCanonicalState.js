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
    for(const id of selectedIds){
      this.runtime.save(`rss-canonical-feed:${id}`,pipeline.states.get(id));
      await new Promise(resolve=>setImmediate(resolve));
    }
    this.runtime.save('rss-canonical-v2',{version:2,legacy:this.legacy,corpus:pipeline.corpus,metrics:pipeline.metrics});
  }
}
