const ranks={critical:4,elevated:3,monitoring:2,low:1,unknown:0};
export const newsIdentity=a=>String(a.identity||a.id||a.url||'');
export const newsContentRevision=a=>JSON.stringify([a.title,a.excerpt||a.description,a.publishedAt,a.updatedAt,a.threatLevel,a.publisher,a.sourceName,a.provenance?.stale]);
export function compareNews(a,b,order='critical'){return (order==='recent'?0:(ranks[b.threatLevel]||0)-(ranks[a.threatLevel]||0))||(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0)||newsIdentity(a).localeCompare(newsIdentity(b));}
export function filterNews(items,{q='',severity='',countries=[],order='critical',page=1,pageSize=40,windowHours=36,now=Date.now()}={}) {
  const cutoff=windowHours?now-windowHours*3600_000:null;
  const filtered=items.filter(a=>!countries.length||(a.countryMentions||[]).some(c=>countries.includes(c)))
    .filter(a=>!severity||(a.threatLevel||'unknown')===severity)
    .filter(a=>!q||`${a.title||''} ${a.excerpt||a.description||''} ${a.publisher||a.sourceName||''}`.toLowerCase().includes(q.toLowerCase()))
    .filter(a=>cutoff===null||(Date.parse(a.publishedAt||a.firstSeenAt||a.receivedAt)||0)>=cutoff).sort((a,b)=>compareNews(a,b,order));
  return {total:filtered.length,pages:Math.max(1,Math.ceil(filtered.length/pageSize)),items:filtered.slice((page-1)*pageSize,page*pageSize)};
}
export class NewsSelectionTracker {
  constructor({maxSeen=10000,retentionMs=48*3600_000,now=Date.now,baseline=null}={}){this.maxSeen=maxSeen;this.retentionMs=retentionMs;this.now=now;this.seen=new Map((baseline||[]).filter(([,time])=>now()-time<=retentionMs).slice(-maxSeen));this.initialized=Boolean(baseline)&&(!baseline.length||this.seen.size>0);this.previous=new Map();this.revision=null;}
  observe(items,revision){
    if(revision&&revision===this.revision)return {newIds:[],updatedIds:[]};
    const newIds=[],updatedIds=[];const now=this.now();
    for(const a of items){const id=newsIdentity(a);if(!id)continue;const content=newsContentRevision(a);
      if(this.initialized&&!this.seen.has(id))newIds.push(id);
      else if(this.previous.has(id)&&this.previous.get(id)!==content)updatedIds.push(id);
      this.seen.delete(id);this.seen.set(id,now);this.previous.set(id,content);
    }
    this.initialized=true;this.revision=revision||null;
    for(const [id,time] of this.seen)if(now-time>this.retentionMs||this.seen.size>this.maxSeen){this.seen.delete(id);this.previous.delete(id);}
    return {newIds,updatedIds};
  }
  baseline(){return [...this.seen.entries()];}
}
