import Database from "better-sqlite3";
import { cacheStatements } from "./statementCache.js";
import { randomUUID } from "node:crypto";
import { NewsArchive } from "../services/research/newsArchive.js";
import { AppError } from "../utils/error.js";
import { normalizeNewsFilters } from "../utils/stableHash.js";
import { createHash } from "node:crypto";
import { listVerifiedInstruments } from "../services/market/instrumentRegistry.js";
import { matchInstrument, resolveReferences } from "../services/research/instrumentIdentity.js";
import { readMeta, writeMeta, instrumentRow, sourceRow } from "./sqlRepositories.js";
import { normalizeArticles } from "../services/normalizeService.js";
import { classifyFinancialArticle, scoreFinancialImportance } from "../services/news/financialNewsService.js";
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const wireSize=data=>{const p={ok:true,queriedAt:new Date().toISOString(),origin:"OGID",data,warnings:data.warnings,truncated:false};return Buffer.byteLength(JSON.stringify({structuredContent:p,content:[{type:"text",text:JSON.stringify(p)}]}));};

export class SqlNewsArchive extends NewsArchive {
  constructor(db, options={}) {
    super({...options,persistencePath:null}); this.db=db;
    this.reader=new Database(db.name,{readonly:true});this.reader.pragma("query_only=ON");cacheStatements(this.reader);
    Object.assign(this,readMeta(db,"news.meta",{})); this.recoveryStatus=db.prepare("SELECT 1 FROM articles LIMIT 1").get()?"restored":"new";
    this.records={get:id=>this.getRecord(id),set:(_id,article)=>this.save(article),values:()=>this.values(),get size(){return db.prepare("SELECT count(*) AS n FROM articles").get().n;}};
    this.history={set:(_bucket,row)=>db.prepare("INSERT INTO news_context VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET observed_at=excluded.observed_at,payload_json=excluded.payload_json").run(row.bucket,row.observedAt,JSON.stringify(row)),values:()=>db.prepare("SELECT payload_json FROM news_context ORDER BY bucket").all().map(r=>JSON.parse(r.payload_json))};
    this.db.prepare("DELETE FROM news_query_snapshots").run();
    this.prune();
  }
  hydrate() {}
  close(){this.reader?.close();}
  getRecord(id){const row=this.db.prepare("SELECT payload_json FROM articles WHERE article_id=?").get(id);return row?JSON.parse(row.payload_json):undefined;}
  *values(){for(const row of this.db.prepare("SELECT payload_json FROM articles").iterate())yield JSON.parse(row.payload_json);}
  save(article){
    const previous=this.db.prepare("SELECT revision FROM articles WHERE article_id=?").get(article.id);
    if(previous?.revision===article.revision){
      this.db.prepare("UPDATE articles SET last_seen_at=?,payload_json=? WHERE article_id=?").run(article.archiveLastSeenAt,JSON.stringify(article),article.id);
      for(const alias of article.originalIds || [])this.db.prepare("INSERT OR IGNORE INTO article_aliases VALUES(?,?)").run(alias,article.id);return;
    }
    const policy=typeof article.usagePolicy==="string"?article.usagePolicy:article.usagePolicy?.contentPolicy || "headline-only-link-out";
    this.db.prepare("INSERT INTO articles VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET title=excluded.title,excerpt=excluded.excerpt,canonical_url=excluded.canonical_url,published_at=excluded.published_at,last_seen_at=excluded.last_seen_at,revision=excluded.revision,usage_policy=excluded.usage_policy,payload_json=excluded.payload_json").run(article.id,article.title,article.excerpt || null,article.url || null,article.publishedAt || null,article.receivedAt,article.archiveLastSeenAt,article.revision || 1,policy,JSON.stringify(article));
    for(const alias of article.originalIds || [])this.db.prepare("INSERT OR IGNORE INTO article_aliases VALUES(?,?)").run(alias,article.id);
    if(previous?.revision===article.revision)return;
    this.db.prepare("INSERT OR IGNORE INTO article_revisions VALUES(?,?,?,?)").run(article.id,article.revision || 1,article.archiveChangedAt || article.archiveLastSeenAt,JSON.stringify(article));
    for(const alias of article.originalIds || [])this.db.prepare("INSERT OR IGNORE INTO article_aliases VALUES(?,?)").run(alias,article.id);
    for(const table of ["article_instruments","article_countries","article_topics","article_sources"])this.db.prepare(`DELETE FROM ${table} WHERE article_id=?`).run(article.id);
    for(const i of listVerifiedInstruments()) {const reason=matchInstrument(article,i);if(reason){instrumentRow(this.db,i.instrumentId);this.db.prepare("INSERT INTO article_instruments VALUES(?,?,?)").run(article.id,i.instrumentId,JSON.stringify(reason));}}
    for(const country of article.countryMentions || [])this.db.prepare("INSERT OR IGNORE INTO article_countries VALUES(?,?)").run(article.id,country);
    for(const topic of article.topics || [])this.db.prepare("INSERT OR IGNORE INTO article_topics VALUES(?,?)").run(article.id,topic);
    for(const p of article.provenances || []) {const sid=p.sourceId || `publisher:${p.publisher || p.provider || "unknown"}`;sourceRow(this.db,sid,p);this.db.prepare("INSERT INTO article_sources VALUES(?,?,?,?) ON CONFLICT(article_id,source_id) DO UPDATE SET observed_at=excluded.observed_at,provenance_json=excluded.provenance_json").run(article.id,sid,article.archiveLastSeenAt,JSON.stringify(p));}
  }
  persist(){if(this.db)writeMeta(this.db,"news.meta",Object.fromEntries(["revision","startedAt","lastIngestAt","capacityPrunedAt"].map(k=>[k,this[k]])));}
  prune(){
    if(!this.db)return;
    const cutoff=new Date(this.now()-this.retentionDays*86400000).toISOString();
    this.db.transaction(()=>{
      for(const table of ["article_revisions","article_sources","article_aliases","article_instruments","article_countries","article_topics"])this.db.prepare(`DELETE FROM ${table} WHERE article_id IN (SELECT article_id FROM articles WHERE last_seen_at<?)`).run(cutoff);
      this.db.prepare("UPDATE evidence SET article_id=NULL WHERE article_id IN (SELECT article_id FROM articles WHERE last_seen_at<?)").run(cutoff);
      this.db.prepare("DELETE FROM articles WHERE last_seen_at<?").run(cutoff);
      this.db.prepare("DELETE FROM news_context WHERE observed_at<?").run(cutoff);
      this.db.prepare("DELETE FROM news_query_snapshots WHERE expires_at<=?").run(this.now());
    }).immediate();
  }
  ingest(values,options){
    // Preserve the existing classifiers' inputs at acquisition time without
    // storing restricted provider bodies. Old rows use permitted metadata until
    // their source is fetched again; no missing historical text is invented.
    const enriched=(values || []).map(raw=>{
      const normalized=normalizeArticles([raw],raw.provider)[0];
      if(!normalized)return raw;
      const classified=classifyFinancialArticle(normalized);
      classified.financial.importance=scoreFinancialImportance(normalized);
      return {...raw,countryMentions:[...new Set([...(raw.countryMentions || []),...normalized.countryMentions])],analysisFeatures:{methodVersion:"news-features-v1",sentiment:normalized.sentiment,conflict:normalized.conflict,financial:classified.financial}};
    });
    const before=Object.fromEntries(["revision","startedAt","lastIngestAt","capacityPrunedAt"].map(k=>[k,this[k]]));
    try{return this.db.transaction(()=>super.ingest(enriched,options)).immediate();}catch(error){Object.assign(this,readMeta(this.db,"news.meta",before));throw error;}
  }
  recordContext(snapshot){return this.db.transaction(()=>super.recordContext(snapshot)).immediate();}
  getHistory({from,to}={}){
    const predicates=[],args=[];
    for(const [value,operator]of [[from,">="],[to,"<="]])if(value){predicates.push(`observed_at${operator}?`);args.push(value);}
    return this.db.prepare(`SELECT payload_json FROM news_context ${predicates.length?`WHERE ${predicates.join(" AND ")}`:""} ORDER BY observed_at`).all(...args).map(row=>JSON.parse(row.payload_json));
  }
  coverage(filters={}){
    if(!this.db)return {};
    const s=this.db.prepare("SELECT count(*) AS totalStored,min(published_at) AS oldest,max(published_at) AS newest,min(received_at) AS oldestReceivedAt,max(received_at) AS newestReceivedAt,sum(published_at IS NULL) AS unknownPublicationCount FROM articles").get();
    const retainedSince=new Date(Math.max(Date.parse(this.startedAt),this.now()-this.retentionDays*86400000)).toISOString();
    return {...s,unknownPublicationCount:s.unknownPublicationCount || 0,retentionDays:this.retentionDays,startedAt:this.startedAt,retainedSince,lastIngestAt:this.lastIngestAt,requestedWindow:{from:filters.from || null,to:filters.to || null,timeField:filters.timeField || "publishedAt"},partial:!filters.from || Date.parse(filters.from)<Date.parse(retainedSince) || Boolean(this.capacityPrunedAt),acquisitionContinuity:"unknown",capacityPrunedAt:this.capacityPrunedAt,recoveryStatus:this.recoveryStatus,meaning:"collected permitted metadata; never all Internet news"};
  }
  getItem(id){const row=this.db.prepare("SELECT article_id FROM article_aliases WHERE alias=? LIMIT 1").get(id);const article=this.getRecord(id)||this.getRecord(row?.article_id || "");if(!article)throw new AppError("Artículo no disponible dentro de la retención del archivo.",404,"NEWS_ITEM_NOT_FOUND");return {article,coverage:this.coverage(),revision:this.revision,warnings:["No se devuelve texto completo; las fuentes duplicadas no son corroboraciones independientes."]};}
  cleanupSnapshots(){if(!this.db)return;this.db.prepare("DELETE FROM news_query_snapshots WHERE expires_at<=?").run(this.now());for(const [id,s]of this.snapshots)if(s.expiresAt<=this.now())this.snapshots.delete(id);}
  search(input={}){
    this.cleanupSnapshots();const {limit=20,maxBytes=262144,cursor,...rawFilters}=input,filters=normalizeNewsFilters(rawFilters);let id,offset=0,snapshot;
    if(cursor){({id,offset}=this.decodeCursor(cursor));snapshot=this.snapshots.get(id);if(Object.keys(rawFilters).length&&hash(filters)!==snapshot.filterHash)throw new AppError("Los filtros no pueden cambiar dentro de una revisión paginada.",400,"CURSOR_FILTER_MISMATCH");}
    else {
      const universe=listVerifiedInstruments(),resolutions=resolveReferences([...(filters.symbols || []),...(filters.instrumentIds || [])],{},universe);
      if(resolutions.some(r=>r.status!=="resolved"))throw new AppError("Identidad inexistente o ambigua.",400,"UNRESOLVED_INSTRUMENT");
      const instruments=resolutions.map(r=>universe.find(i=>i.instrumentId===r.instrumentId));
      const field=filters.timeField || "publishedAt",column={publishedAt:"published_at",receivedAt:"received_at",updatedAt:"json_extract(payload_json,'$.updatedAt')",archiveChangedAt:"json_extract(payload_json,'$.archiveChangedAt')"}[field];
      const predicates=[],args=[];for(const [bound,op]of [["from",">="],["to","<="]])if(filters[bound]){predicates.push(`${column}${op}?`);args.push(filters[bound]);}
      for(const [key,table,col]of [["countries","article_countries","country"],["topics","article_topics","topic"]])if(filters[key]?.length){predicates.push(`article_id IN (SELECT article_id FROM ${table} WHERE ${col} IN (${filters[key].map(()=>"?").join(",")}))`);args.push(...filters[key]);}
      while(this.snapshots.size>=this.maxSnapshots){const oldest=this.snapshots.keys().next().value;this.snapshots.delete(oldest);this.db.prepare("DELETE FROM news_query_snapshots WHERE snapshot_id=?").run(oldest);}
      id=randomUUID();snapshot={filterHash:hash(filters),revision:this.revision,expiresAt:this.now()+this.cursorTtlMs,coverage:this.coverage(filters),total:0,syntheticCount:0,staleCount:0};
      this.db.transaction(()=>{
        this.db.prepare("INSERT INTO news_query_snapshots VALUES(?,?,?,?,?,?,?,?)").run(id,snapshot.expiresAt,snapshot.filterHash,snapshot.revision,JSON.stringify(snapshot.coverage),0,0,0);
        const existing=this.db.prepare("SELECT coalesce(sum(total),0) AS n FROM news_query_snapshots").get().n;
        const sql=`SELECT payload_json FROM articles ${predicates.length?`WHERE ${predicates.join(" AND ")}`:""} ORDER BY coalesce(${column},received_at) DESC,article_id ASC`;
        for(const row of this.reader.prepare(sql).iterate(...args)){
          const article=JSON.parse(row.payload_json),reasons=[];
          if(filters.countries?.length)reasons.push(...article.countryMentions.filter(c=>filters.countries.includes(c)).map(c=>({kind:"country",method:"country-tag-or-detection",evidence:c})));
          if(instruments.length){const matches=instruments.map(i=>matchInstrument(article,i)).filter(Boolean);if(!matches.length)continue;reasons.push(...matches);}
          // JS matching preserves Unicode substring and the existing metadata semantics.
          if(filters.q&&!`${article.title} ${article.excerpt || ""}`.toLowerCase().includes(filters.q.toLowerCase()))continue;
          if(filters.sectors?.length&&!filters.sectors.some(s=>(article.sectors || []).includes(s)))continue;
          if(filters.providers?.length&&!article.provenances.some(p=>filters.providers.includes(p.provider)))continue;
          if(filters.sources?.length&&!article.provenances.some(p=>filters.sources.includes(p.sourceId)||filters.sources.includes(p.publisher)))continue;
          if(filters.q)reasons.push({kind:"text",method:"case-insensitive-text",evidence:filters.q});
          if(filters.topics?.length)reasons.push({kind:"topic",method:"collected-topic-tag",evidence:filters.topics.filter(t=>article.topics.includes(t)).join(", ")});
          if(existing+snapshot.total>=this.maxSnapshotItems)throw new AppError("Acotar la ventana de búsqueda.",413,"SNAPSHOT_TOO_LARGE");
          this.db.prepare("INSERT INTO news_query_items VALUES(?,?,?)").run(id,snapshot.total++,JSON.stringify({...article,matchReasons:reasons}));
          if(article.synthetic || article.dataMode==="synthetic")snapshot.syntheticCount++;if(article.dataMode==="stale" || article.provenance?.stale)snapshot.staleCount++;
        }
        this.db.prepare("UPDATE news_query_snapshots SET total=?,synthetic_count=?,stale_count=? WHERE snapshot_id=?").run(snapshot.total,snapshot.syntheticCount,snapshot.staleCount,id);
      }).immediate();this.snapshots.set(id,snapshot);
    }
    if(offset>snapshot.total)throw new AppError("Cursor fuera del resultado.",400,"INVALID_CURSOR");
    const data={articles:[],total:snapshot.total,hasMore:false,nextCursor:null,revision:snapshot.revision,snapshotId:id,cursorExpiresAt:new Date(snapshot.expiresAt).toISOString(),coverage:snapshot.coverage,quality:{syntheticCount:snapshot.syntheticCount,staleCount:snapshot.staleCount},warnings:["Archivo de metadata y extractos autorizados; no es cobertura completa de Internet.","La fecha de publicación desconocida queda fuera de ventanas publishedAt; consultar receivedAt de forma explícita.",...(snapshot.coverage.partial?["La cobertura solicitada es parcial por activación, retención o capacidad."]:[])]};
    for(const row of this.db.prepare("SELECT payload_json FROM news_query_items WHERE snapshot_id=? AND position>=? ORDER BY position LIMIT ?").iterate(id,offset,limit)){
      data.articles.push(JSON.parse(row.payload_json));const next=offset+data.articles.length;data.hasMore=next<snapshot.total;data.nextCursor=data.hasMore?this.cursor(id,next):null;
      if(wireSize(data)>maxBytes-512){data.articles.pop();break;}
    }
    const next=offset+data.articles.length;data.hasMore=next<snapshot.total;data.nextCursor=data.hasMore?this.cursor(id,next):null;
    if(!data.articles.length&&data.hasMore)throw new AppError("Un artículo no cabe en el presupuesto de salida.",413,"NEWS_ITEM_TOO_LARGE");if(wireSize(data)>maxBytes-512)throw new AppError("Metadata excede presupuesto.",413,"OUTPUT_TOO_LARGE");return data;
  }
}
